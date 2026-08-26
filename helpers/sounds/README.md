# Sound assets

`voice/*.mp3` are real — generated 2026-08-11 via Edge-TTS (`en-US-AriaNeural`,
`--rate=+5% --pitch=+15Hz` for a perkier delivery; see the plan's §7 and §10
voice-choice decision: "woman's voice, girly/spicy"). Regenerate with:
```
python -m edge_tts --voice en-US-AriaNeural --rate=+5% --pitch=+15Hz \
  --text "..." --write-media helpers/sounds/voice/<name>.mp3
```

`sfx/keystroke-*.wav` (the 4 variants) are real now — procedurally synthesized
short clicks (30-55ms each, no external assets/libraries, just raw PCM +
envelope math), generated 2026-08-17. **Dead as of 2026-08-26**: keystroke sound
moved entirely off this mpv path onto `src/renderer/modules/keysynth.js` (Web
Audio, real samples from `assets/keysounds/` - see
`reference/TYPING_SYNTH_PLAN.md`'s "Resolved 2026-08-26"). Nothing plays these
4 files anymore; left in place rather than deleted.

The other four (`nav-click.wav`, `mode-toggle.wav`, `terminal-new.wav`,
`terminal-close.wav`) are still 0-byte stubs — nothing plays them yet. mpv/the
sound engine handle a missing/silent file the same as a missing one (no crash,
just no sound).
