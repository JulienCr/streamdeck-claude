# Claude Code hook bridge for the streamdeck-claude plugin (Windows side).
# Mirrors hooks/notification.sh — appends one JSON line per hook fire to
# <sid>.events.ndjson. The plugin replays the log through a state machine
# in src/session-events.ts to derive the icon state.
#
# Wired up via %USERPROFILE%\.claude\settings.json. Install with:
#   pnpm install:hook:windows  (scripts/install-hook.sh --target=windows)
# The install step does NOT copy this file — it registers a hook command
# that invokes this .ps1 directly from the repo over the
# `\\wsl.localhost\<distro>\…` UNC path.

$ErrorActionPreference = 'SilentlyContinue'

# Force UTF-8 on stdin — without this, `[Console]::In.ReadToEnd()` returns
# empty when this script is launched via `powershell.exe -File ...`.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$payload = [Console]::In.ReadToEnd()

$sessionId = $null
$eventName = $null
$toolName  = $null
$notifType = $null
$source    = $null
$errorType = $null
$agentId   = $null
$agentType = $null
$mode      = $null
if ($payload) {
    try {
        $obj       = $payload | ConvertFrom-Json
        $sessionId = $obj.session_id
        $eventName = $obj.hook_event_name
        $toolName  = $obj.tool_name
        # notification_type is set by CC on Notification events
        # (permission_prompt, idle_prompt, elicitation_dialog, auth_success).
        $notifType = $obj.notification_type
        # source is set by CC on SessionStart (startup/resume/clear/compact/fork).
        $source    = $obj.source
        # error_type is set by CC on StopFailure (rate_limit, overloaded, server_error, ...).
        $errorType = $obj.error_type
        # agent_id/agent_type are set when this event fired inside a subagent
        # (logged under the parent session_id regardless). permission_mode
        # rides every event.
        $agentId   = $obj.agent_id
        $agentType = $obj.agent_type
        $mode      = $obj.permission_mode
    } catch {
        $sessionId = $null
    }
}

if (-not $sessionId -or -not $eventName) { Write-Output '{}'; exit }

$sessionsDir = Join-Path $env:USERPROFILE '.claude\sessions'
if (-not (Test-Path $sessionsDir)) {
    New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null
}
$target = Join-Path $sessionsDir "$sessionId.events.ndjson"

# SessionEnd: drop the log entirely.
if ($eventName -eq 'SessionEnd') {
    Remove-Item -Path $target -Force -ErrorAction SilentlyContinue
    Write-Output '{}'
    exit
}

# SessionStart: truncate before appending the new entry, except source=compact
# (mid-turn auto-compaction) — wiping the log would reset inTurn/awaiting state.
if ($eventName -eq 'SessionStart' -and $source -ne 'compact') {
    Set-Content -Path $target -Value '' -NoNewline -Encoding utf8
}

$ts = [int64](([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds())

# For TodoWrite, snapshot the list's statuses so the plugin can draw a
# progress column. [string[]] cast preserves array shape for 0/1-element
# lists through ConvertTo-Json on PowerShell 5.1.
$todos = $null
if ($toolName -eq 'TodoWrite') {
    try {
        $todos = [string[]]@($obj.tool_input.todos | ForEach-Object { $_.status })
    } catch {
        $todos = [string[]]@()
    }
}

# background_tasks is CC's authoritative list of still-running background work
# — count entries with status "running", only when Stop/SubagentStop actually
# carries the field (absent property ⇒ left $null, dropped from the line).
$bgRunning = $null
if ($eventName -eq 'Stop' -or $eventName -eq 'SubagentStop') {
    if ($obj.PSObject.Properties.Name -contains 'background_tasks') {
        $bgRunning = @($obj.background_tasks | Where-Object { $_.status -eq 'running' }).Count
    }
}

# Use ConvertTo-Json so embedded quotes/backslashes in tool names get escaped
# correctly — string interpolation would corrupt the line.
$entry = [ordered]@{ ts = $ts; event = $eventName }
if ($toolName)             { $entry.tool       = $toolName }
if ($notifType)            { $entry.notifType  = $notifType }
if ($source)               { $entry.source     = $source }
if ($errorType)            { $entry.errorType  = $errorType }
if ($agentId)              { $entry.agentId    = $agentId }
if ($agentType)            { $entry.agentType  = $agentType }
if ($mode)                 { $entry.mode       = $mode }
if ($null -ne $todos)      { $entry.todos      = $todos }
if ($null -ne $bgRunning)  { $entry.bgRunning  = $bgRunning }
$line = $entry | ConvertTo-Json -Compress

Add-Content -Path $target -Value $line -Encoding utf8

Write-Output '{}'
