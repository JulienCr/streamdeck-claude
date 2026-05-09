# Enumerates every visible Warp window with HWND, owning PID, and title.
# Invoked by probe.sh via powershell.exe; outputs one window per line as TSV:
#   <hwnd>\t<pid>\t<title>
# A trailing summary line goes to stderr.

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
'@ | Out-Null

$warpPids = @(Get-Process -Name warp -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
if ($warpPids.Count -eq 0) {
  [Console]::Error.WriteLine('warp not running')
  exit 2
}

$rows = New-Object System.Collections.Generic.List[Object]
$cb = [W+EnumWindowsProc]{
  param($h, $l)
  if (-not [W]::IsWindowVisible($h)) { return $true }
  $pidOut = 0
  [void][W]::GetWindowThreadProcessId($h, [ref]$pidOut)
  if ($warpPids -notcontains $pidOut) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][W]::GetWindowTextW($h, $sb, 512)
  $title = $sb.ToString()
  if ($title.Length -eq 0) { return $true }
  $rows.Add([PSCustomObject]@{ HWND=$h; PID=$pidOut; Title=$title })
  return $true
}
[void][W]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($r in $rows) { "$($r.HWND)`t$($r.PID)`t$($r.Title)" }

$distinctPids = ($rows | Select-Object -ExpandProperty PID -Unique).Count
[Console]::Error.WriteLine("warp_windows=$($rows.Count) distinct_pids=$distinctPids")
