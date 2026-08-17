# Concept: Audio-to-Keystroke Acoustic Synthesizer

This concept describes a dynamic, Web Audio API-driven synthesizer for LunaCore that replaces static `.wav` audio files with responsive acoustic feedback.

## 1. Core Mechanics

Instead of playing a flat recording of a mechanical click on every keystroke, LunaCore can synthesize sound waves on-the-fly inside the sandboxed renderer process.

```
                  ┌────────────────────────────────────────┐
                  │          WEB AUDIO API ENGINE          │
                  └────────────────────────────────────────┘
                                     │
      Keystroke Interval ────────────┼─► Dynamic Pitch Shift
      Typing Source (User vs Agent) ─┼─► Oscillator Envelope Morphing
      Bytes-per-millisecond ─────────┼─► Filter Cutoff & Decay Modulation
                                     ▼
                  ┌────────────────────────────────────────┐
                  │       ACOUSTIC SYNTHESIZED SOUND       │
                  └────────────────────────────────────────┘
```

## 2. Key Elements

1.  **Typing Speed (WPM) Modulation:**
    *   The sound engine measures the millisecond delay between incoming keypresses.
    *   As you type faster, the synthesizer's pitch increases slightly (e.g., from a deep `C3` to a tight `E3`) and the note decay shortens. This creates a tactile sense of "acoustic acceleration" and momentum.
2.  **User vs. Agent Distinction:**
    *   **User typing:** Produces deep, low-latency, warm mechanical clicks (synthesized using a square wave with a bandpass filter and a sharp amplitude envelope).
    *   **Claude output stream:** When Claude is streaming stdout at hundreds of characters per second, playing standard clicks turns into noisy static. Instead, the synth morphs into a high-frequency, cascading cybernetic stream (using a triangle wave with resonant filters) that sounds like a retro mainframe dumping data, modulating in pitch based on the volume of bytes flowing per millisecond.
3.  **Haptic/Visual Synchronization:**
    *   Integrates with the **Working LED** and the active terminal's visual scanlines, causing subtle, high-frequency brightness glitches that pulse in exact phase with the synthesized sound peaks.

## 3. Technology & Integration

*   **Implementation:** Pure client-side JavaScript inside `src/renderer/modules/sound.js` using the HTML5 `AudioContext` API.
*   **Performance:** Consumes nearly 0% CPU. No external processes or files needed—completely local, offline, and zero-token.
