// ============================================================================
// LunaCore - E1: machine telemetry widget (RAM / CPU / uptime)
// ----------------------------------------------------------------------------
// A streaming readout of the machine the session is running on. Samples arrive
// every 2 s from src/telemetry.js through the bus; nothing here polls, asks the
// network, or costs a token.
//
// Shape follows what the design work said a live ops readout needs, in order of
// importance:
//
//   1. THE NUMBER IS THE TRUTH, the chart is the context. A sparkline alone
//      makes you estimate a value you could have simply been told, so the
//      percent is set large and the chart sits under it.
//   2. A PAUSE CONTROL, because a number that changes every two seconds is hard
//      to read out loud to someone. Pause freezes the PICTURE only - samples
//      keep accumulating behind it, so resuming shows the present rather than
//      replaying a backlog. Freezing the buffer instead would put a gap in the
//      series while the axis still claimed even spacing, which is the exact lie
//      the watcher refuses to tell by emitting unchanged samples (see
//      src/telemetry.js).
//   3. IT MUST STAY READABLE FROZEN. Reduced motion zeroes every `--dur-*`
//      token, so the bars step instead of gliding - and a stepped chart is still
//      a chart. Nothing here animates on a loop, and nothing conveys meaning by
//      motion alone.
//
// A2 rules this widget obeys: the series lives at MODULE scope so a remount
// repaints 80 seconds of history instead of starting from empty; `els` is null
// while unmounted; and render() only ever writes to the DOM - every value it
// needs comes from module state, never from reading an element back.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, onTelemetryUpdate } from './bus.js';
import { defineWidget } from './registry.js';

/** Samples kept on screen. 40 x 2 s = the last ~80 seconds. */
export const TELEM_MAX = 40;

// Deliberately NOT the context-window thresholds from thresholds.js. A context
// window at 60% is worth warning about because it is heading for a compact; a
// machine at 60% RAM is simply a machine doing its job. These are the points
// where a build starts to hurt.
export const TELEM_WARN = 75;
export const TELEM_CRIT = 90;

const GIB = 1024 * 1024 * 1024;

/** Ring of samples, oldest first. Survives unmount - see the header. */
let history = [];

/** Frozen picture. The buffer above keeps filling regardless. */
let paused = false;

/** Elements of the current mount, or null when this widget is not on screen. */
let els = null;

/**
 * Appends a sample and drops what scrolled off the left.
 *
 * Exported for the tests, and kept separate from render() for the reason
 * spark.js documents at length: the two halves must be testable together, or a
 * field one side stores and the other reads can silently go missing.
 */
export function pushTelemetry(sample) {
  if (!sample || typeof sample !== 'object') return history;
  history.push(sample);
  if (history.length > TELEM_MAX) history = history.slice(-TELEM_MAX);
  return history;
}

/** Test seam - the module-scope series is otherwise unreachable. */
export function telemetryHistory() {
  return history;
}

/**
 * Which severity band a percentage falls in.
 *
 * Returns a name rather than a colour: the palette belongs to the theme tokens,
 * and a module that picked a hex here would be invisible to the nine themes.
 */
export function barLevel(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return 'unknown';
  if (percent >= TELEM_CRIT) return 'crit';
  if (percent >= TELEM_WARN) return 'warn';
  return 'ok';
}

/**
 * Bytes as GB with one decimal.
 *
 * GiB, not GB-the-marketing-unit, because that is what `os.totalmem()` reports
 * and what Task Manager shows next to it - a HUD that disagreed with the OS
 * about how much RAM the machine has would be assumed broken, correctly.
 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null;
  return `${(bytes / GIB).toFixed(1)} GB`;
}

/**
 * Seconds as `4d 02:17`, or `02:17` under a day.
 *
 * Clock notation rather than words: it needs no translation, and it stays the
 * same width as it ticks, so the line does not jitter every minute.
 */
export function formatUptime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;

  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const hhmm = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;

  return days > 0 ? `${days}d ${hhmm}` : hhmm;
}

