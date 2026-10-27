// ============================================================================
// LunaCore - in-process Electron wrapper for the Playtester (LW 3.35)
// ----------------------------------------------------------------------------
// The smoke-test technique from DONE_MISSION_CONTROL_ROADMAP.md ("CDP debug
// ports were unusable ... smoke-test with an in-process wrapper"), packaged
// for Luna's Work: no remote-debugging port, the app is driven from inside its
// own main process with sendInputEvent / executeJavaScript / capturePage
// (invalidate() + a short wait first, or the frame is stale).
//
// How it gets in: the electron adapter starts the profile's command with
// NODE_OPTIONS=--require <this file>. Every Node process of that command
// loads it (npm, npx, the electron CLI shim...), but it only acts in an
// Electron *main* process that was handed LUNA_PLAYTEST_TOKEN - everywhere
// else it is a no-op. The app then boots exactly as it would on its own
// (its own app path, userData, single-instance lock).
//
// Once the first window has loaded it serves control.js on 127.0.0.1:<random>
// and prints one line the adapter waits for:
//
//   [luna-playtest] ready {"port":51234,"windows":1}
//
// The driver offers only the narrow tool set of tools.js (re-validated here)
// plus `quit` for the adapter. The page scripts it runs are fixed; the
// model's selector / name / text reach them only as JSON string literals.
// ============================================================================

'use strict';

const { createControlServer, TOKEN_ENV, READY_PREFIX } = require('./control');
const { checkArgs, MAX_TEXT_CHARS } = require('./tools');

const MAX_ERRORS = 200;
const MAX_ERROR_CHARS = 1000;
const MAX_READ_CHARS = 20000;
const MAX_MENU_ITEMS = 300;
const CAPTURE_SETTLE_MS = 150;
const INPUT_SETTLE_MS = 100;
const WAIT_POLL_MS = 250;
const WINDOW_POLL_MS = 200;

