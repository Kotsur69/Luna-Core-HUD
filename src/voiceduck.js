// ============================================================================
// LunaCore - voice ducking: auto-pause now-playing media while Luna narrates
// ----------------------------------------------------------------------------
// When the SAPI read-aloud narration (soundReadOutputEnabled, §11.2) starts
// speaking, pause whatever GSMTC media session is playing (Spotify, a browser
// tab, a podcast app - anything Windows' own media flyout controls), then
// resume it when the narration finishes. Only ever resumes media THIS module
// paused, so a track the user paused by hand stays paused.
//
// Narration only, by decision (2026-08-27): a multi-second read-aloud is
// worth pausing a podcast for; the 1-2s canned voice lines
// (welcome/needYou/done/usage) are not, and the transport round-trip would
// land after they had already finished.
//
// Pure policy core: "is it enabled", "is media playing", and the actual
// pause/resume calls are all injected, so this is unit-testable with no mpv,
// no PowerShell, and no GSMTC. The wiring in main.js supplies the real
// implementations (readUiPrefs, mediaSampler.current(), sendTransportCommand).
// ============================================================================

'use strict';

/**
 * @param {object} deps
 * @param {() => boolean} deps.isEnabled      voiceDuckingEnabled pref, read live
 * @param {() => boolean} deps.isMediaPlaying a GSMTC session is currently playing
 * @param {() => (Promise<any>|any)} deps.pauseMedia   send the transport "pause"
 * @param {() => (Promise<any>|any)} deps.resumeMedia  send the transport "play"
 * @returns {{ onVoiceActive: (active: boolean) => Promise<void>, readonly pausedByUs: boolean }}
 */
function createVoiceDuck({ isEnabled, isMediaPlaying, pauseMedia, resumeMedia }) {
  // True only between a pause WE issued and its matching resume. The single
  // source of truth for "should the resume happen" - deliberately not
  // re-checked against isEnabled(), so toggling the setting off mid-narration
  // still restores playback we interrupted.
  let pausedByUs = false;

  /**
   * Called with `true` when the narration channel starts playing and `false`
   * when it goes fully idle (main.js drives this off SoundManager's mpv
   * start-file/end-file counter).
   * @param {boolean} active
   */
  async function onVoiceActive(active) {
    if (active) {
      if (pausedByUs || !isEnabled() || !isMediaPlaying()) return;
      pausedByUs = true;
      await pauseMedia();
    } else {
      if (!pausedByUs) return;
      pausedByUs = false;
      await resumeMedia();
    }
  }

  return {
    onVoiceActive,
    get pausedByUs() {
      return pausedByUs;
    },
  };
}

module.exports = { createVoiceDuck };
