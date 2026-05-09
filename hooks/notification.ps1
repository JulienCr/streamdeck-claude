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
if ($payload) {
    try {
        $obj       = $payload | ConvertFrom-Json
        $sessionId = $obj.session_id
        $eventName = $obj.hook_event_name
        $toolName  = $obj.tool_name
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

# SessionStart: truncate before appending the new entry.
if ($eventName -eq 'SessionStart') {
    Set-Content -Path $target -Value '' -NoNewline -Encoding utf8
}

$ts = [int64](([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds())

# Use ConvertTo-Json so embedded quotes/backslashes in tool names get escaped
# correctly — string interpolation would corrupt the line.
$entry = if ($toolName) {
    [ordered]@{ ts = $ts; event = $eventName; tool = $toolName }
} else {
    [ordered]@{ ts = $ts; event = $eventName }
}
$line = $entry | ConvertTo-Json -Compress

Add-Content -Path $target -Value $line -Encoding utf8

Write-Output '{}'
