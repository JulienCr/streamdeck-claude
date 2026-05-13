import { spawn } from "node:child_process";

export interface CaptureResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Spawn-level failure (ENOENT, EPERM, …). `code` is null in this case. */
  err?: string;
  /** Child was killed because `timeoutMs` elapsed before it closed. */
  timedOut?: boolean;
}

export interface CaptureOptions {
  /** Kill the child with SIGTERM after this many ms. No timeout if omitted. */
  timeoutMs?: number;
  /** Payload written to the child's stdin and closed. */
  stdin?: string;
}

/**
 * Spawn a child, capture stdout+stderr, optionally with a stdin payload and a
 * kill-after timeout. Resolves on close OR spawn-error OR timeout — never
 * rejects. Used everywhere the plugin shells out (wsl.exe, tasklist, sqlite3,
 * osascript, powershell, clipboard tools).
 */
export function spawnCapture(
  cmd: string,
  args: readonly string[],
  opts: CaptureOptions = {},
): Promise<CaptureResult> {
  return new Promise((resolve) => {
    const stdinMode = opts.stdin !== undefined ? "pipe" : "ignore";
    const child = spawn(cmd, [...args], { stdio: [stdinMode, "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs);
    }
    child.stdout?.on("data", (b) => (stdout += b.toString()));
    child.stderr?.on("data", (b) => (stderr += b.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: null, err: err.message, timedOut: timedOut || undefined });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: timedOut || undefined });
    });
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }
  });
}