const errText = (err) => (err instanceof Error ? err.message : String(err));
const realDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const norm = (s) => String(s || '').replace(/&/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Developer tools would show the app's source and run code: never for the Playtester.
const DEVTOOLS_LABEL_RE = /dev(?:eloper)?\s*tools|inspect\s+element/i;
const offLimits = (item) => norm(item.role) === 'toggledevtools' || DEVTOOLS_LABEL_RE.test(String(item.label || ''));

// ---- page scripts -------------------------------------------------------------------

// Shared by both scripts: visibility and an accessible-name approximation.
const PAGE_HELPERS = `
  const norm = (s) => String(s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' ');
      if (norm(t)) return norm(t);
    }
    if (el.labels && el.labels.length) return norm([...el.labels].map((l) => l.innerText).join(' '));
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) return norm(el.value);
    const text = norm(el.innerText);
    if (text) return text;
    return norm(el.getAttribute('title') || el.getAttribute('alt') || el.getAttribute('placeholder') || '');
  };`;

const INTERACTIVE = 'button, a[href], input, select, textarea, summary, option, [role=button], [role=link], [role=menuitem], [role=tab], [role=checkbox], [role=radio], [role=switch], [onclick], [tabindex]';
const CANDIDATES = `${INTERACTIVE}, label, [role], [aria-label], [title], [alt], [placeholder], h1, h2, h3, h4, h5, h6, li, td, th, p, span, div`;

/** Finds the element, scrolls it into view, returns its centre in window coordinates. */
function locateScript(selector, name) {
  return `(() => {
    ${PAGE_HELPERS}
    const sel = ${JSON.stringify(selector || null)};
    const want = ${JSON.stringify(name ? norm(name) : null)};
    let el = null;
    if (sel) {
      try { el = document.querySelector(sel); } catch (e) { return { error: 'bad selector' }; }
    } else {
      const all = [...document.querySelectorAll(${JSON.stringify(CANDIDATES)})].slice(0, 5000).filter(visible);
      const scored = all.map((e) => ({ e, n: nameOf(e), i: e.matches(${JSON.stringify(INTERACTIVE)}) }));
      const exact = scored.filter((s) => s.n === want);
      const near = scored.filter((s) => s.n.includes(want)).sort((a, b) => a.n.length - b.n.length);
      const best = exact.find((s) => s.i) || exact[0] || near.find((s) => s.i) || near[0];
      el = best ? best.e : null;
    }
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase(), label: nameOf(el).slice(0, 80) };
  })()`;
}

function readScript(selector) {
  return `(() => {
    const sel = ${JSON.stringify(selector || null)};
    let el;
    try { el = sel ? document.querySelector(sel) : document.body; } catch (e) { return { error: 'bad selector' }; }
    if (!el) return null;
    return { title: document.title, text: String(el.innerText || '').slice(0, ${MAX_READ_CHARS}) };
  })()`;
}

// ---- keys and menus -----------------------------------------------------------------

const KEY_ALIASES = { return: 'enter', esc: 'escape', plus: '+', minus: '-' };

/** Driver modifiers -> sendInputEvent modifiers. */
function inputModifiers(mods, platform) {
  const map = { shift: 'shift', control: 'control', ctrl: 'control', alt: 'alt', meta: 'meta', command: 'meta', cmd: 'meta' };
  return [...new Set((mods || []).map((m) => (m === 'cmdorctrl' ? (platform === 'darwin' ? 'meta' : 'control') : map[m])).filter(Boolean))];
}

/** "CmdOrCtrl+Shift+N" -> "control+shift|n" (modifiers sorted), or null. */
function comboKey(accelerator, platform) {
  if (typeof accelerator !== 'string' || !accelerator) return null;
  const parts = accelerator.split('+').map((p) => p.trim().toLowerCase());
  // "Ctrl+Plus" / "Ctrl++": the key is whatever follows the last separator.
  const key = accelerator.endsWith('++') ? '+' : parts.pop();
  const mods = parts.filter(Boolean).map((p) => {
    if (p === 'cmdorctrl' || p === 'commandorcontrol') return platform === 'darwin' ? 'meta' : 'control';
    if (p === 'ctrl' || p === 'control') return 'control';
    if (p === 'cmd' || p === 'command' || p === 'super' || p === 'meta') return 'meta';
    if (p === 'alt' || p === 'option' || p === 'altgr') return 'alt';
    return p;
  });
  return `${[...new Set(mods)].sort().join('+')}|${KEY_ALIASES[key] || key}`;
}

function* menuItems(menu, depth = 0) {
  if (!menu || !Array.isArray(menu.items) || depth > 8) return;
  for (const item of menu.items) {
    yield item;
    if (item.submenu) yield* menuItems(item.submenu, depth + 1);
  }
}

function describeMenu(menu, budget = { left: MAX_MENU_ITEMS }, depth = 0) {
  if (!menu || !Array.isArray(menu.items) || depth > 8) return [];
  const out = [];
  for (const item of menu.items) {
    if (budget.left <= 0) break;
    if (item.type === 'separator' || item.visible === false || offLimits(item)) continue;
    budget.left -= 1;
    out.push({
      label: String(item.label || item.role || '').replace(/&/g, ''),
      ...(item.accelerator ? { accelerator: String(item.accelerator) } : {}),
      enabled: item.enabled !== false,
      ...(item.type === 'checkbox' || item.type === 'radio' ? { checked: !!item.checked } : {}),
      ...(item.submenu ? { submenu: describeMenu(item.submenu, budget, depth + 1) } : {}),
    });
  }
  return out;
}

// ---- driver -------------------------------------------------------------------------

/**
 * The tools, over Electron's main-process API (injected, so the tests run on
 * fakes). Every Playtester tool is re-validated with tools.js.
 * @param {{app:object, BrowserWindow:object, Menu:object, platform?:string, delay?:Function, now?:Function}} electron
 */
function createDriver({ app, BrowserWindow, Menu, platform = process.platform, delay = realDelay, now = Date.now }) {
  const errors = [];

  function record(source, message) {
    errors.push({ at: now(), source, message: String(message).slice(0, MAX_ERROR_CHARS) });
    if (errors.length > MAX_ERRORS) errors.shift();
  }

  /** Error capture for one webContents: console errors, crashes, failed loads. */
  function attach(wc) {
    wc.on('console-message', (...a) => {
      // Electron 35+ passes one event with properties; older ones pass them positionally.
      const e = a[0] || {};
      const level = typeof e.level === 'string' ? e.level : a[1];
      if (level !== 'error' && level !== 3) return;
      const message = typeof e.message === 'string' ? e.message : a[2];
      const source = e.sourceId || a[4];
      const line = e.lineNumber || a[3];
      record('console', `${message}${source ? ` (${source}:${line})` : ''}`);
    });
    wc.on('render-process-gone', (_e, details) => record('crash', `renderer gone: ${details && details.reason}`));
    wc.on('preload-error', (_e, preloadPath, err) => record('preload', `${preloadPath}: ${errText(err)}`));
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame !== false) record('load', `${desc} (${code}) ${url}`);
    });
    // Whatever opened them (an app shortcut, a context menu): closed again at once.
    wc.on('devtools-opened', () => {
      wc.closeDevTools();
      record('guard', 'developer tools were opened and closed again');
    });
  }

  const liveWindows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());

  function pick(windowId) {
    const all = liveWindows();
    if (windowId !== undefined) {
      const w = all.find((x) => x.id === windowId);
      if (!w) throw new Error(`no window with id ${windowId}`);
      return w;
    }
    const focused = BrowserWindow.getFocusedWindow();
    const w = (focused && !focused.isDestroyed() && focused) || all.find((x) => x.isVisible()) || all[0];
    if (!w) throw new Error('the app has no open window');
    return w;
  }

  async function locate(wc, selector, name) {
    const hit = await wc.executeJavaScript(locateScript(selector, name), true);
    if (hit && hit.error) throw new Error(hit.error);
    if (!hit) throw new Error(`no visible element ${selector ? `matches '${selector}'` : `is named '${name}'`}`);
    return hit;
  }

  function sendKey(wc, keyCode, modifiers) {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    // A printable key also types its character, unless a shortcut modifier is held.
    if (keyCode.length === 1 && !modifiers.some((m) => m !== 'shift')) wc.sendInputEvent({ type: 'char', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  }

  async function readText(wc, selector) {
    const res = await wc.executeJavaScript(readScript(selector), true);
    if (res && res.error) throw new Error(res.error);
    if (!res) throw new Error(`no element matches '${selector}'`);
    return res;
  }

  const tools = {
    list_windows: () => ({
      windows: liveWindows().map((w) => ({
        id: w.id,
        title: w.getTitle(),
        bounds: w.getContentBounds(),
        focused: w.isFocused(),
        visible: w.isVisible(),
        minimized: w.isMinimized(),
      })),
    }),

    async screenshot({ windowId }) {
      const win = pick(windowId);
      if (win.isMinimized()) win.restore();
      win.webContents.invalidate();
      await delay(CAPTURE_SETTLE_MS);
      const image = await win.webContents.capturePage();
      if (!image || image.isEmpty()) throw new Error('the window shows nothing (hidden or minimized?)');
      const size = image.getSize();
      return { png: image.toPNG().toString('base64'), width: size.width, height: size.height, windowId: win.id };
    },

    async click({ selector, name, windowId }) {
      const win = pick(windowId);
      const wc = win.webContents;
      const hit = await locate(wc, selector, name);
      wc.focus();
      const at = { x: hit.x, y: hit.y };
      wc.sendInputEvent({ type: 'mouseMove', ...at });
      wc.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 });
      await delay(INPUT_SETTLE_MS);
      return { clicked: hit.label || hit.tag, ...at };
    },

    async type_text({ text, selector, name, submit, windowId }) {
      const win = pick(windowId);
      if (selector || name) await tools.click({ selector, name, windowId: win.id });
      const wc = win.webContents;
      wc.focus();
      if (text) wc.insertText(text.slice(0, MAX_TEXT_CHARS));
      if (submit) sendKey(wc, 'Enter', []);
      await delay(INPUT_SETTLE_MS);
      return { typed: text.length, submitted: !!submit };
    },

    async press_key({ key, modifiers, windowId }) {
      const win = pick(windowId);
      const mods = inputModifiers(modifiers, platform);
      // Synthetic input never reaches the menu bar: an accelerator is fired
      // through its menu item, the way a real key press would.
      const combo = comboKey([...mods, key].join('+'), platform);
      const item = [...menuItems(Menu.getApplicationMenu())].find(
        (i) => i.visible !== false && i.enabled !== false && comboKey(i.accelerator, platform) === combo,
      );
      if (item && offLimits(item)) throw new Error('developer tools are off limits');
      if (item) {
        item.click(undefined, win, win.webContents);
        await delay(INPUT_SETTLE_MS);
        return { menuItem: String(item.label || item.role || '').replace(/&/g, '') };
      }
      win.webContents.focus();
      sendKey(win.webContents, key, mods);
      await delay(INPUT_SETTLE_MS);
      return { pressed: [...mods, key].join('+') };
    },

    async resize_window({ width, height, windowId }) {
      const win = pick(windowId);
      if (win.isFullScreen()) win.setFullScreen(false);
      if (win.isMaximized()) win.unmaximize();
      win.setContentSize(width, height);
      await delay(INPUT_SETTLE_MS);
      return { windowId: win.id, bounds: win.getContentBounds() };
    },

    read_text: ({ selector, windowId }) => readText(pick(windowId).webContents, selector),

    console_errors: ({ clear }) => {
      const list = errors.slice();
      if (clear) errors.length = 0;
      return { errors: list };
    },

    async wait_for_text({ text, timeoutMs, windowId }) {
      const wc = pick(windowId).webContents;
      const want = norm(text);
      const deadline = now() + timeoutMs;
      for (;;) {
        const page = await readText(wc);
        if (norm(page.text).includes(want)) return { found: true };
        if (now() >= deadline) return { found: false };
        await delay(WAIT_POLL_MS);
      }
    },

    list_menu: () => ({ menu: describeMenu(Menu.getApplicationMenu()) }),

    async click_menu({ labels }) {
      let level = Menu.getApplicationMenu();
      let item = null;
      for (const label of labels) {
        const items = level && Array.isArray(level.items) ? level.items : [];
        item = items.find((i) => i.visible !== false && !offLimits(i) && norm(i.label || i.role) === norm(label));
        if (!item) throw new Error(`no menu item '${label}'`);
        level = item.submenu;
      }
      if (item.enabled === false) throw new Error(`menu item '${labels.join(' > ')}' is disabled`);
      if (item.submenu) throw new Error(`'${labels.join(' > ')}' is a submenu, not an item`);
      const win = pick();
      item.click(undefined, win, win.webContents);
      await delay(INPUT_SETTLE_MS);
      return { clicked: labels };
    },
  };

  /** The control server's handler: a Playtester tool (validated) or the adapter's quit. */
  async function call(tool, args) {
    if (tool === 'quit') {
      setImmediate(() => app.quit());
      return { quitting: true };
    }
    const checked = checkArgs('electron', tool, args);
    if (!checked.ok) throw new Error(checked.error);
    return tools[tool](checked.args);
  }

  return { attach, record, call, windowCount: () => liveWindows().length };
}

