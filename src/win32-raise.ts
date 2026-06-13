import { spawnCapture } from "./spawn-capture.js";

/**
 * Add-Type bundle shared by every Win32 window-raise path (Warp, VS Code, …).
 * The guard skips re-Adding when run twice in the same PS host (irrelevant
 * here since each call spawns a fresh process, but cheap insurance).
 *
 * `INPUT` is laid out as a tagged union: the union starts at offset 0 inside
 * `InputUnion` (LayoutKind.Explicit), and the outer struct is Sequential so
 * the type discriminator + union alignment match `sizeof(INPUT)` (40 bytes on
 * x64, 28 on x86 — `Marshal.SizeOf` handles both). `MOUSEINPUT` is wider than
 * `KEYBDINPUT`, so it has to be declared even though only the keyboard variant
 * is used (and only by callers that send keystrokes; raise-only callers ignore
 * `CtrlVk`/`SendInput`).
 */
export const TYPES_GUARD = `if (-not ('W' -as [type])) {
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint t1, uint t2, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint n, INPUT[] inputs, int cb);
  public static void CtrlVk(ushort vk) {
    INPUT[] arr = new INPUT[4];
    arr[0].type = 1; arr[0].u.ki.wVk = 0x11;
    arr[1].type = 1; arr[1].u.ki.wVk = vk;
    arr[2].type = 1; arr[2].u.ki.wVk = vk;    arr[2].u.ki.dwFlags = 2;
    arr[3].type = 1; arr[3].u.ki.wVk = 0x11;  arr[3].u.ki.dwFlags = 2;
    SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
}`;

/**
 * Run a self-contained PowerShell script via `-EncodedCommand` (base64 of
 * UTF-16-LE) rather than `-Command -` via stdin. Stdin mode trips the parser
 * on multi-line here-strings (the Add-Type block), silently swallowing the
 * script. EncodedCommand sidesteps all quoting/parsing.
 *
 * `-OutputFormat Text` + `$ProgressPreference=SilentlyContinue` suppress the
 * CLIXML progress wrapper PS otherwise emits the first time it loads modules —
 * the wrapper would push the "OK" marker off the trailing position callers
 * look for. Success is signalled by a line starting with `OK`.
 * The full stdout is returned in `out` (not just a boolean) so callers can
 * thread the trailing trace into their focus-result `reason` for runtime
 * visibility.
 */
export async function runPowerShell(
  script: string,
  timeoutMs: number,
): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  const wrapped = "$ProgressPreference = 'SilentlyContinue'\n" + script;
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");

  const r = await spawnCapture(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded],
    { timeoutMs },
  );
  if (r.timedOut) return { ok: false, error: "timeout" };
  if (r.err) return { ok: false, error: `spawn: ${r.err}` };
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (r.code !== 0) return { ok: false, error: err || out || `exit-${r.code}` };
  if (out.includes("ERROR:")) return { ok: false, error: out };
  if (/^OK(\s|$)/m.test(out)) return { ok: true, out };
  return { ok: false, error: err ? `stderr: ${err}` : `no-OK-marker: ${out || "(empty)"}` };
}
