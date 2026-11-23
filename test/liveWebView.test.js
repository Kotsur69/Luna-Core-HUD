// ============================================================================
// God Mode Live Web: the canvas component's lifecycle (liveWebView.js)
// ----------------------------------------------------------------------------
// With a minimal fake DOM: nothing runs before show(); show() takes the
// process snapshot and the model feed and paints at devicePixelRatio; the
// frame loop stops once the web is at rest; hide() cancels the pending frame
// and gives both feeds back; reduced motion settles and draws once, with no
// particles and no further frames; a tool event wakes the loop again.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Modules first: they read the DOM only when called.
const { createLiveWeb } = require('../src/renderer/modules/liveWebView.js');
const { shareModel, notifyModel } = require('../src/renderer/modules/workmapFeed.js');
const { createTabState } = require('../src/renderer/modules/workmapmodel.js');

// --- a minimal DOM ------------------------------------------------------------

function makeCtx(log) {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => log.push([prop, args]);
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.className = '';
    this.children = [];
    this.attrs = new Map();
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.textContent = '';
    this.listeners = {};
    this.scrollTop = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    this.width = 0;
    this.height = 0;
    this.ctxLog = [];
    const self = this;
    this.classList = {
      toggle(c, on) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        if (on === undefined ? !set.has(c) : on) set.add(c);
        else set.delete(c);
        self.className = [...set].join(' ');
      },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = kids; }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  focus() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  getContext() { return makeCtx(this.ctxLog); }
}

const env = { reduced: false, frames: new Map(), nextId: 1, cancelled: 0 };

function installDom() {
  const store = new Map();
  globalThis.window = {
    i18n: { t: (k) => k, lang: 'en' },
    devicePixelRatio: 2,
    matchMedia: () => ({ matches: env.reduced }),
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  };
  globalThis.document = { createElement: (tag) => new FakeEl(tag), documentElement: { dataset: {} }, activeElement: null };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame = (cb) => {
    const id = env.nextId++;
    env.frames.set(id, cb);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    if (env.frames.delete(id)) env.cancelled += 1;
  };
}

/** Runs queued frames (each may queue the next) until none is left or `max` ran. */
function flushFrames(max = 2000) {
  let ts = 0;
  let ran = 0;
  while (env.frames.size && ran < max) {
    const [id, cb] = env.frames.entries().next().value;
    env.frames.delete(id);
    ts += 16;
    cb(ts);
    ran += 1;
  }
  return ran;
}

function find(el, pred) {
  if (pred(el)) return el;
  for (const kid of el.children || []) {
    const hit = kid instanceof FakeEl ? find(kid, pred) : null;
    if (hit) return hit;
  }
  return null;
}

// --- feeds ----------------------------------------------------------------------

function fakeBridge() {
  const calls = { subscribed: 0, unsubscribed: 0, callback: null };
  return {
    calls,
    bridge: {
      subscribeSessionProcs(cb) {
        calls.subscribed += 1;
        calls.callback = cb;
        return () => {
          calls.unsubscribed += 1;
        };
      },
    },
  };
}

const VIEW = {
  packages: [
    { id: 'a', title: 'A', state: 'launched', sessionId: 's-a', dependsOn: [], touched: ['src/x.js'] },
    { id: 'b', title: 'B', state: 'launched', sessionId: 's-b', dependsOn: [], touched: ['src/x.js'] },
  ],
};

function modelWith(recent) {
  const tab = { ...createTabState(), recent };
  return { activeTab: null, tabs: new Map([['s-a', tab]]) };
}

function setup() {
  installDom();
  env.reduced = false;
  env.frames.clear();
  env.cancelled = 0;
  let state = modelWith([]);
  shareModel({ getState: () => state });
  const { bridge, calls } = fakeBridge();
  const web = createLiveWeb({ bridge, getView: () => VIEW, getRunLabel: () => 'repo' });
  const canvas = find(web.root, (el) => el.tagName === 'CANVAS');
  return { web, calls, canvas, setState: (next) => { state = next; } };
}