// ---- install ------------------------------------------------------------------------

/** Resolves once a window exists whose page has finished loading. */
function firstWindowLoaded(BrowserWindow) {
  return new Promise((resolve) => {
    let timer = null;
    const check = () => {
      const ready = BrowserWindow.getAllWindows().some(
        (w) => !w.isDestroyed() && !w.webContents.isLoading() && !!w.webContents.getURL(),
      );
      if (!ready) return;
      if (timer) clearInterval(timer);
      timer = null;
      resolve();
    };
    timer = setInterval(check, WINDOW_POLL_MS);
    check();
  });
}

/**
 * Hooks the driver into this Electron main process and serves it once the
 * first window has loaded.
 * @param {object} electron require('electron')
 * @param {{env?:object, out?:{write:Function}}} [io]
 * @returns {Promise<import('http').Server>}
 */
function install(electron, io = {}) {
  const env = io.env || process.env;
  const out = io.out || process.stdout;
  const token = env[TOKEN_ENV];
  // The app's own child processes must not inherit the key.
  delete env[TOKEN_ENV];
  const { app, BrowserWindow, Menu } = electron;
  const driver = createDriver({ app, BrowserWindow, Menu });
  app.on('web-contents-created', (_e, wc) => driver.attach(wc));
  process.on('uncaughtExceptionMonitor', (err) => driver.record('main', errText(err)));
  return app
    .whenReady()
    .then(() => firstWindowLoaded(BrowserWindow))
    .then(() => {
      const server = createControlServer({ token, handle: driver.call });
      server.listen(0, '127.0.0.1', () => {
        out.write(`${READY_PREFIX}${JSON.stringify({ port: server.address().port, windows: driver.windowCount() })}\n`);
      });
      app.on('will-quit', () => server.close());
      return server;
    });
}

if (process.versions.electron && process.type === 'browser' && process.env[TOKEN_ENV]) {
  try {
    install(require('electron')).catch((err) => process.stderr.write(`[luna-playtest] wrapper failed: ${errText(err)}\n`));
  } catch (err) {
    process.stderr.write(`[luna-playtest] wrapper failed: ${errText(err)}\n`);
  }
}

module.exports = {
  TOKEN_ENV,
  READY_PREFIX,
  createDriver,
  comboKey,
  locateScript,
  install,
};
