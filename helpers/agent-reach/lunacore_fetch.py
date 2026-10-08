# -*- coding: utf-8 -*-
"""LunaCore News bridge over the vendored Agent-Reach package.

Agent-Reach (MIT, ./agent_reach, upstream commit 94f06c1) routes each platform
to an upstream tool and ships the recipes for using them. This bridge runs
those recipes for LunaCore's Mission Control News tab and prints JSON - it
never summarises (Haiku does that in the main process) and never logs in:
v1 covers the public, cookie-free paths only.

    python -I -X utf8 lunacore_fetch.py status
    python -I -X utf8 lunacore_fetch.py fetch   < {"items": [...]}

Item: {"id", "kind": "source"|"topic", "platform", "target" | "query"}.
Out:  {"items": [{"id", "ok": true, "entries": [...]} | {"id", "ok": false, "error"}]}.

Every URL that comes from the request goes through Agent-Reach's own guards
(normalize_public_http_url / host_matches) before anything is fetched.
Everything fetched is untrusted text: it is capped and stripped of markup
here, and main treats it as data in the prompt.
"""

from __future__ import annotations

import concurrent.futures
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


SOURCES = {"rss": read_feed, "youtube": youtube_channel, "web": web_page, "github": github_repo}
TOPICS = {"youtube": youtube_search, "github": github_search, "bilibili": bilibili_search, "hackernews": hackernews_search}


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
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [(pool.submit(run_item, i), str(i.get("id") or "")) for i in items]
        for fut, item_id in futures:
            try:
                results.append({"id": item_id, "ok": True, "entries": fut.result(timeout=ITEM_TIMEOUT)})
            except Exception as err:  # reported per item, never fatal for the batch
                print(f"[lunacore_fetch] {item_id}: {type(err).__name__}: {err}", file=sys.stderr)
                results.append({"id": item_id, "ok": False, "error": classify(err)})
    return {"items": results}


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
    }


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "status":
        out = status()
    elif command == "fetch":
        out = fetch(json.loads(sys.stdin.read() or "{}"))
    else:
        print("usage: lunacore_fetch.py status|fetch", file=sys.stderr)
        sys.exit(2)
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
