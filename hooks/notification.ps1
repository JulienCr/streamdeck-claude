# Claude Code hook bridge for the streamdeck-claude plugin (Windows side).
# Mirrors hooks/notification.sh — same script handles every event listed in
# the sibling hooks/events.json file. Each rule routes a hook event (and
# optional tool_name) to either:
#   - drop  <sessionId>.<file>.json (awaiting flag, with reason+mtime)
#   - rm    <sessionId>.<file>.json (clear flag)
#
# Wired up via %USERPROFILE%\.claude\settings.json. Install with:
#   pnpm install:hook:windows  (scripts/install-hook.sh --target=windows)
# The install step copies BOTH this .ps1 and events.json into
# %USERPROFILE%\.claude\hooks\, so the routing table is found at runtime.

$ErrorActionPreference = 'SilentlyContinue'

# Force UTF-8 on stdin — without this, `[Console]::In.ReadToEnd()` returns
# empty when this script is launched via `powershell.exe -File ...`.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$payload = [Console]::In.ReadToEnd()

$sessionId = $null
$event     = $null
$toolName  = $null
if ($payload) {
    try {
        $obj       = $payload | ConvertFrom-Json
        $sessionId = $obj.session_id
        $event     = $obj.hook_event_name
        $toolName  = $obj.tool_name
    } catch {
        $sessionId = $null
    }
}

if (-not $sessionId) { Write-Output '{}'; exit }

$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$eventsFile = Join-Path $scriptDir 'events.json'
if (-not (Test-Path $eventsFile)) { Write-Output '{}'; exit }

try {
    $rules = (Get-Content -Raw $eventsFile | ConvertFrom-Json).events
} catch {
    Write-Output '{}'; exit
}

# Find the first rule whose event matches and (if specified) tool_name matches.
$rule = $rules | Where-Object {
    $_.event -eq $event -and (-not $_.tool_name -or $_.tool_name -eq $toolName)
} | Select-Object -First 1

if (-not $rule) { Write-Output '{}'; exit }

$sessionsDir = Join-Path $env:USERPROFILE '.claude\sessions'
if (-not (Test-Path $sessionsDir)) {
    New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null
}
$target = Join-Path $sessionsDir ("{0}.{1}.json" -f $sessionId, $rule.file)

switch ($rule.action) {
    'drop' {
        $tsMs = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
        $json = '{"sessionId":"' + $sessionId + '","reason":"' + $rule.reason + '","mtime":' + $tsMs + '}'
        [System.IO.File]::WriteAllText($target, $json)
    }
    'rm' {
        if (Test-Path $target) { Remove-Item -Force $target }
    }
}

Write-Output '{}'
