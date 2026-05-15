#!/usr/bin/env node
/** End-to-end "drill" for streamdeck-claude state rendering.
 *
 * Synthesizes fake <pid>.json + <sessionId>.events.ndjson files in
 * ~/.claude/sessions/ so the running Stream Deck plugin walks every
 * SessionState. Visual verification only — see the plan file for context.
 *
 * Mirrors (not imports) shapes/strings from these sources of truth:
 *   - src/session-events.ts  (event names + reducer behavior)
 *   - src/sessions.ts        (<pid>.json schema + deriveState priority)
 *   - src/state-tracker.ts   (FINISHED_TTL_MS = 3000)
 *   - hooks/notification.sh  (NDJSON line format: ts, event, tool?, notifType?)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SESSIONS_DIR = join(homedir(), ".claude", "sessions");

type DrilledState =
  | "idle" | "working" | "subagent"
  | "awaiting" | "awaiting_permission" | "awaiting_question" | "awaiting_plan"
  | "error" | "finished";

const NON_FINISHED: ReadonlyArray<Exclude<DrilledState, "finished">> = [
  "idle", "working", "subagent",
  "awaiting", "awaiting_permission", "awaiting_question", "awaiting_plan",
  "error",
];

const TOUR_ORDER: ReadonlyArray<DrilledState> = [...NON_FINISHED, "finished"];

type EventLine = { event: string; tool?: string; notifType?: string };

type Step = {
  state: Exclude<DrilledState, "finished">;
  rawStatus: "busy" | "idle";
  events: EventLine[];
  hint: string;
};

// Awaiting* states need inTurn=true (UserPromptSubmit fired, no Stop since).
const inTurn: EventLine[] = [
  { event: "SessionStart" },
  { event: "UserPromptSubmit" },
];

const STEPS: Record<Exclude<DrilledState, "finished">, Step> = {
  idle: {
    state: "idle", rawStatus: "idle",
    events: [{ event: "SessionStart" }],
    hint: "idle palette, static motif — session opened, nothing running",
  },
  working: {
    state: "working", rawStatus: "busy",
    events: [...inTurn, { event: "PreToolUse", tool: "Read" }],
    hint: "animated working motif — CC is processing a turn",
  },
  subagent: {
    state: "subagent", rawStatus: "busy",
    events: [...inTurn, { event: "PreToolUse", tool: "Task" }, { event: "SubagentStart" }],
    hint: "subagent motif (busy + depth>0) — a Task subagent is running",
  },
  awaiting: {
    state: "awaiting", rawStatus: "idle",
    events: [...inTurn, { event: "Notification" }],
    hint: "generic awaiting (no notifType) — elicitation / unknown",
  },
  awaiting_permission: {
    state: "awaiting_permission", rawStatus: "idle",
    events: [...inTurn, { event: "Notification", notifType: "permission_prompt" }],
    hint: "padlock motif — CC asks permission to use a tool",
  },
  awaiting_question: {
    state: "awaiting_question", rawStatus: "idle",
    events: [...inTurn, { event: "PreToolUse", tool: "AskUserQuestion" }],
    hint: "question motif — AskUserQuestion pending answer",
  },
  awaiting_plan: {
    state: "awaiting_plan", rawStatus: "idle",
    events: [...inTurn, { event: "PreToolUse", tool: "ExitPlanMode" }],
    hint: "plan motif — ExitPlanMode awaiting approval",
  },
  error: {
    state: "error", rawStatus: "idle",
    events: [...inTurn, { event: "StopFailure" }],
    hint: "error palette — last turn ended with StopFailure",
  },
};

type Owned = {
  sessionId: string;
  pid: number;
  cwd: string;
  startedAt: number;
  pidFile: string;
  eventsFile: string;
  child?: ChildProcess;
};

const owned: Owned[] = [];

function pidJsonPath(pid: number) { return join(SESSIONS_DIR, `${pid}.json`); }
function eventsPathOf(sid: string) { return join(SESSIONS_DIR, `${sid}.events.ndjson`); }

function writeEvents(s: Owned, lines: EventLine[]) {
  const t0 = Date.now() - lines.length;
  const body = lines.map((ev, i) => JSON.stringify({ ts: t0 + i, ...ev })).join("\n") + "\n";
  writeFileSync(s.eventsFile, body);
}

function writePidJson(s: Owned, rawStatus: "busy" | "idle") {
  const body = {
    pid: s.pid,
    sessionId: s.sessionId,
    cwd: s.cwd,
    startedAt: s.startedAt,
    status: rawStatus,
    updatedAt: Date.now(),
  };
  writeFileSync(s.pidFile, JSON.stringify(body));
}

function applyStep(s: Owned, step: Step) {
  // Events first, then pid.json: when the plugin sees the .json on readdir,
  // the matching events file is already in place — no 1-tick "shows idle then
  // jumps to the real state" flicker on first apply.
  writeEvents(s, step.events);
  writePidJson(s, step.rawStatus);
}

function tryUnlink(path: string) {
  try { unlinkSync(path); } catch { /* ENOENT or perms; ignore */ }
}

function spawnSleeper(): ChildProcess {
  // Hold-alive child whose PID lands in the same namespace as the drill itself
  // (WSL pids on WSL, Win pids on Windows, POSIX pids on macOS) so the plugin's
  // liveness check sees it. `node -e setInterval` is the only "sleep" guaranteed
  // on PATH on all three platforms.
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], {
    stdio: "ignore",
    detached: false,
  });
}

