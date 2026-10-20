@echo off
rem ===========================================================================
rem LunaCore - start this PC as a Luna host (docs/REMOTE_HOST_PLAN.md)
rem ---------------------------------------------------------------------------
rem Runs the installed or portable LunaCore.exe headless: tray icon only, and
rem this PC becomes the host the phone preselects. No admin rights, no Node.
rem If the HUD already runs, it switches into host mode (single instance).
rem Looks for, in order: %LUNACORE_EXE%, a portable LunaCore*.exe next to this
rem script, the per-user install, the per-machine install.
rem ===========================================================================
setlocal

set "EXE="
if defined LUNACORE_EXE if exist "%LUNACORE_EXE%" set "EXE=%LUNACORE_EXE%"
if not defined EXE for %%F in ("%~dp0LunaCore*.exe") do set "EXE=%%~fF"
if not defined EXE if exist "%LOCALAPPDATA%\Programs\LunaCore\LunaCore.exe" set "EXE=%LOCALAPPDATA%\Programs\LunaCore\LunaCore.exe"
if not defined EXE if exist "%ProgramFiles%\LunaCore\LunaCore.exe" set "EXE=%ProgramFiles%\LunaCore\LunaCore.exe"

if not defined EXE (
  echo LunaCore.exe not found. Install LunaCore, put this script next to the
  echo portable LunaCore.exe, or set LUNACORE_EXE to its full path.
  pause
  exit /b 1
)

start "" "%EXE%" --host --make-default
endlocal
