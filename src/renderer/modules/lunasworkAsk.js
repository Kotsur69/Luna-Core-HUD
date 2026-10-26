// ============================================================================
// LunaCore - "Ask Luna about the run" box (LW 2.27)
// ----------------------------------------------------------------------------
// A question box in the Luna's Work pane: "why did you roll back iteration
// 14?". Main answers it read-only (src/lunasworkAsk.js) from the run's
// records only, through the narrow lunaswork:ask IPC; main trims, caps and
// rate-limits the question - this box only keeps the input short. The answer
// and the sources it cites are painted as text, never as HTML.
// ============================================================================

'use strict';

import { sfx } from './sound.js';
import { t } from './util.js';

// Source names as main sends them -> their i18n label key.
const SOURCE_KEYS = {
  'run-state': 'lw.ask.src.state',
  'run-report': 'lw.ask.src.report',
  'PLAYTEST_LOG.md': 'lw.ask.src.playtest',
  'DECISIONS.md': 'lw.ask.src.decisions',
  rollbacks: 'lw.ask.src.rollbacks',
};
const ERROR_KEYS = ['bad-question', 'rate-limited', 'no-run', 'failed'];

/**
 * "Sources: DECISIONS.md (iteration 14), run report", or '' without any.
 * @param {{file:string, iteration?:number}[]} sources
 * @returns {string}
 */
export function sourcesText(sources) {
  const list = (Array.isArray(sources) ? sources : [])
    .filter((s) => s && Object.hasOwn(SOURCE_KEYS, s.file))
    .map((s) => {
      const name = t(SOURCE_KEYS[s.file]);
      return Number.isInteger(s.iteration) ? `${name} (${t('lw.ask.iteration', { n: s.iteration })})` : name;
    });
  return list.length ? `${t('lw.ask.sources')}: ${list.join(', ')}` : '';
}

/** Localized text for a refused or failed question. */
function errorText(res) {
  const reason = res && ERROR_KEYS.includes(res.reason) ? res.reason : 'failed';
  if (reason === 'rate-limited' && res && Number.isFinite(res.retryAt)) {
    const time = new Date(res.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return t('lw.ask.err.rate-limited-until', { time });
  }
  return t(`lw.ask.err.${reason}`);
}

/**
 * @param {HTMLElement} root the Settings overlay
 * @returns {{dispose: () => void}}
 */
export function mountLunasWorkAsk(root) {
  const ui = {
    form: root.querySelector('#lw-ask-form'),
    text: root.querySelector('#lw-ask-text'),
    send: root.querySelector('#lw-ask-send'),
    msg: root.querySelector('#lw-ask-msg'),
    answer: root.querySelector('#lw-ask-answer'),
  };
  if (Object.values(ui).some((v) => !v)) return { dispose: () => {} };

  const setMsg = (text, bad) => {
    ui.msg.textContent = text || '';
    ui.msg.hidden = !text;
    ui.msg.classList.toggle('is-bad', !!bad);
  };

  function paintAnswer(item) {
    ui.answer.replaceChildren();
    if (!item || !item.answer) {
      ui.answer.hidden = true;
      return;
    }
    const body = document.createElement('p');
    body.textContent = item.answer;
    ui.answer.append(body);
    const cited = sourcesText(item.sources);
    if (cited) {
      const src = document.createElement('p');
      src.className = 'lw-ask__sources';
      src.textContent = cited;
      ui.answer.append(src);
    }
    ui.answer.hidden = false;
  }

  async function submit(e) {
    e.preventDefault();
    const question = ui.text.value.trim();
    if (!question || ui.send.disabled) return;
    sfx.navClick();
    ui.send.disabled = true;
    setMsg(t('lw.ask.thinking'));
    try {
      const res = await window.lunacore.lunasworkAsk(question);
      if (!res || !res.ok) {
        setMsg(errorText(res), true);
        return;
      }
      setMsg('');
      ui.text.value = '';
      paintAnswer(res.item);
    } catch {
      setMsg(t('lw.ask.err.failed'), true);
    } finally {
      ui.send.disabled = false;
    }
  }

  ui.form.addEventListener('submit', submit);
  return { dispose: () => ui.form.removeEventListener('submit', submit) };
}
