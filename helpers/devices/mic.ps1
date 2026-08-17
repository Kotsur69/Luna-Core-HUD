# ============================================================================
# LunaCore - Device panel: microphone mute state
# ----------------------------------------------------------------------------
# The same IAudioEndpointVolume COM interop helpers/media/volume.ps1 uses,
# pointed at the default CAPTURE endpoint instead of the render one
# (dataFlow eCapture = 1, role eCommunications = 2 - the endpoint Windows
# itself mutes when you press a headset's mic-mute key).
#
# Why mute and not pnputil-style device disabling: muting is a soft, instantly
# reversible endpoint property that can also be READ BACK, so the toggle in the
# HUD can always show the real state. Disabling a device through pnputil needs
# elevation, survives the app's own lifetime, and has no comparable read - a
# toggle that cannot verify itself would eventually lie about your webcam,
# which is the one thing a privacy control must never do.
# ============================================================================

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'toggle', 'mute', 'unmute')]
  [string]$Action
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

public class LunaMic {
  static IAudioEndpointVolume Endpoint() {
    var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(/*eCapture*/ 1, /*eCommunications*/ 2, out dev));
    var epvid = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume epv;
    Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, /*CLSCTX_ALL*/ 23, 0, out epv));
    return epv;
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
  [pscustomobject]@{ muted = [bool]([LunaMic]::GetMute()); available = $true } | ConvertTo-Json -Compress
}

try {
  switch ($Action) {
    'get' { WriteState }
    'toggle' {
      [LunaMic]::SetMute(-not [LunaMic]::GetMute())
      WriteState
    }
    'mute' {
      [LunaMic]::SetMute($true)
      WriteState
    }
    'unmute' {
      [LunaMic]::SetMute($false)
      WriteState
    }
  }
} catch {
  # No capture endpoint (no microphone at all), or a COM failure. Print
  # nothing: src/devices.js reads empty stdout as "unavailable" and the widget
  # says so, rather than showing a toggle that would do nothing.
}
