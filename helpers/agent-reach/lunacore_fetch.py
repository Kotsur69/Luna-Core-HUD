# -*- coding: utf-8 -*-
"""LunaCore News bridge over the vendored Agent-Reach package.

Agent-Reach (MIT, ./agent_reach, upstream commit 94f06c1) routes each platform
to an upstream tool and ships the recipes for using them. This bridge runs
those recipes for LunaCore's Mission Control News tab and prints JSON - it
never summarises (Haiku does that in the main process). X and Reddit ride
the user's own login, pasted once into the tools' own config through the
`configure` console; every other platform is public and cookie-free.

    python -I -X utf8 lunacore_fetch.py status
    python -I -X utf8 lunacore_fetch.py fetch   < {"items": [...]}
    python -I -X utf8 lunacore_fetch.py configure x|reddit   (interactive)

Item: {"id", "kind": "source"|"topic", "platform", "target" | "query"}.
Out:  {"items": [{"id", "ok": true, "entries": [...]} | {"id", "ok": false, "error"}]}.

Every URL that comes from the request goes through Agent-Reach's own guards
(normalize_public_http_url / host_matches) before anything is fetched.
Everything fetched is untrusted text: it is capped and stripped of markup
here, and main treats it as data in the prompt.
"""

from __future__ import annotations

import concurrent.futures
import datetime
import getpass
import html
import http.cookiejar
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import urllib.request

# -I keeps the script directory off sys.path; add the vendored package root
# (this file's own, shipped folder) explicitly and nothing else.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import agent_reach  # noqa: E402
from agent_reach.channels.web import WebChannel  # noqa: E402
from agent_reach.utils.url import host_matches, normalize_public_http_url  # noqa: E402

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
TIMEOUT = 20
MAX_BYTES = 5 * 1024 * 1024
MAX_ENTRIES = 8
YT_DETAIL = 3  # videos per channel whose description is read (one request each)
TITLE_MAX = 300
TEXT_MAX = 1200
WEB_TEXT_MAX = 6000
ITEM_TIMEOUT = 90
WORKERS = 4

TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")
REPO_RE = re.compile(r"^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$")
YT_PATH_RE = re.compile(r"^/(@[\w.-]+|channel/[\w-]+|c/[\w.-]+|user/[\w.-]+)(/videos)?$")


class FetchError(Exception):
    """A failure with a short code the UI can translate."""


def clean(text, limit):
    """Markup-free, whitespace-collapsed, capped text."""
    text = html.unescape(TAG_RE.sub(" ", str(text or "")))
    return SPACE_RE.sub(" ", text).strip()[:limit]


def entry(title, url, text="", published=None):
    try:
        safe_url = normalize_public_http_url(url)
    except ValueError:
        return None
    return {
        "title": clean(title, TITLE_MAX) or "(no title)",
        "url": safe_url,
        "text": clean(text, TEXT_MAX),
        "published": clean(published, 40) or None,
    }


def public_url(url):
    """Agent-Reach's textual guard plus a DNS check: every address the host
    resolves to must be globally routable (no 127.x via nip.io, no 169.254.x)."""
    safe = normalize_public_http_url(url)
    parts = urllib.parse.urlsplit(safe)
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except OSError as err:
        raise FetchError("fetch-failed") from err
    if not infos or not all(ipaddress.ip_address(info[4][0].split("%")[0]).is_global for info in infos):
        raise FetchError("bad-target")
    return safe