// --- tests ------------------------------------------------------------------------

test('nothing runs before show(); show() subscribes once and paints at devicePixelRatio', () => {
  const { web, calls, canvas } = setup();
  assert.equal(calls.subscribed, 0);
  assert.equal(env.frames.size, 0);
  web.show();
  web.show();
  assert.equal(calls.subscribed, 1, 'a second show does not subscribe twice');
  assert.equal(env.frames.size, 1);
  flushFrames();
  assert.equal(canvas.width, 1600, '800 css px at DPR 2');
  assert.equal(canvas.height, 1200);
  assert.ok(canvas.ctxLog.some(([m]) => m === 'arc'), 'nodes were drawn');
  // Labels go on the canvas as text, never as markup.
  const texts = canvas.ctxLog.filter(([m]) => m === 'fillText').map(([, args]) => args[0]);
  assert.ok(texts.includes('a') && texts.includes('b'), texts.join(','));
  assert.equal(canvas.getAttribute('aria-label'), 'lm.web.aria');
  web.hide();
});

test('the loop stops at rest; hide() cancels the frame and gives every feed back', () => {
  const { web, calls } = setup();
  web.show();
  const ran = flushFrames();
  assert.ok(ran > 1 && ran < 2000, `the loop ran ${ran} frames and stopped`);
  assert.equal(env.frames.size, 0, 'no frame queued once the web is at rest');
  // A model change wakes it; hide() then cancels that pending frame.
  notifyModel(modelWith([]));
  assert.equal(env.frames.size, 1);
  web.hide();
  assert.equal(env.cancelled, 1);
  assert.equal(env.frames.size, 0);
  assert.equal(calls.unsubscribed, 1);
  // Hidden: neither feed reaches it any more.
  notifyModel(modelWith([]));
  calls.callback({ at: 1, sessions: { 's-a': [{ pid: 5, name: 'node', label: 'node', ports: [] }] } });
  assert.equal(env.frames.size, 0);
  web.hide();
  assert.equal(calls.unsubscribed, 1, 'a second hide gives nothing back twice');
  web.destroy();
});

test('a tool event sends a particle: the settled web wakes and keeps animating', () => {
  const { web, setState } = setup();
  web.show();
  flushFrames();
  assert.equal(env.frames.size, 0);
  const next = modelWith([{ callId: 'c1', station: 'files', file: 'C:\\w\\.luna-worktrees\\r\\a\\src\\x.js', detail: '', status: 'running' }]);
  setState(next);
  notifyModel(next);
  assert.equal(env.frames.size, 1);
  // The particle lives PARTICLE_MS of real time; a burst of instant frames keeps the loop going.
  const ran = flushFrames(5);
  assert.equal(ran, 5);
  assert.equal(env.frames.size, 1, 'still animating the particle');
  web.hide();
  assert.equal(env.frames.size, 0);
});

test('reduced motion: settled at once, drawn still, no particles and no further frames', () => {
  const { web, canvas, setState } = setup();
  env.reduced = true;
  web.show();
  assert.equal(flushFrames(), 1, 'one frame draws the settled web');
  assert.ok(canvas.ctxLog.length > 0);
  const next = modelWith([{ callId: 'c1', station: 'files', file: 'src/x.js', detail: '', status: 'running' }]);
  setState(next);
  notifyModel(next);
  // The change is drawn (one frame), but nothing travels: no frame after it.
  assert.equal(flushFrames(), 1);
  assert.equal(env.frames.size, 0);
  web.hide();
});

test('the in-app motion axis turns motion off like the OS setting does', () => {
  const { web } = setup();
  document.documentElement.dataset.motion = 'off';
  web.show();
  assert.equal(flushFrames(), 1);
  web.hide();
  document.documentElement.dataset.motion = '';
});

