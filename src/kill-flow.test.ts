import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { nativeSteps, terminateThenForce, windowsSteps, wslSteps, type Runner } from "./kill-flow.js";
import type { CaptureResult } from "./spawn-capture.js";

const FAST = { graceMs: 200, confirmMs: 1000, pollMs: 20 };

function result(code: number | null, extra: Partial<CaptureResult> = {}): CaptureResult {
  return { code, stdout: "", stderr: "", ...extra };
}

/** Stands in for taskkill and the liveness probe of one Windows process. */
function fakeWindows(forceWorks: boolean) {
  let alive = true;
  const run: Runner = async (_cmd, args) => {
    if (!args.includes("/F") || !forceWorks) return result(128, { stderr: "ERREUR" });
    alive = false;
    return result(0);
  };
  return windowsSteps(42, run, async () => !alive);
}

test("windows: a refused soft taskkill is not an error when /F succeeds", async () => {
  assert.equal(await terminateThenForce(fakeWindows(true), FAST), "forced");
});

test("windows: a process surviving /F rejects with the diagnostic", async () => {
  await assert.rejects(terminateThenForce(fakeWindows(false), FAST), /still alive.*exit 128/);
});

test("windows: timed-out taskkill calls on a live process reject", async () => {
  const run: Runner = async () => result(null, { timedOut: true });
  await assert.rejects(terminateThenForce(windowsSteps(42, run, async () => false), FAST), /still alive.*timed out/);
});

test("wsl: a failed or timed-out TERM request rejects", async () => {
  for (const failure of [result(1, { stderr: "Operation not permitted" }), result(null, { timedOut: true })]) {
    await assert.rejects(terminateThenForce(wslSteps(42, "Ubuntu", async () => failure), FAST), /kill -TERM 42 failed/);
  }
});

async function spawnChild(script: string) {
  const child = spawn(process.execPath, ["-e", `${script}; console.log("ready"); setInterval(() => {}, 1000)`]);
  await once(child.stdout, "data");
  return child;
}

test("native: SIGTERM is enough for a cooperative process, and a dead one is success", async () => {
  const child = await spawnChild("0");
  assert.equal(await terminateThenForce(nativeSteps(child.pid!), FAST), "graceful");
  assert.equal(await terminateThenForce(nativeSteps(child.pid!), FAST), "graceful");
});

test("native: a process ignoring SIGTERM is force-killed", { skip: process.platform === "win32" }, async () => {
  const child = await spawnChild('process.on("SIGTERM", () => {})');
  try {
    assert.equal(await terminateThenForce(nativeSteps(child.pid!), FAST), "forced");
  } finally {
    child.kill("SIGKILL");
  }
});
