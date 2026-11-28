// ============================================================================
// LunaCore - Playtester bridge: the narrow tool sets (LW 3.35 / 3.36b)
// ----------------------------------------------------------------------------
// The ONLY tools a desktop (electron) or game (unity) Playtester gets. The
// bridge (bridge.js) advertises exactly these over MCP and the adapters build
// their --allowedTools from the same names, so the two cannot drift.
//
// Deliberately absent: anything that reads or writes files, runs code (no
// evaluate / execute script), opens an arbitrary URL or path, or reaches the
// project source. Screenshots are written by the bridge itself, into the
// iteration's evidence dir only, under a sanitized name.
//
// checkArgs() validates every call before it reaches the app: the model's
// arguments are untrusted. Unknown keys are dropped, every string is capped.
// Plain Node, no dependencies: it also runs outside LunaCore's asar.
// ============================================================================

'use strict';

const MAX_SELECTOR_CHARS = 500;
const MAX_NAME_CHARS = 200;
const MAX_TEXT_CHARS = 5000;
const MAX_WAIT_MS = 15000;
const DEFAULT_WAIT_MS = 5000;
const MAX_MENU_DEPTH = 6;
const MAX_INPUT_STEPS = 50;
const MAX_HOLD_MS = 5000;
const MIN_WINDOW_PX = 200;
const MAX_WINDOW_WIDTH = 7680;
const MAX_WINDOW_HEIGHT = 4320;
const SCREENSHOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)(?:\.|$)/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Electron accelerator key codes the Playtester may press.
const KEY_RE = /^(?:[A-Za-z0-9]|F(?:[1-9]|1\d|2[0-4])|Enter|Return|Escape|Esc|Tab|Backspace|Delete|Insert|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Plus|Minus|[`=[\];',./\\-])$/;
const MODIFIERS = ['shift', 'control', 'ctrl', 'alt', 'meta', 'command', 'cmd', 'cmdorctrl'];
// Unity input names: Input Manager buttons / axes, Input System actions, key names.
const UNITY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,63}$/;
const INPUT_TYPES = ['key', 'button', 'axis', 'click', 'ui', 'wait'];
// Game-declared steps (e.g. slowMotion): any other type name the game's
// PlaytestDriver implements, passed through with numeric fields only. Every
// number stays within +-GAME_STEP_MAX_ABS, so no duration runs past MAX_WAIT_MS.
const GAME_STEP_TYPE_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const GAME_STEP_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const GAME_STEP_MAX_FIELDS = 8;
const GAME_STEP_MAX_ABS = MAX_WAIT_MS;
// burst: N screenshots at even intervals, stitched into one labeled contact
// sheet (burst.js). Out-of-range values are clamped, not refused.
const BURST_MIN_FRAMES = 4;
const BURST_MAX_FRAMES = 12;
const BURST_DEFAULT_FRAMES = 8;
const BURST_MIN_DURATION_MS = 500;
const BURST_MAX_DURATION_MS = 1500;
const BURST_DEFAULT_DURATION_MS = 1200;
// Every sheet is saved under this prefix, so the Critic can tell a time
// sequence from a single screenshot by its file name alone.
const BURST_PREFIX = 'burst-';

// ---- definitions --------------------------------------------------------------------

const windowId = { type: 'integer', description: 'Window id from list_windows; default = the focused window.' };
const target = {
  selector: { type: 'string', description: 'CSS selector of the element.' },
  name: { type: 'string', description: 'Accessible name: aria-label, label text, button or link text, title, alt or placeholder.' },
};
const screenshotName = {
  type: 'string',
  description: 'Short unique file name, letters, digits, dot, dash or underscore (e.g. "f3-settings-wide.png"). Saved as PNG in the evidence folder.',
};
const obj = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const burstProps = {
  name: { ...screenshotName, description: `${screenshotName.description} Saved with a "${BURST_PREFIX}" prefix.` },
  frames: { type: 'integer', description: `Frames to capture, ${BURST_MIN_FRAMES} to ${BURST_MAX_FRAMES} (default ${BURST_DEFAULT_FRAMES}).` },
  durationMs: { type: 'integer', description: `Time from the first to the last frame, ${BURST_MIN_DURATION_MS} to ${BURST_MAX_DURATION_MS} ms (default ${BURST_DEFAULT_DURATION_MS}).` },
};
const BURST_DESCRIPTION = 'Capture several screenshots at even intervals and stitch them into one contact sheet, each tile labeled with its ms offset: for motion, animations, hit-stop freezes, transitions and afterimages a single screenshot cannot show. Returns the sheet and its file name.';

/** @type {Record<string, Array<{name:string, description:string, inputSchema:object}>>} */
const TOOL_DEFS = {
  electron: [
    { name: 'list_windows', description: 'List the open app windows: id, title, size, focus.', inputSchema: obj({}) },
    { name: 'screenshot', description: 'Screenshot one window (what the user sees). Returns the image and its file name.', inputSchema: obj({ name: screenshotName, windowId }, ['name']) },
    { name: 'click', description: 'Click an element by CSS selector or accessible name (real mouse events).', inputSchema: obj({ ...target, windowId }) },
    { name: 'type_text', description: 'Type text into the element (or the focused one); submit presses Enter after.', inputSchema: obj({ text: { type: 'string' }, ...target, submit: { type: 'boolean' }, windowId }, ['text']) },
    { name: 'press_key', description: 'Press a key or keyboard shortcut (e.g. key "N" with modifiers ["control"]). Application menu accelerators fire like a real key press.', inputSchema: obj({ key: { type: 'string' }, modifiers: { type: 'array', items: { type: 'string', enum: MODIFIERS } }, windowId }, ['key']) },
    { name: 'resize_window', description: 'Resize a window content area to width x height pixels.', inputSchema: obj({ width: { type: 'integer' }, height: { type: 'integer' }, windowId }, ['width', 'height']) },
    { name: 'read_text', description: 'The visible text of the page, or of one element (CSS selector).', inputSchema: obj({ selector: target.selector, windowId }) },
    { name: 'console_errors', description: 'Errors the app logged so far (renderer console errors, crashes, failed loads). clear: forget them after reading.', inputSchema: obj({ clear: { type: 'boolean' } }) },
    { name: 'wait_for_text', description: `Wait until the text appears in the window (max ${MAX_WAIT_MS} ms).`, inputSchema: obj({ text: { type: 'string' }, timeoutMs: { type: 'integer' }, windowId }, ['text']) },
    { name: 'list_menu', description: 'The application menu (menu bar / tray-style entries the app exposes): labels, accelerators, enabled state.', inputSchema: obj({}) },
    { name: 'click_menu', description: 'Click an application menu item by its labels, top level first, e.g. ["File", "New"].', inputSchema: obj({ labels: { type: 'array', items: { type: 'string' } } }, ['labels']) },
    { name: 'burst', description: `${BURST_DESCRIPTION} One window.`, inputSchema: obj({ ...burstProps, windowId }, ['name']) },
  ],
  unity: [
    { name: 'screenshot', description: 'Screenshot the Game view in play mode. Returns the image and its file name.', inputSchema: obj({ name: screenshotName }, ['name']) },
    { name: 'game_state', description: "The game's JSON state snapshot from the PlaytestDriver (scene, player, score, UI...). A game without the driver answers with source \"unity-builtin\": the scene and the Player's Transform only.", inputSchema: obj({}) },
    {
      name: 'send_input',
      description: `Scripted inputs through the PlaytestDriver, run in order. Step types: key {key, holdMs}, button {name, holdMs}, axis {name, value -1..1, holdMs}, click {x, y} (0..1 of the screen), ui {name} (click a UI element by its GameObject name), wait {ms}. Game step types: any other type the game's driver declares (game_state "stepTypes"), with number fields only, each within -${GAME_STEP_MAX_ABS}..${GAME_STEP_MAX_ABS}, e.g. {"type":"slowMotion", "scale":0.25, "durationMs":2000}. A game without the driver runs only key (Input System key names: Space, D, LeftArrow, Digit1) and wait steps. When the result lists warnings, quote them in your report.`,
      inputSchema: obj({
        steps: {
          type: 'array',
          items: {
            type: 'object',
            // Game step types carry their own number fields.
            additionalProperties: { type: 'number' },
            properties: {
              type: { type: 'string', pattern: GAME_STEP_TYPE_RE.source, description: `${INPUT_TYPES.join(', ')}, or a game step type the driver declares.` },
              key: { type: 'string' },
              name: { type: 'string' },
              value: { type: 'number' },
              x: { type: 'number' },
              y: { type: 'number' },
              holdMs: { type: 'integer' },
              ms: { type: 'integer' },
            },
            required: ['type'],
          },
        },
      }, ['steps']),
    },
    { name: 'console_errors', description: 'Errors and warnings from the Unity console since play mode started.', inputSchema: obj({}) },
    { name: 'wait', description: `Let the game run for ms milliseconds (max ${MAX_WAIT_MS}).`, inputSchema: obj({ ms: { type: 'integer' } }, ['ms']) },
    { name: 'burst', description: `${BURST_DESCRIPTION} Game view, play mode only.`, inputSchema: obj(burstProps, ['name']) },
  ],
};