test('layer filters: a toggle hides its layer and is remembered', () => {
  const { web } = setup();
  const files = find(web.root, (el) => el.className.includes('is-file') && el.tagName === 'BUTTON');
  assert.equal(files.getAttribute('aria-pressed'), 'true');
  files.listeners.click[0]();
  assert.equal(files.getAttribute('aria-pressed'), 'false');
  assert.equal(window.localStorage.getItem('lunacore.liveWeb.hidden'), 'file');
  const again = createLiveWeb({ getView: () => VIEW });
  const filesAgain = find(again.root, (el) => el.className.includes('is-file') && el.tagName === 'BUTTON');
  assert.equal(filesAgain.getAttribute('aria-pressed'), 'false');
});

test('a burst of pushes costs one rebuild, not one per push', async () => {
  installDom();
  env.reduced = false;
  env.frames.clear();
  shareModel({ getState: () => modelWith([]) });
  let reads = 0;
  const web = createLiveWeb({ getView: () => { reads += 1; return VIEW; } });
  web.show();
  flushFrames();
  const afterShow = reads;
  assert.ok(afterShow > 0);
  for (let i = 0; i < 10; i += 1) {
    notifyModel(modelWith([]));
    flushFrames();
  }
  assert.equal(reads, afterShow, 'pushes right after a rebuild wait for the throttle');
  // The owed rebuild comes on its own once the throttle window passed.
  await new Promise((resolve) => setTimeout(resolve, 320));
  flushFrames();
  assert.equal(reads, afterShow + 1);
  web.hide();
});

test('camera: fit, ease, zoom around a point and reveal are pure and finite', () => {
  const C = require('../src/renderer/modules/liveWebCamera.js');
  const size = { w: 800, h: 600 };
  const fit = C.fitCamera({ minX: -200, minY: -100, maxX: 200, maxY: 100 }, size);
  // The box's middle lands on the stage's middle.
  assert.deepEqual(C.toWorld(fit, 400, 300), { x: 0, y: 0 });
  assert.ok(fit.k <= C.FIT_MAX_ZOOM);
  // A tiny web is not blown up; a huge one is not shrunk past the zoom floor.
  assert.equal(C.fitCamera({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, size).k, C.FIT_MAX_ZOOM);
  assert.ok(C.fitCamera({ minX: -1e6, minY: -1e6, maxX: 1e6, maxY: 1e6 }, size).k > 0);
  assert.equal(C.fitCamera(null, size), null);
  assert.equal(C.fitCamera({ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { w: 0, h: 600 }), null);
  const start = { x: 0, y: 0, k: 1 };
  const half = C.easeCamera(start, fit, 0.5);
  assert.equal(half.moving, true);
  assert.deepEqual(C.easeCamera(start, fit, 1), { cam: fit, moving: false });
  assert.deepEqual(C.easeCamera(start, fit, NaN).cam, fit);
  // Zooming keeps the point under the pointer still, and clamps.
  const zoomed = C.zoomAround(start, 100, 50, 2);
  assert.deepEqual(C.toWorld(zoomed, 100, 50), C.toWorld(start, 100, 50));
  assert.ok(C.zoomAround(start, 0, 0, 1e9).k <= 3);
  assert.equal(C.zoomAround(start, 0, 0, NaN).k, 1);
  // A visible point needs no pan; one off-screen is centred.
  assert.equal(C.revealCamera(start, { x: 400, y: 300 }, size), null);
  const shown = C.revealCamera(start, { x: 5000, y: 300 }, size);
  assert.deepEqual(C.toWorld(shown, 400, 300), { x: 5000, y: 300 });
});

test('Esc is left to the host when nothing is selected', () => {
  const { web } = setup();
  assert.equal(web.onKey({ key: 'Escape' }), false);
  assert.equal(web.onKey({ key: 'Enter' }), false);
  assert.equal(web.onKey(null), false);
});