/** The three load figures at two decimals, or null where the platform lies. */
export function formatLoad(load) {
  if (!Array.isArray(load) || load.length < 3) return null;
  if (!load.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return load
    .slice(0, 3)
    .map((n) => n.toFixed(2))
    .join('  ');
}

/** The most recent sample, or null before the first one lands. */
function latest() {
  return history.length ? history[history.length - 1] : null;
}

/** Builds the fixed pool of sparkline bars once, on mount. */
function buildTicks(container) {
  if (!container) return [];
  container.innerHTML = '';
  const ticks = [];
  for (let i = 0; i < TELEM_MAX; i += 1) {
    const tick = document.createElement('i');
    tick.className = 'telem__tick';
    container.appendChild(tick);
    ticks.push(tick);
  }
  return ticks;
}

/**
 * Repaints one metric row: big number, bar, sparkline, footnote.
 *
 * `pick(sample)` pulls this row's percent out of a sample, so RAM and CPU share
 * every line of drawing code and can never drift apart visually.
 */
function renderRow(row, pick, footnote) {
  if (!row || !row.section) return;

  const sample = latest();
  const percent = sample ? pick(sample) : null;
  const known = typeof percent === 'number' && Number.isFinite(percent);

  row.value.textContent = known ? `${percent}%` : '--';
  row.section.dataset.level = barLevel(known ? percent : null);

  // transform only, per the C1c motion rules - never width.
  row.bar.style.setProperty('--telem-fill', known ? String(percent / 100) : '0');

  // The series is drawn right-aligned: the newest sample is always the rightmost
  // bar, so a half-full buffer grows from the right rather than jumping when it
  // fills. The padding on the left is EMPTY ticks, not zeros - an unknown
  // reading must not draw as a floor-level bar.
  const offset = TELEM_MAX - history.length;
  for (let i = 0; i < TELEM_MAX; i += 1) {
    const tick = row.ticks[i];
    if (!tick) continue;
    const s = i >= offset ? history[i - offset] : null;
    const v = s ? pick(s) : null;
    const ok = typeof v === 'number' && Number.isFinite(v);
    tick.style.setProperty('--telem-tick', ok ? String(Math.max(0.02, v / 100)) : '0');
    tick.dataset.level = ok ? barLevel(v) : 'unknown';
  }

  row.note.textContent = footnote(sample) || '';
}

/** Full repaint from module state. Writes only; reads nothing back. */
function render() {
  if (!els) return;

  // Paused freezes the picture, not the feed. Everything above keeps running.
  if (paused) return;

  renderRow(
    els.ram,
    (s) => (s.mem ? s.mem.percent : null),
    (s) => {
      if (!s || !s.mem) return t('telemetry.waiting');
      const used = formatBytes(s.mem.used);
      const total = formatBytes(s.mem.total);
      return used && total ? `${used} / ${total}` : '';
    }
  );

  renderRow(
    els.cpu,
    (s) => (s.cpu ? s.cpu.percent : null),
    (s) => {
      if (!s || !s.cpu) return t('telemetry.waiting');
      const parts = [t('telemetry.cores', { n: s.cpu.cores })];
      if (s.cpu.speedMhz) parts.push(`${(s.cpu.speedMhz / 1000).toFixed(1)} GHz`);
      return parts.join(' · ');
    }
  );

  // gpu.js stamps this onto the sample from its own slower timer (main.js);
  // null forever on non-Windows or when the counter cannot be read - the row
  // just reads "--" rather than claiming a number nobody measured.
  renderRow(
    els.gpu,
    (s) => (s.gpu ? s.gpu.percent : null),
    (s) => (s && s.gpu ? '' : t('telemetry.waiting'))
  );

  renderFoot();
}

/** Uptime, and load average only where the platform actually measures it. */
function renderFoot() {
  if (!els || !els.foot) return;

  const sample = latest();
  const parts = [];

  const up = sample ? formatUptime(sample.uptime) : null;
  if (up) parts.push(`${t('telemetry.uptime')} ${up}`);

  // null on Windows by design - os.loadavg() returns [0,0,0] there, and printing
  // three zeros would be a fabricated reading. See src/telemetry.js.
  const load = sample ? formatLoad(sample.load) : null;
  if (load) parts.push(`${t('telemetry.load')} ${load}`);

  els.foot.textContent = parts.join('   ');
}

/** Keeps the pause button's glyph, label and pressed state in one place. */
function syncPauseButton() {
  if (!els || !els.pause) return;
  els.pause.textContent = paused ? '▶' : '⏸';
  els.pause.title = paused ? t('telemetry.resume') : t('telemetry.pause');
  els.pause.setAttribute('aria-label', els.pause.title);
  els.pause.setAttribute('aria-pressed', paused ? 'true' : 'false');
  els.pause.classList.toggle('is-on', paused);
  els.root.classList.toggle('is-paused', paused);
}

defineWidget({
  id: 'telemetry',
  titleKey: 'telemetry.title',
  template: 'w-telemetry',
  mount(root) {
    const row = (prefix) => ({
      section: root.querySelector(`#telem-${prefix}`),
      value: root.querySelector(`#telem-${prefix}-value`),
      bar: root.querySelector(`#telem-${prefix}-bar`),
      note: root.querySelector(`#telem-${prefix}-note`),
      ticks: buildTicks(root.querySelector(`#telem-${prefix}-spark`)),
    });

    els = {
      root,
      ram: row('ram'),
      cpu: row('cpu'),
      gpu: row('gpu'),
      foot: root.querySelector('#telem-foot'),
      pause: root.querySelector('#telem-pause'),
    };

    const offTelemetry = onTelemetryUpdate((sample) => {
      // Note the order: the buffer is fed even while paused, so resuming shows
      // the machine as it is now rather than replaying what it missed.
      pushTelemetry(sample);
      render();
    });

    // The footnotes and button titles are translated strings.
    const offLang = onLangChange(() => {
      syncPauseButton();
      render();
    });

    if (els.pause) {
      els.pause.addEventListener('click', () => {
        paused = !paused;
        syncPauseButton();
        render(); // resuming repaints immediately; pausing is a no-op by design
      });
    }

    syncPauseButton();
    render();

    // Only the bus subscriptions need undoing. Nothing is flushed here: pausing
    // is a view preference, not pending user intent (the §A2b distinction), and
    // it deliberately survives a remount so switching layout preset does not
    // silently restart a chart someone was reading.
    return () => {
      offTelemetry();
      offLang();
      els = null;
    };
  },
});