class _PublicRedirects(urllib.request.HTTPRedirectHandler):
    """Re-runs the public-host guard on every redirect hop."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        public_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_get(url, opener=None, headers=None):
    url = public_url(url)
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with (opener or urllib.request.build_opener(_PublicRedirects)).open(req, timeout=TIMEOUT) as resp:
        body = resp.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise FetchError("too-large")
    return body


# ---- RSS / Atom (Agent-Reach rss channel: feedparser) ----------------------


def read_feed(url):
    import feedparser

    feed = feedparser.parse(http_get(normalize_public_http_url(url)))
    if feed.bozo and not feed.entries:
        raise FetchError("not-a-feed")
    out = []
    for e in feed.entries[:MAX_ENTRIES]:
        item = entry(e.get("title"), e.get("link"), e.get("summary"), e.get("published") or e.get("updated"))
        if item:
            out.append(item)
    return out


# ---- YouTube (Agent-Reach youtube channel: yt-dlp) -------------------------


def _ydl(extra):
    import yt_dlp

    opts = {"quiet": True, "no_warnings": True, "skip_download": True, "socket_timeout": TIMEOUT}
    opts.update(extra)
    return yt_dlp.YoutubeDL(opts)


def youtube_channel(url):
    if not host_matches(url, "youtube.com"):
        raise FetchError("bad-target")
    path = urllib.parse.urlsplit(normalize_public_http_url(url)).path.rstrip("/")
    if not YT_PATH_RE.match(path):
        raise FetchError("bad-target")
    if not path.endswith("/videos"):
        path += "/videos"
    with _ydl({"extract_flat": True, "playlistend": MAX_ENTRIES}) as ydl:
        listing = ydl.extract_info(f"https://www.youtube.com{path}", download=False)
    out = []
    with _ydl({}) as ydl:
        for i, e in enumerate((listing or {}).get("entries") or []):
            video_url = e.get("url") or ""
            text, published = "", None
            # Only ever hand yt-dlp a YouTube address, whatever the listing says.
            if i < YT_DETAIL and host_matches(video_url, "youtube.com", "youtu.be"):
                try:
                    info = ydl.extract_info(video_url, download=False) or {}
                    text, published = info.get("description"), info.get("upload_date")
                except Exception as err:  # one unreadable video must not sink the channel
                    print(f"[lunacore_fetch] video {video_url}: {err}", file=sys.stderr)
            item = entry(e.get("title"), video_url, text, published)
            if item:
                out.append(item)
    return out


def youtube_search(query):
    with _ydl({"extract_flat": True}) as ydl:
        found = ydl.extract_info(f"ytsearch{MAX_ENTRIES}:{query}", download=False)
    out = []
    for e in (found or {}).get("entries") or []:
        text = f"{e.get('channel') or ''} - {e.get('description') or ''}"
        item = entry(e.get("title"), e.get("url"), text)
        if item:
            out.append(item)
    return out


# ---- Web page (Agent-Reach web channel: Jina Reader) -----------------------


def web_page(url):
    # Jina Reader fetches server-side; the DNS check still refuses private targets.
    safe = public_url(url)
    markdown = WebChannel().read(safe)
    title_match = re.search(r"^Title:\s*(.+)$", markdown, re.MULTILINE)
    body = markdown.split("Markdown Content:", 1)[-1]
    return [
        {
            "title": clean(title_match.group(1) if title_match else safe, TITLE_MAX),
            "url": safe,
            "text": SPACE_RE.sub(" ", body).strip()[:WEB_TEXT_MAX],
            "published": None,
        }
    ]


# ---- GitHub (Agent-Reach github channel: gh CLI; public atom feeds) --------


def github_repo(repo):
    if not REPO_RE.match(repo or ""):
        raise FetchError("bad-target")
    out = []
    for kind in ("releases", "commits"):
        try:
            out.extend(read_feed(f"https://github.com/{repo}/{kind}.atom")[:4])
        except FetchError:
            continue
    if not out:
        raise FetchError("fetch-failed")
    return out


def github_search(query):
    gh = shutil.which("gh")
    if not gh:
        raise FetchError("gh-missing")
    run = subprocess.run(
        [gh, "search", "repos", "--sort", "updated", "--stars", ">20", "--limit", str(MAX_ENTRIES),
         "--json", "fullName,description,url,stargazersCount,updatedAt", "--", query],
        capture_output=True, text=True, encoding="utf8", timeout=TIMEOUT,
    )
    if run.returncode != 0:
        raise FetchError("fetch-failed")
    out = []
    for r in json.loads(run.stdout or "[]"):
        text = f"{r.get('stargazersCount', 0)} stars - {r.get('description') or ''}"
        item = entry(r.get("fullName"), r.get("url"), text, r.get("updatedAt"))
        if item:
            out.append(item)
    return out


# ---- Bilibili (Agent-Reach bilibili channel: public search API) ------------


def bilibili_search(query):
    # The search API answers 412 without the anonymous buvid3 session cookie the
    # home page hands out; no login, nothing persisted.
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), _PublicRedirects)
    referer = {"Referer": "https://www.bilibili.com/"}
    http_get("https://www.bilibili.com/", opener, referer)
    q = urllib.parse.quote(query)
    api = f"https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={q}&page=1"
    data = json.loads(http_get(api, opener, referer))
    if data.get("code") != 0:
        raise FetchError("blocked")
    out = []
    for v in (data.get("data") or {}).get("result") or []:
        bvid = str(v.get("bvid") or "")
        if not re.match(r"^BV[0-9A-Za-z]+$", bvid):
            continue
        text = f"{v.get('author') or ''} - {v.get('description') or ''}"
        item = entry(v.get("title"), f"https://www.bilibili.com/video/{bvid}", text, str(v.get("pubdate") or ""))
        if item:
            out.append(item)
        if len(out) >= MAX_ENTRIES:
            break
    return out


# ---- Hacker News (Agent-Reach rss channel over hnrss.org) ------------------


def hackernews_search(query):
    return read_feed(f"https://hnrss.org/newest?q={urllib.parse.quote(query)}&count={MAX_ENTRIES}")


# ---- X and Reddit (Agent-Reach twitter / reddit channels: twitter-cli, rdt-cli)
#
# Both CLIs live in this venv (requirements-social.txt). Their logins are the
# user's own, pasted once in a console (`configure x|reddit` below) into the
# tools' own config: Agent-Reach's config.yaml for the X pair, rdt-cli's
# credential.json for Reddit. LunaCore's Node side never sees a cookie; this
# bridge hands the X pair to the `twitter` child as env, nothing else.
# One request at a time per platform: the accounts are Mati's main ones.

SOCIAL_ENTRIES = 25
SOCIAL_TIMEOUT = 30
SOCIAL_TEXT_MAX = 600
# X / Reddit items per scan: they run one at a time, so this bounds the scan time.
MAX_SOCIAL_ITEMS = 12
HANDLE_RE = re.compile(r"[A-Za-z0-9_]{1,15}")
SUBREDDIT_RE = re.compile(r"[A-Za-z0-9_]{2,21}")
TWEET_ID_RE = re.compile(r"[0-9]{1,25}")
PERMALINK_RE = re.compile(r"/r/[A-Za-z0-9_]{2,21}/comments/[A-Za-z0-9]{1,12}(/[A-Za-z0-9_%-]{0,300})?/?")
REDDIT_COOKIES = ("reddit_session", "token_v2")
SOCIAL_LOCKS = {"twitter": threading.Lock(), "reddit": threading.Lock()}

# Both CLIs fall back to reading *other browsers'* cookie stores when the saved
# login is missing, rejected or (rdt) older than 7 days - rdt even via
# `uv run --with browser-cookie3` and then overwrites its credential file.
# The login must only ever be the one the user pasted, so each CLI runs
# through this shim that stubs the fallback before handing over to click.
SHIMS = {
    "twitter": (
        "import twitter_cli.auth as a\n"
        "a.extract_from_browser = lambda *k, **kw: (None, ['browser fallback disabled by LunaCore'])\n"
        "from twitter_cli.cli import cli\n"
        "cli(prog_name='twitter')"
    ),
    "reddit": (
        "import rdt_cli.auth as a\n"
        "a.extract_browser_credential = lambda *k, **kw: None\n"
        "from rdt_cli.cli import cli\n"
        "cli(prog_name='rdt')"
    ),
}
SOCIAL_MODULES = {"twitter": "twitter_cli", "reddit": "rdt_cli"}


def module_installed(name):
    import importlib.util

    return importlib.util.find_spec(name) is not None


def isolated_appdata():
    """An empty profile root for the CLI child: no browser profile to find even if a stub is missed."""
    path = os.path.join(tempfile.gettempdir(), "lunacore-social-appdata")
    os.makedirs(path, exist_ok=True)
    return path


def x_credentials():
    """The X pair from Agent-Reach's config as child env, or {} when not set up."""
    from agent_reach.channels.twitter import twitter_cli_child_env
    from agent_reach.config import Config

    try:
        env = twitter_cli_child_env(Config(read_only=True))
    except Exception as err:  # unreadable / unsafe config = not set up
        print(f"[lunacore_fetch] agent-reach config: {type(err).__name__}", file=sys.stderr)
        return {}
    return env if env.get("TWITTER_AUTH_TOKEN") and env.get("TWITTER_CT0") else {}


