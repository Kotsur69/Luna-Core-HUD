# Sound assets

`voice/*.mp3` are real — generated 2026-08-11 via Edge-TTS (`en-US-AriaNeural`,
`--rate=+5% --pitch=+15Hz` for a perkier delivery; see the plan's §7 and §10
voice-choice decision: "woman's voice, girly/spicy"). Regenerate with:
```
python -m edge_tts --voice en-US-AriaNeural --rate=+5% --pitch=+15Hz \
  --text "..." --write-media helpers/sounds/voice/<name>.mp3
```

`sfx/*.wav` are still 0-byte stubs — nothing plays them yet. Need real short
clips (<80ms for the 4 keystroke variants) before they're audible; mpv/the
sound engine handle a missing/silent file the same as a missing one (no crash,
just no sound).
