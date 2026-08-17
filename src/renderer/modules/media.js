// ============================================================================
// LunaCore - Media Deck: now-playing display + transport/volume controls
// ----------------------------------------------------------------------------
// ACTION INJECTOR, not Passive Observer - every button here causes an
// explicit OS-level effect (play/pause/skip, volume). Still never touches the
// PTY: window.lunacore.mediaCommand() is a wholly separate IPC path from
// pty:write/pty:command (see src/main.js's media:command handler).
//
// App-scoped like usage.js/telemetry.js, NOT per-tab like activefiles.js/
// sessiontimeline.js - one Windows box, one system volume, one "current"
// media session regardless of how many terminal tabs are open. So: no
// registerSessionView, no per-tab bucket, no modal - see feeds.js's own
// comment on why this bypasses sessions.js entirely.
//
// The template (index.html #w-media) is a fixed shape, unlike usage.js's
// dynamically-built list - so mount() only grabs element references and
// render() only ever updates textContent/value/classList, never rebuilds via
// innerHTML. That also means a media:update tick landing mid volume-drag
// can't yank the slider out from under the user - see the volume slider's
// `change` (not `input`) listener below, same choice termcustom.js's own
// sound-volume slider already makes.
// ============================================================================

'use strict';

import { t } from './util.js';
import { onLangChange, onMediaUpdate } from './bus.js';
import { defineWidget } from './registry.js';

const TITLE_MAX = 40;
const ARTIST_MAX = 32;

let els = null;
let latest = null; // {title, artist, appId, isPlaying} | null - now playing
let volumeState = null; // {level, muted} | null

/** Truncates a label to `max` chars with an ellipsis. Pure, exported for tests. */
export function truncateLabel(text, max) {
  const str = typeof text === 'string' ? text : '';
  if (str.length <= max) return str;
  return `${str.slice(0, Math.max(0, max - 1))}…`;
}

function renderInfo() {
  if (!els) return;
  if (!latest || (!latest.title && !latest.artist)) {
    els.title.textContent = '';
    els.artist.textContent = '';
    els.empty.textContent = t('media.empty');
    els.empty.style.display = '';
    els.playpause.disabled = true;
    els.playpause.textContent = '▶';
    return;
  }
  els.empty.style.display = 'none';
  els.title.textContent = truncateLabel(latest.title, TITLE_MAX);
  els.artist.textContent = truncateLabel(latest.artist, ARTIST_MAX);
  els.playpause.disabled = false;
  els.playpause.textContent = latest.isPlaying ? '⏸' : '▶';
}

function renderVolume() {
  if (!els) return;
  if (!volumeState) return;
  els.volume.value = String(volumeState.level);
  els.mute.textContent = volumeState.muted ? '\u{1F507}' : '\u{1F50A}';
  els.mute.classList.toggle('is-muted', volumeState.muted);
}

async function refreshVolume() {
  const v = await window.lunacore.mediaCommand({ type: 'volume', action: 'get' });
  if (v) {
    volumeState = v;
    renderVolume();
  }
}

defineWidget({
  id: 'media',
  titleKey: 'media.title',
  template: 'w-media',
  mount(root) {
    els = {
      title: root.querySelector('#media-title'),
      artist: root.querySelector('#media-artist'),
      empty: root.querySelector('#media-empty'),
      prev: root.querySelector('#media-prev'),
      playpause: root.querySelector('#media-playpause'),
      next: root.querySelector('#media-next'),
      mute: root.querySelector('#media-mute'),
      volume: root.querySelector('#media-volume'),
    };

    const offMedia = onMediaUpdate((state) => {
      latest = state;
      renderInfo();
    });
    const offLang = onLangChange(renderInfo);

    els.prev.addEventListener('click', () => {
      window.lunacore.mediaCommand({ type: 'transport', action: 'prev' });
    });
    els.playpause.addEventListener('click', () => {
      window.lunacore.mediaCommand({ type: 'transport', action: 'toggle' });
    });
    els.next.addEventListener('click', () => {
      window.lunacore.mediaCommand({ type: 'transport', action: 'next' });
    });
    els.mute.addEventListener('click', async () => {
      const v = await window.lunacore.mediaCommand({ type: 'volume', action: 'mute' });
      if (v) {
        volumeState = v;
        renderVolume();
      }
    });
    els.volume.addEventListener('change', async () => {
      const v = await window.lunacore.mediaCommand({
        type: 'volume',
        action: 'set',
        value: Number(els.volume.value),
      });
      if (v) {
        volumeState = v;
        renderVolume();
      }
    });

    renderInfo();
    refreshVolume();

    return () => {
      offMedia();
      offLang();
      els = null;
    };
  },
});
