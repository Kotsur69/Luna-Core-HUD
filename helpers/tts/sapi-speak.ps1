# ============================================================================
# LunaCore - offline TTS via Windows SAPI (System.Speech), §11.2
# ----------------------------------------------------------------------------
# Reads the text to speak from -TextFile (never from a command-line argument -
# src/tts.js writes Claude's own output to a temp file precisely so nothing in
# it - quotes, backticks, $vars - can be interpreted as a PowerShell token)
# and synthesizes it to -WavFile. Fully offline: System.Speech ships with
# Windows, no network call, no external dependency.
# ============================================================================

param(
  [Parameter(Mandatory = $true)][string]$TextFile,
  [Parameter(Mandatory = $true)][string]$WavFile,
  [int]$Rate = 0
)

Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = $Rate
$synth.SetOutputToWaveFile($WavFile)

$text = Get-Content -LiteralPath $TextFile -Raw -Encoding UTF8
$synth.Speak($text)

$synth.Dispose()
