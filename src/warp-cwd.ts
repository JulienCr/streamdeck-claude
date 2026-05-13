import { spawn } from "node:child_process";

/**
 * Translates Warp-stored cwds into a form comparable to `SessionInfo.cwd`.
 *
 * Mac stores POSIX paths already — pass-through. Warp Windows stores cwds
 * in Windows form even for WSL-hosted shells:
 *   - `\\wsl.localhost\<distro>\<path>` (the modern UNC form)
 *   - `\\WSL$\<distro>\<path>` (the legacy UNC form Warp still emits)
 *   - `<X>:\<path>` when the user has mapped a drive letter at a WSL share
 * Each of these maps back to a Linux path `/<path>`, which is what a
 * WSL-origin Claude Code session reports as its cwd. Drive mappings are
 * discovered once at init via PowerShell `Get-PSDrive` — we cache the set
 * of letters known to point at a WSL share.
 *
 * Anything we can't translate (a real `D:\dev\foo`, a network share that
 * isn't WSL, …) is returned unchanged so the caller's scoring can still
 * exact-match Windows-origin sessions.
 */

const wslDrives = new Set<string>();
let initPromise: Promise<void> | null = null;

export function initWarpCwdNormalizer(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = doInit();
  return initPromise;
}

async function doInit(): Promise<void> {
  if (process.platform !== "win32") return;
  try {
    const letters = await loadWslDriveLetters();
    for (const l of letters) wslDrives.add(l);
  } catch {
    // Best-effort. If PowerShell fails or is slow, drive-mapped WSL
    // paths just won't get the exact-match treatment — UNC paths
    // still normalize correctly via the regex below.
  }
}

export function normalizeWarpCwd(raw: string): string {
  if (!raw || process.platform !== "win32") return raw;

  const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+\\(.*)$/i.exec(raw);
  if (unc) return "/" + unc[1].replace(/\\/g, "/");

  const drive = /^([A-Za-z]):\\(.*)$/.exec(raw);
  if (drive && wslDrives.has(drive[1].toUpperCase())) {
    return "/" + drive[2].replace(/\\/g, "/");
  }

  return raw;
}

function loadWslDriveLetters(): Promise<string[]> {
  // Single-quote everything inside the PS string and use ForEach-Object
  // so we get one line per drive: `<LETTER>=<DISPLAY-ROOT>`.
  const ps =
    "Get-PSDrive -PSProvider FileSystem | " +
    "Where-Object { $_.DisplayRoot } | " +
    "ForEach-Object { \"$($_.Name)=$($_.DisplayRoot)\" }";

  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", ps],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("timeout"));
    }, 3000);
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `exit-${code}`));
      const letters: string[] = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^([A-Za-z])=\s*(\\\\(?:wsl\$|wsl\.localhost)\\)/i.exec(line.trim());
        if (m) letters.push(m[1].toUpperCase());
      }
      resolve(letters);
    });
  });
}