def reddit_credential_file():
    return os.path.join(os.path.expanduser("~"), ".config", "rdt-cli", "credential.json")


def reddit_configured():
    path = reddit_credential_file()
    # A planted symlink / junction is "not set up", never followed.
    if os.path.islink(path) or os.path.islink(os.path.dirname(path)):
        return False
    try:
        with open(path, encoding="utf8") as fh:
            data = json.loads(fh.read(64 * 1024))
        return bool(isinstance(data, dict) and isinstance(data.get("cookies"), dict) and data["cookies"].get("reddit_session"))
    except (OSError, ValueError):
        return False


def social_error(platform, code):
    """CLI error code -> a short code the UI translates."""
    code = str(code or "").lower()
    if any(k in code for k in ("auth", "forbidden", "unauthor", "login", "cookie", "credential")):
        return f"{platform}-auth"
    if "rate" in code or "429" in code:
        return "rate-limited"
    if "not_found" in code or "not found" in code:
        return "not-found"
    return "fetch-failed"


def run_social(platform, args, extra_env=None):
    """Runs a social CLI (through its shim) with --json and returns its `data` list."""
    if not module_installed(SOCIAL_MODULES[platform]):
        raise FetchError("social-missing")
    appdata = isolated_appdata()
    env = {
        **os.environ, "PYTHONUTF8": "1", "UV_OFFLINE": "1",
        "APPDATA": appdata, "LOCALAPPDATA": appdata, **(extra_env or {}),
    }
    with SOCIAL_LOCKS[platform]:
        run = subprocess.run(
            [sys.executable, "-I", "-B", "-c", SHIMS[platform], *args],
            capture_output=True, text=True, encoding="utf8", errors="replace",
            timeout=SOCIAL_TIMEOUT, env=env, cwd=tempfile.gettempdir(),
        )
    try:
        payload = json.loads(run.stdout or "null")
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        # Never echo the CLI's stderr: a traceback tail could carry request headers.
        print(f"[lunacore_fetch] {platform} cli exit {run.returncode}, no JSON", file=sys.stderr)
        raise FetchError("fetch-failed")
    if payload.get("ok") is not True:
        err = payload.get("error") or {}
        code = clean(err.get("code") if isinstance(err, dict) else err, 40)
        print(f"[lunacore_fetch] {platform} cli error: {code}", file=sys.stderr)
        raise FetchError(social_error(platform, code))
    data = payload.get("data")
    return data if isinstance(data, list) else []


