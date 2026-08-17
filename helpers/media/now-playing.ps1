# ============================================================================
# LunaCore - Media Deck: now-playing metadata + transport commands
# ----------------------------------------------------------------------------
# Wraps Windows' own GlobalSystemMediaTransportControlsSessionManager (the API
# behind the Win11 media flyout / lock-screen widget) - always targets
# whatever Windows itself considers the CURRENT session, not "whatever app has
# focus". WinRT's async methods need the standard Await() helper since
# PowerShell has no native await; -Action selects one read (get) or one of the
# five transport commands. Every path prints compact JSON or nothing - never
# a bare error to stdout - so src/media.js can always either JSON.parse the
# output or safely treat empty output as "nothing to report" (see gpu.js's
# PS_SCRIPT for the same silent-no-op contract).
# ============================================================================

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'play', 'pause', 'toggle', 'next', 'prev')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

function Await($WinRtTask, $ResultType) {
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $asTaskGeneric = $asTask.MakeGenericMethod($ResultType)
  $netTask = $asTaskGeneric.Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

function WriteOk($ok) {
  [pscustomobject]@{ ok = [bool]$ok } | ConvertTo-Json -Compress
}

try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime] | Out-Null

  $manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $session = if ($manager) { $manager.GetCurrentSession() } else { $null }

  if (-not $session) {
    if ($Action -ne 'get') { WriteOk $false }
    exit
  }

  switch ($Action) {
    'get' {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $playback = $session.GetPlaybackInfo()
      $isPlaying = $playback.PlaybackStatus -eq [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackStatus]::Playing
      [pscustomobject]@{
        title     = $props.Title
        artist    = $props.Artist
        appId     = $session.SourceAppUserModelId
        isPlaying = [bool]$isPlaying
      } | ConvertTo-Json -Compress
    }
    'play'   { WriteOk (Await ($session.TryPlayAsync()) ([bool])) }
    'pause'  { WriteOk (Await ($session.TryPauseAsync()) ([bool])) }
    'toggle' { WriteOk (Await ($session.TryTogglePlayPauseAsync()) ([bool])) }
    'next'   { WriteOk (Await ($session.TrySkipNextAsync()) ([bool])) }
    'prev'   { WriteOk (Await ($session.TrySkipPreviousAsync()) ([bool])) }
  }
} catch {
  if ($Action -ne 'get') { WriteOk $false }
}
