# ============================================================================
# LunaCore - dual-runner environment setup (Windows PowerShell)
# ----------------------------------------------------------------------------
# PowerShell twin of scripts/env-setup.sh. Same contract, same .env.luna file,
# same variables - PowerShell is the primary shell on this machine, and there
# is no `source` equivalent that could reuse the bash version.
#
# Environment changes made here are process-wide, so a script that applies them
# pollutes the shell it was run from. Runners therefore wrap the call in
# Save-LunaEnv / Restore-LunaEnv (see scripts/claude-glm.ps1).
#
# Usage:
#   . .\scripts\env-setup.ps1                       # load the functions
#   Set-LunaEnv glm                                 # apply to this shell
#   Set-LunaEnv native                              # clear back to first-party
#   powershell -File .\scripts\env-setup.ps1 -Check glm
#   powershell -File .\scripts\env-setup.ps1 -Print glm
# ============================================================================

[CmdletBinding()]
param(
    [ValidateSet('glm', 'native')]
    [string] $Check,
    [ValidateSet('glm', 'native')]
    [string] $Print
)

$ErrorActionPreference = 'Stop'

# Repo root resolved from this script, not the caller's location - the runners
# are meant to work from any subdirectory.
$script:LunaRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrEmpty($env:LUNA_ENV_FILE)) {
    $script:LunaEnvFile = Join-Path $script:LunaRoot '.env.luna'
} else {
    $script:LunaEnvFile = $env:LUNA_ENV_FILE
}

# Every variable this script owns. Listed once so "apply", "clear" and the
# save/restore snapshot cannot drift apart - a variable added to one and
# forgotten in another is how a native session ends up talking to a proxy.
$script:LunaOwnedVars = @(
    'ANTHROPIC_BASE_URL'
    'ANTHROPIC_AUTH_TOKEN'
    'ANTHROPIC_API_KEY'
    'ANTHROPIC_MODEL'
    'ANTHROPIC_SMALL_FAST_MODEL'
    'ANTHROPIC_DEFAULT_OPUS_MODEL'
    'ANTHROPIC_DEFAULT_SONNET_MODEL'
    'ANTHROPIC_DEFAULT_HAIKU_MODEL'
    'ANTHROPIC_DEFAULT_FABLE_MODEL'
    'CLAUDE_CODE_SUBAGENT_MODEL'
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
    'API_TIMEOUT_MS'
    'MCP_TIMEOUT'
    'MCP_TOOL_TIMEOUT'
    'LUNA_RUNNER'
)

# Sets or removes one process environment variable. An empty value removes it:
# for credentials, "absent" and "empty string" are not the same to every SDK,
# and absent is the one that behaves predictably.
function Set-LunaEnvVar {
    param(
        [Parameter(Mandatory)][string] $Name,
        [string] $Value
    )
    if ([string]::IsNullOrEmpty($Value)) {
        if (Test-Path -LiteralPath "Env:\$Name") { Remove-Item -LiteralPath "Env:\$Name" }
    } else {
        Set-Item -LiteralPath "Env:\$Name" -Value $Value
    }
}

<#
.SYNOPSIS
Captures the current value of every runner-owned variable, so a runner can
restore the caller's shell after the CLI exits.
#>
function Save-LunaEnv {
    $snapshot = @{}
    foreach ($name in $script:LunaOwnedVars) {
        $snapshot[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    }
    return $snapshot
}

function Restore-LunaEnv {
    param([Parameter(Mandatory)][hashtable] $Snapshot)
    foreach ($name in $script:LunaOwnedVars) {
        Set-LunaEnvVar -Name $name -Value $Snapshot[$name]
    }
}

# Reads .env.luna into a hashtable. Tolerates CRLF, blank lines, # comments and
# an `export KEY=` prefix (the file is shared with the bash runner). Only the
# LUNA_GLM_* namespace is honoured, so a stray line cannot set arbitrary env.
function Read-LunaEnvFile {
    param([string] $Path)
    $config = @{}
    if (-not (Test-Path -LiteralPath $Path)) { return $config }
    foreach ($raw in (Get-Content -LiteralPath $Path)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7) }
        $split = $line.IndexOf('=')
        if ($split -lt 1) { continue }
        $key = $line.Substring(0, $split).Trim()
        if (-not $key.StartsWith('LUNA_GLM_')) { continue }
        $value = $line.Substring($split + 1).Trim()
        if ($value.Length -ge 2 -and $value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $config[$key] = $value
    }
    return $config
}