def tweet_entries(tweets):
    out = []
    for t in tweets[:SOCIAL_ENTRIES]:
        if not isinstance(t, dict):
            continue
        author = t.get("author") if isinstance(t.get("author"), dict) else {}
        handle, tweet_id = str(author.get("screenName") or ""), str(t.get("id") or "")
        if not HANDLE_RE.fullmatch(handle) or not TWEET_ID_RE.fullmatch(tweet_id):
            continue
        metrics = t.get("metrics") if isinstance(t.get("metrics"), dict) else {}
        text = clean(t.get("text"), SOCIAL_TEXT_MAX)
        likes = metrics.get("likes") if isinstance(metrics.get("likes"), int) else 0
        item = entry(f"@{handle}: {text[:140]}", f"https://x.com/{handle}/status/{tweet_id}",
                     f"{likes} likes - {text}", t.get("createdAtISO") or t.get("createdAt"))
        if item:
            out.append(item)
    return out


def x_run(args):
    creds = x_credentials()
    if not creds:
        raise FetchError("x-not-setup")
    return tweet_entries(run_social("twitter", args, creds))


def x_search(query):
    return x_run(["search", "-t", "top", "-n", str(SOCIAL_ENTRIES), "--json", "--", query])


def x_account(handle):
    handle = handle.lstrip("@")
    if not HANDLE_RE.fullmatch(handle):
        raise FetchError("bad-target")
    return x_run(["user-posts", "-n", str(SOCIAL_ENTRIES), "--json", "--", handle])