const BACKENDS = Object.keys(TOOL_DEFS);

/** @returns {string[]} the tool names of one backend (a fresh array) */
function toolNames(backend) {
  return (TOOL_DEFS[backend] || []).map((t) => t.name);
}

// ---- validation ---------------------------------------------------------------------

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

class ArgError extends Error {}

/** A single-line, non-empty string within `max`, or an ArgError. */
function str(raw, field, max) {
  if (typeof raw !== 'string' || !raw.trim()) throw new ArgError(`${field} must be a non-empty string`);
  if (raw.length > max) throw new ArgError(`${field} is longer than ${max} characters`);
  if (CONTROL_CHARS.test(raw)) throw new ArgError(`${field} must be a single line`);
  return raw.trim();
}

function int(raw, field, min, max) {
  if (!Number.isInteger(raw) || raw < min || raw > max) throw new ArgError(`${field} must be a whole number from ${min} to ${max}`);
  return raw;
}

function num(raw, field, min, max) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) throw new ArgError(`${field} must be a number from ${min} to ${max}`);
  return raw;
}

const optional = (raw, fn) => (raw === undefined || raw === null ? undefined : fn(raw));
const optWindow = (a) => optional(a.windowId, (v) => int(v, 'windowId', 0, 1e9));
const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** {selector} or {name}, exactly one; `required` false allows neither. */
function elementTarget(a, required) {
  const selector = optional(a.selector, (v) => str(v, 'selector', MAX_SELECTOR_CHARS));
  const name = optional(a.name, (v) => str(v, 'name', MAX_NAME_CHARS));
  if (selector !== undefined && name !== undefined) throw new ArgError('give selector or name, not both');
  if (required && selector === undefined && name === undefined) throw new ArgError('give a selector or a name');
  return drop({ selector, name });
}

