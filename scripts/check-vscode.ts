/**
 * Sanity-check the VS Code focus path: enumerate VS Code windows on this OS and
 * print which one would be chosen for a given cwd.
 *
 *   pnpm check:vscode "/home/julien/dev/foo"        # defaults origin=wsl
 *   pnpm check:vscode "D:\\dev\\foo" windows
 */
import { platform } from "node:os";
import { pickBestWindow } from "../src/vscode-window-match.js";
import type { SessionOrigin } from "../src/sessions.js";

async function main() {
  const cwd = process.argv[2];
  const originArg = process.argv[3];
  if (!cwd) {
    console.error('usage: pnpm check:vscode "<cwd>" [wsl|windows]');
    process.exit(2);
  }
  if (originArg !== undefined && originArg !== "wsl" && originArg !== "windows") {
    console.error(`origin must be "wsl" or "windows" (got "${originArg}")`);
    process.exit(2);
  }
  const origin: SessionOrigin = originArg === "windows" ? "windows" : "wsl";

  const titles = await enumerate();
  console.log(`platform=${platform()} origin=${origin} windows=${titles.length}`);
  for (const t of titles) console.log(`  • ${t}`);

  const best = pickBestWindow(cwd, titles.map((title) => ({ title })), origin);
  console.log(best ? `\nmatch → "${best.title}"` : "\nmatch → (none)");
}

/** Enumerate VS Code window titles, OS-dispatched. This is a titles-only
 *  simplification of the runtime backends (no HWND/sentinel parsing); it shares
 *  the PowerShell/AppleScript window-selection logic, not the output format. */
async function enumerate(): Promise<string[]> {
  if (platform() === "win32") {
    const { execFileSync } = await import("node:child_process");
    const ps = `Get-Process Code,'Code - Insiders' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } |
      ForEach-Object { $_.MainWindowTitle }`;
    try {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
        encoding: "utf8",
      });
      return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      console.error(`powershell failed: ${(e.stderr || e.message || String(err)).trim()}`);
      return [];
    }
  }
  if (platform() === "darwin") {
    const { execFileSync } = await import("node:child_process");
    const osa = `tell application "System Events"
      if not (exists process "Code") then return ""
      set out to ""
      repeat with w in windows of process "Code"
        set out to out & (name of w) & linefeed
      end repeat
      return out
    end tell`;
    try {
      const out = execFileSync("/usr/bin/osascript", ["-e", osa], { encoding: "utf8" });
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      console.error(`osascript failed: ${(e.stderr || e.message || String(err)).trim()}`);
      return [];
    }
  }
  console.error(`enumeration not supported on ${platform()}`);
  return [];
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