# Fills only what the file left blank - an explicit value always wins, which is
# what makes `custom` (and pinning a different variant) work without a second
# code path.
function Set-LunaDefault {
    param([hashtable] $Config, [string] $Key, [string] $Value)
    if (-not $Config.ContainsKey($Key) -or [string]::IsNullOrEmpty($Config[$Key])) {
        $Config[$Key] = $Value
    }
}

function Resolve-LunaGlmConfig {
    param([hashtable] $Config)

    $provider = $Config['LUNA_GLM_PROVIDER']
    if ([string]::IsNullOrEmpty($provider)) { $provider = 'zai' }

    switch ($provider) {
        'zai' {
            Set-LunaDefault $Config 'LUNA_GLM_BASE_URL'   'https://api.z.ai/api/anthropic'
            Set-LunaDefault $Config 'LUNA_GLM_MODEL'      'glm-5.3'
            Set-LunaDefault $Config 'LUNA_GLM_FAST_MODEL' 'glm-5.3-flash'
        }
        'openrouter' {
            Set-LunaDefault $Config 'LUNA_GLM_BASE_URL'   'https://openrouter.ai/api'
            Set-LunaDefault $Config 'LUNA_GLM_MODEL'      'z-ai/glm-5.3'
            Set-LunaDefault $Config 'LUNA_GLM_FAST_MODEL' 'z-ai/glm-5.3-flash'
        }
        'custom' { }
        default { throw "env-setup: unknown LUNA_GLM_PROVIDER '$provider' (expected zai|openrouter|custom)" }
    }

    Set-LunaDefault $Config 'LUNA_GLM_API_TIMEOUT_MS'      '3000000'
    Set-LunaDefault $Config 'LUNA_GLM_MCP_TIMEOUT_MS'      '60000'
    Set-LunaDefault $Config 'LUNA_GLM_MCP_TOOL_TIMEOUT_MS' '120000'
    Set-LunaDefault $Config 'LUNA_GLM_DISABLE_NONESSENTIAL_TRAFFIC' '1'
    # Fast model is optional: without one, cheap internal calls fall back to the
    # main model rather than 404-ing on a slug the provider does not serve.
    Set-LunaDefault $Config 'LUNA_GLM_FAST_MODEL' $Config['LUNA_GLM_MODEL']

    $problems = @()
    if ([string]::IsNullOrEmpty($Config['LUNA_GLM_API_KEY'])) {
        $problems += "LUNA_GLM_API_KEY is empty - set it in $script:LunaEnvFile"
    }
    $baseUrl = $Config['LUNA_GLM_BASE_URL']
    if ([string]::IsNullOrEmpty($baseUrl)) {
        $problems += 'LUNA_GLM_BASE_URL is empty (required for provider custom)'
    } else {
        if (-not ($baseUrl -match '^(https://|http://localhost|http://127\.0\.0\.1)')) {
            $problems += 'LUNA_GLM_BASE_URL should be https:// or a localhost proxy'
        }
        # A trailing slash makes some proxies serve /v1//messages -> 404.
        if ($baseUrl.EndsWith('/')) {
            $problems += 'LUNA_GLM_BASE_URL ends with a slash - drop it, the CLI appends /v1/messages'
        }
    }
    if ([string]::IsNullOrEmpty($Config['LUNA_GLM_MODEL'])) {
        $problems += 'LUNA_GLM_MODEL is empty (required for provider custom)'
    }
    if ($problems.Count -gt 0) {
        throw ("env-setup: invalid GLM configuration:`n  - " + ($problems -join "`n  - "))
    }
    return $Config
}