function screenshotFile(raw) {
  const name = str(raw, 'name', 100);
  const file = /\.png$/i.test(name) ? name : `${name}.png`;
  if (!SCREENSHOT_NAME_RE.test(file) || file.includes('..')) throw new ArgError('name may hold only letters, digits, dot, dash and underscore');
  // Windows device names (CON, NUL, COM1...) are not files, even with an extension.
  if (WINDOWS_DEVICE_RE.test(file)) throw new ArgError('name must not be a Windows device name');
  return file;
}

/** A screenshot name with the burst prefix (added when missing), still a valid file name. */
function burstFile(raw) {
  const file = screenshotFile(raw);
  const named = file.toLowerCase().startsWith(BURST_PREFIX) ? file : `${BURST_PREFIX}${file}`;
  if (!SCREENSHOT_NAME_RE.test(named)) throw new ArgError(`name is too long once prefixed with "${BURST_PREFIX}"`);
  return named;
}

/** A number rounded and clamped into [min, max]; absent means `fallback`. Not a number is an ArgError. */
function clampedInt(raw, field, { min, max, fallback }) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new ArgError(`${field} must be a number`);
  return Math.min(max, Math.max(min, Math.round(raw)));
}

/**
 * The burst options, clamped: frames 4..12 (default 8), durationMs 500..1500 (default 1200).
 * @param {{frames?:unknown, durationMs?:unknown}} raw
 * @returns {{frames:number, durationMs:number}}
 */
