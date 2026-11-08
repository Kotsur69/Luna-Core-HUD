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
#
# Failure contract: any error (compile, missing endpoint, COM HRESULT) prints
# {"error": "<message>"} and exits 1, so src/media.js can log WHY instead of
# seeing an empty stdout it cannot tell apart from a timeout.
#
# Speed: Add-Type compiles C# with csc.exe on every run (~2-3 s on a slow
# laptop, on top of a powershell.exe start that can itself take 5 s there).
# The compiled interop is cached as a DLL in %TEMP%\LunaCore, keyed by a hash
# of the C# source, so later runs only load it. Any cache problem (locked or
# corrupt file, blocked write) falls back to the plain in-memory compile.
# ============================================================================

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('get', 'set', 'mute')]
  [string]$Action,
  [int]$Level = -1
)

$ErrorActionPreference = 'Stop'

$LunaAudioSource = @'
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
    // eRender + eConsole: the endpoint Windows calls the "Default Device" (Sound
    // settings, taskbar volume flyout, keyboard mute key). Laptops expose
    // several render endpoints (speakers, HDMI, Bluetooth, Realtek + Intel
    // SST), so this must follow the default role, never an enumerated index.
    Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(/*eRender*/ 0, /*eConsole*/ 0, out dev));
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

function Import-LunaAudio {
  if ('LunaAudio' -as [type]) { return }
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($LunaAudioSource))
    $hash = -join ($bytes[0..7] | ForEach-Object { $_.ToString('x2') })
    $dir = Join-Path ([IO.Path]::GetTempPath()) 'LunaCore'
    $dll = Join-Path $dir "LunaAudio-$hash.dll"
    if (-not (Test-Path -LiteralPath $dll)) {
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      # Compile to a unique name, then move into place: two concurrent runs
      # never write the same file, and a run killed mid-compile leaves only an
      # orphaned temp file, never a truncated cache entry.
      $tmp = Join-Path $dir ("LunaAudio-$hash." + [Guid]::NewGuid().ToString('N') + '.tmp.dll')
      Add-Type -TypeDefinition $LunaAudioSource -OutputAssembly $tmp
      try {
        Move-Item -LiteralPath $tmp -Destination $dll
      } catch {
        # Another run won the race - its copy is identical, drop ours.
        Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
      }
    }
    Add-Type -LiteralPath $dll
  } catch {
    # Cache unusable - fall through to the in-memory compile below.
  }
  if (-not ('LunaAudio' -as [type])) {
    Add-Type -TypeDefinition $LunaAudioSource
  }
}

function WriteState() {
  $level = [int][Math]::Round((([LunaAudio]::GetVolume()) * 100))
  $muted = [LunaAudio]::GetMute()
  [pscustomobject]@{ level = $level; muted = [bool]$muted } | ConvertTo-Json -Compress
}

try {
  Import-LunaAudio
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
  # Report the failure on stdout as JSON (one line, nothing else printed) so
  # src/media.js can surface the reason; exit 1 marks it as a failed run.
  $message = [string]$_.Exception.Message
  if (-not $message) { $message = [string]$_ }
  [pscustomobject]@{ error = $message.Trim() } | ConvertTo-Json -Compress
  exit 1
}
