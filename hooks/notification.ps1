# Claude Code hook bridge for the streamdeck-claude plugin (Windows side).
# Mirrors hooks/notification.sh — same script handles three events, routed by
# `hook_event_name` (and, for tool events, `tool_name`):
#
#   Notification                       -> drop  <sessionId>.notify.json
#   PreToolUse  matcher=ExitPlanMode   -> drop  <sessionId>.plan.json
#   PostToolUse matcher=ExitPlanMode   -> rm    <sessionId>.plan.json
#
# Wired up via %USERPROFILE%\.claude\settings.json. Install with:
#   pnpm install:hook:windows  (scripts/install-hook-windows.sh)

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

if ($sessionId) {
    $sessionsDir = Join-Path $env:USERPROFILE '.claude\sessions'
    if (-not (Test-Path $sessionsDir)) {
        New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null
    }
    $tsMs = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())

    switch ($event) {
        'Notification' {
            $notifyFile = Join-Path $sessionsDir ("{0}.notify.json" -f $sessionId)
            $json = '{"sessionId":"' + $sessionId + '","reason":"awaiting","mtime":' + $tsMs + '}'
            [System.IO.File]::WriteAllText($notifyFile, $json)
        }
        'PreToolUse' {
            if ($toolName -eq 'ExitPlanMode') {
                $planFile = Join-Path $sessionsDir ("{0}.plan.json" -f $sessionId)
                $json = '{"sessionId":"' + $sessionId + '","reason":"plan","mtime":' + $tsMs + '}'
                [System.IO.File]::WriteAllText($planFile, $json)
            }
        }
        'PostToolUse' {
            if ($toolName -eq 'ExitPlanMode') {
                $planFile = Join-Path $sessionsDir ("{0}.plan.json" -f $sessionId)
                if (Test-Path $planFile) { Remove-Item -Force $planFile }
            }
        }
    }
}

Write-Output '{}'
