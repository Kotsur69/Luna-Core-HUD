# ============================================================================
# LunaCore - GLM runner (Windows PowerShell)
# ----------------------------------------------------------------------------
# Starts the ordinary Claude Code CLI against the GLM endpoint. Everything that
# defines capability - plugins, skills, agents, hooks, MCP servers, CLAUDE.md -
# comes from the shared ~/.claude, untouched. Only the model route differs.
#
# Unlike the bash twin, a .ps1 runs INSIDE the calling shell, so the overrides
# would outlive the session. Hence the Save/Restore pair: the shell you started
# from is handed back exactly as it was, proxy settings and all.
#
#   .\scripts\claude-glm.ps1                 # interactive session
#   .\scripts\claude-glm.ps1 -p "2 + 2"      # one-shot
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
    Set-LunaEnv glm
    # Write-Host, not Write-Output: the banner must not land in the pipeline
    # when the session is used as `.\claude-glm.ps1 -p "..." | ConvertFrom-Json`.
    Write-Host ("luna: runner=glm model={0} endpoint={1}" -f $env:ANTHROPIC_MODEL, $env:ANTHROPIC_BASE_URL) -ForegroundColor DarkGray
    & claude @ClaudeArgs
    if ($null -ne $LASTEXITCODE) { $script:LunaExit = $LASTEXITCODE } else { $script:LunaExit = 0 }
} finally {
    Restore-LunaEnv $snapshot
}
exit $script:LunaExit