function burstOptions(raw) {
  const a = isObj(raw) ? raw : {};
  return {
    frames: clampedInt(a.frames, 'frames', { min: BURST_MIN_FRAMES, max: BURST_MAX_FRAMES, fallback: BURST_DEFAULT_FRAMES }),
    durationMs: clampedInt(a.durationMs, 'durationMs', { min: BURST_MIN_DURATION_MS, max: BURST_MAX_DURATION_MS, fallback: BURST_DEFAULT_DURATION_MS }),
  };
}

/**
 * A game-declared step: the type name and its number fields, nothing else.
 * A string, object, unbounded or non-finite field is refused, not dropped:
 * the driver would run the step without it.
 */
function gameStep(raw, at) {
  const fields = Object.entries(raw).filter(([field]) => field !== 'type');
  if (fields.length > GAME_STEP_MAX_FIELDS) throw new ArgError(`${at}: a game step takes at most ${GAME_STEP_MAX_FIELDS} fields`);
  const out = { type: raw.type };
  for (const [field, value] of fields) {
    if (!GAME_STEP_FIELD_RE.test(field)) throw new ArgError(`${at}: field '${field.slice(0, 40)}' is not a plain name`);
    out[field] = num(value, `${at} ${field}`, -GAME_STEP_MAX_ABS, GAME_STEP_MAX_ABS);
  }
  return out;
}

function inputStep(raw, i) {
  const at = `step ${i + 1}`;
  if (!isObj(raw) || typeof raw.type !== 'string') throw new ArgError(`${at}: type must be one of ${INPUT_TYPES.join(', ')}, or a game step type`);
  if (!INPUT_TYPES.includes(raw.type)) {
    if (!GAME_STEP_TYPE_RE.test(raw.type)) throw new ArgError(`${at}: type must be one of ${INPUT_TYPES.join(', ')}, or a game step type (a letter, then up to 39 letters, digits or _)`);
    return gameStep(raw, at);
  }
  const hold = () => optional(raw.holdMs, (v) => int(v, `${at} holdMs`, 0, MAX_HOLD_MS));
  const unityName = (v, field) => {
    const s = str(v, `${at} ${field}`, 64);
    if (!UNITY_NAME_RE.test(s)) throw new ArgError(`${at}: ${field} has characters a Unity input name cannot`);
    return s;
  };
  switch (raw.type) {
    case 'key':
      return drop({ type: 'key', key: unityName(raw.key, 'key'), holdMs: hold() });
    case 'button':
      return drop({ type: 'button', name: unityName(raw.name, 'name'), holdMs: hold() });
    case 'axis':
      return drop({ type: 'axis', name: unityName(raw.name, 'name'), value: num(raw.value, `${at} value`, -1, 1), holdMs: hold() });
    case 'click':
      return { type: 'click', x: num(raw.x, `${at} x`, 0, 1), y: num(raw.y, `${at} y`, 0, 1) };
    case 'ui':
      return { type: 'ui', name: str(raw.name, `${at} name`, MAX_NAME_CHARS) };
    default:
      return { type: 'wait', ms: int(raw.ms, `${at} ms`, 0, MAX_WAIT_MS) };
  }
}

function typedText(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_TEXT_CHARS) throw new ArgError(`text must be a string of at most ${MAX_TEXT_CHARS} characters`);
  return raw;
}

function shortcut(a) {
  const key = str(a.key, 'key', 20);
  if (!KEY_RE.test(key)) throw new ArgError(`unknown key '${key}'`);
  const mods = a.modifiers === undefined ? [] : a.modifiers;
  if (!Array.isArray(mods) || mods.length > 4 || !mods.every((m) => MODIFIERS.includes(String(m).toLowerCase()))) {
    throw new ArgError(`modifiers must be some of ${MODIFIERS.join(', ')}`);
  }
  return drop({ key, modifiers: [...new Set(mods.map((m) => String(m).toLowerCase()))], windowId: optWindow(a) });
}