<#
.SYNOPSIS
Applies the environment for one runner to the current process.
.PARAMETER Runner
'glm' routes through the Anthropic-compatible proxy; 'native' clears every
override so claude falls back to its own first-party credentials.
#>
function Set-LunaEnv {
    param(
        [Parameter(Position = 0)]
        [ValidateSet('glm', 'native')]
        [string] $Runner = 'native'
    )

    foreach ($name in $script:LunaOwnedVars) { Set-LunaEnvVar -Name $name -Value $null }

    if ($Runner -eq 'native') {
        $env:LUNA_RUNNER = 'native'
        return
    }

    $config = Resolve-LunaGlmConfig (Read-LunaEnvFile $script:LunaEnvFile)

    $env:ANTHROPIC_BASE_URL = $config['LUNA_GLM_BASE_URL']
    $env:ANTHROPIC_AUTH_TOKEN = $config['LUNA_GLM_API_KEY']
    # ANTHROPIC_API_KEY stays removed (cleared above): with a Bearer token in
    # play, a lingering x-api-key credential is the classic cause of a 401 that
    # looks like a bad key.

    # Claude Code resolves a model through the alias the caller asked for, so
    # every alias has to be mapped - otherwise a subagent declared as haiku
    # requests a slug the provider does not serve.
    $env:ANTHROPIC_MODEL = $config['LUNA_GLM_MODEL']
    $env:ANTHROPIC_DEFAULT_OPUS_MODEL = $config['LUNA_GLM_MODEL']
    $env:ANTHROPIC_DEFAULT_SONNET_MODEL = $config['LUNA_GLM_MODEL']
    $env:ANTHROPIC_DEFAULT_FABLE_MODEL = $config['LUNA_GLM_MODEL']
    $env:ANTHROPIC_DEFAULT_HAIKU_MODEL = $config['LUNA_GLM_FAST_MODEL']
    $env:ANTHROPIC_SMALL_FAST_MODEL = $config['LUNA_GLM_FAST_MODEL']
    $env:CLAUDE_CODE_SUBAGENT_MODEL = $config['LUNA_GLM_MODEL']

    $env:API_TIMEOUT_MS = $config['LUNA_GLM_API_TIMEOUT_MS']
    $env:MCP_TIMEOUT = $config['LUNA_GLM_MCP_TIMEOUT_MS']
    $env:MCP_TOOL_TIMEOUT = $config['LUNA_GLM_MCP_TOOL_TIMEOUT_MS']
    if ($config['LUNA_GLM_DISABLE_NONESSENTIAL_TRAFFIC'] -eq '1') {
        $env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
    }

    $env:LUNA_RUNNER = 'glm'
}

# Falls back to a placeholder when a variable is unset. PowerShell 5.1 has no
# null-coalescing operator, so this stands in for it.
function Get-LunaOrDefault {
    param([string] $Value, [string] $Default)
    if ([string]::IsNullOrEmpty($Value)) { return $Default }
    return $Value
}

# Masked summary. Never prints the token - this output ends up in bug reports.
function Show-LunaEnv {
    $token = $env:ANTHROPIC_AUTH_TOKEN
    if ([string]::IsNullOrEmpty($token)) {
        $masked = '(unset)'
    } elseif ($token.Length -gt 8) {
        $masked = '{0}...{1} ({2} chars)' -f $token.Substring(0, 4), $token.Substring($token.Length - 4), $token.Length
    } else {
        $masked = "(set, $($token.Length) chars)"
    }

    $configDir = Get-LunaOrDefault $env:CLAUDE_CONFIG_DIR "$env:USERPROFILE\.claude (shared)"

    'runner               : {0}' -f (Get-LunaOrDefault $env:LUNA_RUNNER 'native')
    'ANTHROPIC_BASE_URL   : {0}' -f (Get-LunaOrDefault $env:ANTHROPIC_BASE_URL '(unset - first-party Anthropic)')
    "ANTHROPIC_AUTH_TOKEN : $masked"
    'ANTHROPIC_API_KEY    : {0}' -f (Get-LunaOrDefault $env:ANTHROPIC_API_KEY '(unset)')
    'model opus/sonnet    : {0}' -f (Get-LunaOrDefault $env:ANTHROPIC_MODEL '(CLI default)')
    'model haiku/fast     : {0}' -f (Get-LunaOrDefault $env:ANTHROPIC_SMALL_FAST_MODEL '(CLI default)')
    'subagent model       : {0}' -f (Get-LunaOrDefault $env:CLAUDE_CODE_SUBAGENT_MODEL '(inherit)')
    'API_TIMEOUT_MS       : {0}' -f (Get-LunaOrDefault $env:API_TIMEOUT_MS '(CLI default)')
    "config dir           : $configDir"
}

# --- Dispatch ---------------------------------------------------------------
# Dot-sourced with no switch: just publish the functions. With -Check / -Print:
# behave like a command-line tool and leave a non-zero exit code on failure.
if ($Check) {
    try {
        Set-LunaEnv $Check
        Write-Output "env-setup: $Check configuration OK"
    } catch {
        Write-Error $_.Exception.Message -ErrorAction Continue
        exit 1
    }
} elseif ($Print) {
    try {
        Set-LunaEnv $Print
        Show-LunaEnv
    } catch {
        Write-Error $_.Exception.Message -ErrorAction Continue
        exit 1
    }
}
