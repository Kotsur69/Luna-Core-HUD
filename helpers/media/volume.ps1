# ============================================================================
# LunaCore - Media Deck: system master volume + mute
# ----------------------------------------------------------------------------
# GSMTC (now-playing.ps1) has no concept of system volume - that's Core
# Audio, a separate OS subsystem, reached here via the standard
# IAudioEndpointVolume COM interop snippet (default render endpoint's master
# volume/mute). -Level is a plain integer 0-100 (src/media.js clamps it
# before this ever runs; clamped again here defensively) and is never
# string-interpolated into the C# source, only passed as a bound parameter.
# Every action prints the resulting {level, muted} - set/mute double as a
# fresh read so the caller never needs a second round trip.
# ============================================================================

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'set', 'mute')]
  [string]$Action,
  [int]$Level = -1
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int NotImpl1();
  int NotImpl2();
  int GetChannelCount();
  int SetMasterVolumeLevel(float fLevel, Guid pguidEventContext);
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int GetMasterVolumeLevel(out float pfLevel);
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int SetChannelVolumeLevel(uint dwChannel, float fLevel, Guid pguidEventContext);
  int SetChannelVolumeLevelScalar(uint dwChannel, float fLevel, Guid pguidEventContext);
  int GetChannelVolumeLevel(uint dwChannel, out float pfLevel);
  int GetChannelVolumeLevelScalar(uint dwChannel, out float pfLevel);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public class LunaAudio {
  static IAudioEndpointVolume Endpoint() {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(/*eRender*/ 0, /*eMultimedia*/ 1, out dev));
    var epvid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume epv;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, /*CLSCTX_ALL*/ 23, 0, out epv));
    return epv;
  }

  public static float GetVolume() {
    float v;
    Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v));
    return v;
  }

  public static void SetVolume(float v) {
    Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(v, Guid.Empty));
  }

  public static bool GetMute() {
    bool m;
    Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m));
    return m;
  }

  public static void SetMute(bool m) {
    Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, Guid.Empty));
  }
}
'@

function WriteState() {
  $level = [int][Math]::Round((([LunaAudio]::GetVolume()) * 100))
  $muted = [LunaAudio]::GetMute()
  [pscustomobject]@{ level = $level; muted = [bool]$muted } | ConvertTo-Json -Compress
}

try {
  switch ($Action) {
    'get' {
      WriteState
    }
    'set' {
      $clamped = [Math]::Max(0, [Math]::Min(100, $Level))
      [LunaAudio]::SetVolume([float]($clamped / 100.0))
      WriteState
    }
    'mute' {
      [LunaAudio]::SetMute(-not [LunaAudio]::GetMute())
      WriteState
    }
  }
} catch {
  # Silent no-op on failure (missing endpoint, COM error, etc.) - nothing
  # printed, same degrade-gracefully contract as now-playing.ps1.
}