def post_entries(posts):
    out = []
    for p in posts[:SOCIAL_ENTRIES]:
        if not isinstance(p, dict) or p.get("stickied") is True:
            continue
        permalink = str(p.get("permalink") or "")
        if not PERMALINK_RE.fullmatch(permalink):
            continue
        created = p.get("created_utc")
        published = None
        if isinstance(created, (int, float)) and created > 0:
            published = datetime.datetime.fromtimestamp(created, datetime.timezone.utc).strftime("%Y-%m-%d %H:%M")
        score = p.get("score") if isinstance(p.get("score"), int) else 0
        comments = p.get("num_comments") if isinstance(p.get("num_comments"), int) else 0
        sub = clean(p.get("subreddit"), 30)
        text = f"r/{sub} - {score} points - {comments} comments - {clean(p.get('selftext'), SOCIAL_TEXT_MAX)}"
        item = entry(p.get("title"), f"https://www.reddit.com{permalink}", text, published)
        if item:
            out.append(item)
    return out


def reddit_run(args):
    if not reddit_configured():
        raise FetchError("reddit-not-setup")
    return post_entries(run_social("reddit", args))


def reddit_search(query):
    return reddit_run(["search", "-s", "top", "-t", "week", "-n", str(SOCIAL_ENTRIES), "--compact", "--json", "--", query])


def reddit_sub(name):
    name = re.sub(r"^/?r/", "", name.strip(), flags=re.IGNORECASE)
    if not SUBREDDIT_RE.fullmatch(name):
        raise FetchError("bad-target")
    return reddit_run(["sub", "-s", "hot", "-n", str(SOCIAL_ENTRIES), "--compact", "--json", "--", name])


SOURCES = {
    "rss": read_feed, "youtube": youtube_channel, "web": web_page, "github": github_repo,
    "twitter": x_account, "reddit": reddit_sub,
}
TOPICS = {
    "youtube": youtube_search, "github": github_search, "bilibili": bilibili_search, "hackernews": hackernews_search,
    "twitter": x_search, "reddit": reddit_search,
}


def run_item(item):
    kind, platform = item.get("kind"), item.get("platform")
    table = SOURCES if kind == "source" else TOPICS if kind == "topic" else {}
    handler = table.get(platform)
    arg = item.get("target") if kind == "source" else item.get("query")
    if not handler or not isinstance(arg, str) or not arg.strip() or len(arg) > 500:
        raise FetchError("bad-target")
    # A leading "-" would read as a flag to the CLIs behind some platforms.
    if kind == "topic" and arg.strip().startswith("-"):
        raise FetchError("bad-target")
    return handler(arg.strip())


def classify(err):
    if isinstance(err, FetchError):
        return str(err)
    if isinstance(err, ValueError) and "public HTTP" in str(err):
        return "bad-target"
    if isinstance(err, ImportError):
        return "missing-module"
    if isinstance(err, (TimeoutError, subprocess.TimeoutExpired, concurrent.futures.TimeoutError)):
        return "timeout"
    return "fetch-failed"


def fetch(request):
    items = [i for i in (request.get("items") or []) if isinstance(i, dict)][:40]
    # X / Reddit run one at a time; past the cap they are refused, not queued.
    over = [i for i in items if i.get("platform") in SOCIAL_LOCKS][MAX_SOCIAL_ITEMS:]
    results_over = [{"id": str(i.get("id") or ""), "ok": False, "error": "too-many"} for i in over]
    items = [i for i in items if not any(i is o for o in over)]
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [(pool.submit(run_item, i), str(i.get("id") or "")) for i in items]
        for fut, item_id in futures:
            try:
                results.append({"id": item_id, "ok": True, "entries": fut.result(timeout=ITEM_TIMEOUT)})
            except Exception as err:  # reported per item, never fatal for the batch
                print(f"[lunacore_fetch] {item_id}: {type(err).__name__}: {err}", file=sys.stderr)
                results.append({"id": item_id, "ok": False, "error": classify(err)})
    return {"items": results + results_over}


