# Claude Code Notification hook (Windows side).
# Mirrors hooks/notification.sh: when Claude needs the user's attention
# (permission prompt, idle prompt, ...), drop a small file the
# streamdeck-claude plugin polls to flip the slot to the "awaiting" state.
#
# Wired up via: %USERPROFILE%\.claude\settings.json -> hooks.Notification
# Install with: pnpm install:hook:windows  (scripts/install-hook-windows.sh)

$ErrorActionPreference = 'SilentlyContinue'

# Force UTF-8 on stdin — without this, `[Console]::In.ReadToEnd()` returns
# empty when this script is launched via `powershell.exe -File ...`.
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

$payload = [Console]::In.ReadToEnd()

$sessionId = $null
if ($payload) {
    try {
        $obj = $payload | ConvertFrom-Json
        $sessionId = $obj.session_id
    } catch {
        $sessionId = $null
    }
}

if ($sessionId) {
    $sessionsDir = Join-Path $env:USERPROFILE '.claude\sessions'
    if (-not (Test-Path $sessionsDir)) {
        New-Item -ItemType Directory -Force -Path $sessionsDir | Out-Null
    }
    $notifyFile = Join-Path $sessionsDir ("{0}.notify.json" -f $sessionId)
    $tsMs = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    $json = '{"sessionId":"' + $sessionId + '","reason":"awaiting","mtime":' + $tsMs + '}'
    [System.IO.File]::WriteAllText($notifyFile, $json)
}

# Pass-through response — let other Notification hooks do their thing.
Write-Output '{}'