function newSession(idx: number, useOwnPid: boolean, cwd: string, startedAt: number): Owned {
  let pid: number;
  let child: ChildProcess | undefined;
  if (useOwnPid) {
    pid = process.pid;
  } else {
    child = spawnSleeper();
    if (typeof child.pid !== "number") throw new Error("failed to spawn sleeper child");
    pid = child.pid;
  }
  const sessionId = `drill-${process.pid}-${idx}`;
  return {
    sessionId, pid, cwd, startedAt,
    pidFile: pidJsonPath(pid),
    eventsFile: eventsPathOf(sessionId),
    child,
  };
}

let cleaningUp = false;
function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const s of owned) {
    tryUnlink(s.pidFile);
    tryUnlink(s.eventsFile);
    if (s.child && !s.child.killed) {
      try { s.child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
}

process.on("SIGINT", () => { cleanup(); process.exit(130); });
process.on("SIGTERM", () => { cleanup(); process.exit(143); });
process.on("exit", cleanup);
process.on("uncaughtException", (err) => {
  console.error("uncaught:", err);
  cleanup();
  process.exit(1);
});

function holdForever(): Promise<void> {
  // A bare unresolved Promise isn't enough to keep the event loop alive when
  // there's no other handle (no readline, no spawned child in single-session
  // mode). A long-interval timer is the cheapest "do nothing but stay open"
  // anchor that still lets SIGINT/SIGTERM fire their handlers promptly.
  return new Promise<void>(() => {
    setInterval(() => { /* anchor */ }, 1 << 30);
  });
}

function ask(q: string): Promise<void> {
  return new Promise((resolve) => {
    const r = createInterface({ input: process.stdin, output: process.stdout });
    r.question(q, () => { r.close(); resolve(); });
  });
}

async function runTour() {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const session = newSession(0, true, process.cwd(), Date.now());
  owned.push(session);

  console.log(`drill: full tour — sessionId=${session.sessionId}, pid=${session.pid}`);
  console.log(`drill: open Stream Deck and watch the matching slot.\n`);

  for (const name of TOUR_ORDER) {
    if (name === "finished") {
      console.log(`\n→ finished: unlinking pid.json. Icon should flip to "finished" within 1s, then disappear ~3s later (FINISHED_TTL_MS).`);
      tryUnlink(session.pidFile);
      await ask("[Enter] to exit once the carry-over has played out... ");
      break;
    }
    const step = STEPS[name];
    applyStep(session, step);
    console.log(`\n→ ${step.state}: ${step.hint}`);
    await ask("[Enter] for next state... ");
  }
}

async function runSingle(state: DrilledState) {
  if (state === "finished") {
    console.error(`drill: --state=finished isn't self-contained. Pick any other state, then Ctrl-C — the finished/TTL cycle plays on exit.`);
    process.exit(2);
  }
  if (!(state in STEPS)) {
    console.error(`drill: unknown state "${state}". Try one of: ${NON_FINISHED.join(", ")}`);
    process.exit(2);
  }
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const session = newSession(0, true, process.cwd(), Date.now());
  owned.push(session);
  const step = STEPS[state as Exclude<DrilledState, "finished">];
  applyStep(session, step);
  console.log(`drill: held on "${state}" — sessionId=${session.sessionId}, pid=${session.pid}`);
  console.log(`drill: ${step.hint}`);
  console.log(`drill: Ctrl-C to exit (slot will pass through "finished" ~3s then clear).\n`);
  await holdForever();
}

async function runMulti(n: number) {
  // Mix short, medium and one deliberately long cwd to exercise the marquee
  // path in src/icons/text.ts.
  const cwds = [
    process.cwd(),
    "/tmp/short",
    "/home/julien/dev/some-other-project",
    "/home/julien/dev/a-really-extremely-long-project-name-for-testing-the-marquee-overflow-behavior",
    "/var/tmp/another",
    "/srv/data/yet-another-one",
  ];
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const base = Date.now();
  for (let i = 0; i < n; i++) {
    const cwd = cwds[i % cwds.length];
    const useOwnPid = i === 0;
    // Stagger startedAt so slot ordering is deterministic across ticks.
    const s = newSession(i, useOwnPid, cwd, base + i * 100);
    owned.push(s);
    const step = STEPS[NON_FINISHED[i % NON_FINISHED.length]];
    applyStep(s, step);
  }
  console.log(`drill: ${n} parallel sessions — pids=${owned.map((s) => s.pid).join(", ")}`);
  console.log(`drill: verify slot ordering, marquee on the long label, and overflow if N exceeds visible slots.`);
  console.log(`drill: Ctrl-C to exit.\n`);
  await holdForever();
}

function usage() {
  console.log(`usage:
  pnpm drill                       full tour, Enter to advance
  pnpm drill --state <name>        hold on one state until Ctrl-C
  pnpm drill --sessions <N>        N parallel sessions, rotating states

<name> ∈ ${NON_FINISHED.join(" | ")}`);
}

type Args = { state?: DrilledState; sessions?: number; help: boolean };

function parseArgs(argv: string[]): Args {
  const out: Args = { help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--state") {
      out.state = argv[++i] as DrilledState;
    } else if (a.startsWith("--state=")) {
      out.state = a.slice("--state=".length) as DrilledState;
    } else if (a === "--sessions") {
      out.sessions = Number(argv[++i]);
    } else if (a.startsWith("--sessions=")) {
      out.sessions = Number(a.slice("--sessions=".length));
    } else {
      console.error(`drill: unknown arg "${a}"`);
      usage();
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  if (args.state !== undefined) { await runSingle(args.state); return; }
  if (args.sessions !== undefined) {
    if (!Number.isFinite(args.sessions) || args.sessions < 1) {
      console.error("drill: --sessions must be a positive integer");
      process.exit(2);
    }
    await runMulti(args.sessions);
    return;
  }
  await runTour();
}

main().catch((err) => {
  console.error(err);
  cleanup();
  process.exit(1);
});