def status():
    def importable(name):
        try:
            __import__(name)
            return True
        except Exception:
            return False

    return {
        "agentReach": agent_reach.__version__,
        "python": sys.version.split()[0],
        "modules": {"yt_dlp": importable("yt_dlp"), "feedparser": importable("feedparser")},
        "gh": bool(shutil.which("gh")),
        # Booleans only: whether a login is saved, never what it is.
        "social": {
            "twitterCli": module_installed("twitter_cli"),
            "rdtCli": module_installed("rdt_cli"),
            "x": bool(x_credentials()),
            "reddit": reddit_configured(),
        },
    }


# ---- configure: an interactive console the user types into -----------------


def parse_cookie_header(value):
    """Cookie-Editor "Header String" ("a=1; b=2") -> {name: value}."""
    out = {}
    for part in value.replace("\n", ";").split(";"):
        name, sep, val = part.strip().partition("=")
        if sep and name and val:
            out[name.strip()] = val.strip()
    return out


GUIDE = {
    "x": (
        "Connect X for LunaCore News",
        "In Opera GX open x.com (logged in) -> Cookie-Editor icon -> Export -> Header String.",
    ),
    "reddit": (
        "Connect Reddit for LunaCore News",
        "In Opera GX open reddit.com (logged in) -> Cookie-Editor icon -> Export -> Header String.",
    ),
}


def configure_x(value):
    from agent_reach.config import Config

    cookies = parse_cookie_header(value)
    auth_token, ct0 = cookies.get("auth_token"), cookies.get("ct0")
    if not auth_token or not ct0:
        parts = value.split()
        auth_token, ct0 = (parts[0], parts[1]) if len(parts) == 2 and "=" not in value else (None, None)
    if not auth_token or not ct0:
        return "auth_token and ct0 not found in what you pasted."
    config = Config()
    config.set("twitter_auth_token", auth_token)
    config.set("twitter_ct0", ct0)
    return None


def configure_reddit(value):
    from rdt_cli.auth import Credential, save_credential

    cookies = parse_cookie_header(value)
    from agent_reach.utils.paths import ensure_no_symlink_path

    keep = {k: cookies[k] for k in REDDIT_COOKIES if cookies.get(k)}
    if not keep.get("reddit_session"):
        return "reddit_session not found in what you pasted."
    # rdt-cli's writer follows symlinks; refuse a planted one before it writes.
    ensure_no_symlink_path(reddit_credential_file(), "credential.json")  # every path component
    save_credential(Credential(keep, source="cookie-editor"))
    return None


def configure(platform):
    """Hidden prompt -> the tool's own config, then one tiny live check."""
    if platform not in GUIDE:
        print("usage: lunacore_fetch.py configure x|reddit", file=sys.stderr)
        sys.exit(2)
    title, how = GUIDE[platform]
    print(f"{title}\n\n{how}\nPaste it below (input stays hidden) and press Enter.\n")
    try:
        value = getpass.getpass("Cookies: ").strip()
    except (EOFError, KeyboardInterrupt):
        value = ""
    try:
        problem = "Nothing pasted." if not value else (configure_x if platform == "x" else configure_reddit)(value)
    except Exception as err:  # disk / permission / unsafe path - never echo the value
        problem = f"Could not save ({type(err).__name__})."
    if problem:
        print(f"\n[X] {problem} Nothing was saved.")
    else:
        print("\nSaved. Checking it works (one small request)...")
        try:
            check = x_search("anthropic") if platform == "x" else reddit_sub("ClaudeAI")
            print(f"[OK] Got {len(check)} posts. You can close this window and scan in LunaCore.")
        except Exception as err:
            print(f"[!] Saved, but the check failed: {classify(err)}. Try again with fresh cookies.")
    input("\nPress Enter to close.")


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "status":
        out = status()
    elif command == "fetch":
        out = fetch(json.loads(sys.stdin.read() or "{}"))
    elif command == "configure":
        configure(sys.argv[2] if len(sys.argv) > 2 else "")
        return
    else:
        print("usage: lunacore_fetch.py status|fetch|configure x|reddit", file=sys.stderr)
        sys.exit(2)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
