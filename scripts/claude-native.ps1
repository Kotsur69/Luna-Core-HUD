# ============================================================================
# LunaCore - native Claude runner (Windows PowerShell)
# ----------------------------------------------------------------------------
# Plain `claude`, with one job beyond that: it actively CLEARS every variable
# the GLM runner sets. Without that step, a shell where Set-LunaEnv glm was run
# earlier would keep sending "native" sessions to the proxy - the failure is
# silent, which is exactly why the clear is explicit here.
#
#   .\scripts\claude-native.ps1              # interactive session
#   .\scripts\claude-native.ps1 -p "2 + 2"   # one-shot
# ============================================================================
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $ClaudeArgs
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env-setup.ps1')

if ($null -eq $ClaudeArgs) { $ClaudeArgs = @() }

$snapshot = Save-LunaEnv
try {
    Set-LunaEnv native
    Write-Host 'luna: runner=native model=(account default) endpoint=api.anthropic.com' -ForegroundColor DarkGray
    & claude @ClaudeArgs
    if ($null -ne $LASTEXITCODE) { $script:LunaExit = $LASTEXITCODE } else { $script:LunaExit = 0 }
} finally {
    Restore-LunaEnv $snapshot
}
exit $script:LunaExit
