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

The four UI cues (`nav-click.wav`, `mode-toggle.wav`, `terminal-new.wav`,
`terminal-close.wav`) are real since 2026-11-02 (until then they were 0-byte
stubs that played nothing). Procedurally synthesized by
`scripts/gen-ui-sounds.js` — decaying sine partials + raised-cosine fades,
16-bit mono 44.1 kHz, peaks 0.30-0.35 (no clipping), output deterministic:
- `nav-click` — ~30 ms soft tick (1.9 kHz + tiny noise transient)
- `mode-toggle` — ~80 ms two-tone up blip (A5 → E6)
- `terminal-new` — ~150 ms soft rising chime (G5 → D6)
- `terminal-close` — ~150 ms soft falling chime (D6 → G5)

Regenerate with `node scripts/gen-ui-sounds.js`. `test/ui-sounds.test.js`
checks the files are valid, < 200 ms, unclipped, and match the generator, so
tweak the script and regenerate rather than editing the wavs by hand. Per-cue
volume lives in `config/sounds.json`.