const VALIDATORS = {
  electron: {
    list_windows: () => ({}),
    screenshot: (a) => drop({ name: screenshotFile(a.name), windowId: optWindow(a) }),
    click: (a) => drop({ ...elementTarget(a, true), windowId: optWindow(a) }),
    type_text: (a) => drop({
      text: typedText(a.text),
      ...elementTarget(a, false),
      submit: a.submit === true ? true : undefined,
      windowId: optWindow(a),
    }),
    press_key: shortcut,
    resize_window: (a) => drop({
      width: int(a.width, 'width', MIN_WINDOW_PX, MAX_WINDOW_WIDTH),
      height: int(a.height, 'height', MIN_WINDOW_PX, MAX_WINDOW_HEIGHT),
      windowId: optWindow(a),
    }),
    read_text: (a) => drop({ selector: optional(a.selector, (v) => str(v, 'selector', MAX_SELECTOR_CHARS)), windowId: optWindow(a) }),
    console_errors: (a) => drop({ clear: a.clear === true ? true : undefined }),
    wait_for_text: (a) => drop({
      text: str(a.text, 'text', MAX_NAME_CHARS),
      timeoutMs: optional(a.timeoutMs, (v) => int(v, 'timeoutMs', 0, MAX_WAIT_MS)) ?? DEFAULT_WAIT_MS,
      windowId: optWindow(a),
    }),
    list_menu: () => ({}),
    click_menu: (a) => {
      if (!Array.isArray(a.labels) || !a.labels.length || a.labels.length > MAX_MENU_DEPTH) throw new ArgError(`labels must list 1 to ${MAX_MENU_DEPTH} menu labels`);
      return { labels: a.labels.map((l, i) => str(l, `labels[${i}]`, MAX_NAME_CHARS)) };
    },
    burst: (a) => drop({ name: burstFile(a.name), ...burstOptions(a), windowId: optWindow(a) }),
  },
  unity: {
    screenshot: (a) => ({ name: screenshotFile(a.name) }),
    game_state: () => ({}),
    send_input: (a) => {
      if (!Array.isArray(a.steps) || !a.steps.length || a.steps.length > MAX_INPUT_STEPS) throw new ArgError(`steps must list 1 to ${MAX_INPUT_STEPS} inputs`);
      return { steps: a.steps.map(inputStep) };
    },
    console_errors: () => ({}),
    wait: (a) => ({ ms: int(a.ms, 'ms', 0, MAX_WAIT_MS) }),
    burst: (a) => ({ name: burstFile(a.name), ...burstOptions(a) }),
  },
};

/**
 * Validates one tool call of the Playtester.
 * @param {string} backend 'electron' | 'unity'
 * @param {string} tool
 * @param {unknown} raw the model's arguments
 * @returns {{ok:true, args:object}|{ok:false, error:string}}
 */
function checkArgs(backend, tool, raw) {
  const table = VALIDATORS[backend];
  if (!table || !Object.prototype.hasOwnProperty.call(table, tool)) return { ok: false, error: `unknown tool '${String(tool)}'` };
  try {
    return { ok: true, args: table[tool](isObj(raw) ? raw : {}) };
  } catch (err) {
    if (err instanceof ArgError) return { ok: false, error: err.message };
    throw err;
  }
}

module.exports = {
  BACKENDS,
  TOOL_DEFS,
  MAX_WAIT_MS,
  MAX_HOLD_MS,
  MAX_INPUT_STEPS,
  INPUT_TYPES,
  GAME_STEP_TYPE_RE,
  GAME_STEP_MAX_FIELDS,
  GAME_STEP_MAX_ABS,
  MAX_TEXT_CHARS,
  BURST_MIN_FRAMES,
  BURST_MAX_FRAMES,
  BURST_DEFAULT_FRAMES,
  BURST_MIN_DURATION_MS,
  BURST_MAX_DURATION_MS,
  BURST_DEFAULT_DURATION_MS,
  BURST_PREFIX,
  toolNames,
  burstOptions,
  checkArgs,
};
