/** Session state is a deterministic projection of an append-only NDJSON event
 *  log written by hooks (one line per Claude Code hook fire). The plugin reads
 *  `<sid>.events.ndjson` each tick and replays it through `reduceEvents()` —
 *  no mtime heuristics, no per-state sidecar files, no race conditions between
 *  drop/rm pairs. Adding a new state = one case in `applyEvent`. */

export type TodoStatus = "pending" | "in_progress" | "completed";
const VALID_TODO_STATUS: ReadonlySet<TodoStatus> = new Set(["pending", "in_progress", "completed"]);

export interface SessionEvent {
  ts: number;
  event: string;
  tool?: string;
  /** Present only for PostToolUse[TodoWrite] — snapshot of the new list's statuses. */
  todos?: TodoStatus[];
}

/** What the icon needs, derived from the event log. The session's busy/idle
 *  flag still comes from the session JSON's `status` field — that's CC's own
 *  state, not ours to derive. */
export interface DerivedState {
  awaiting: boolean;
  awaitingPlan: boolean;
  errored: boolean;
  subagentDepth: number;
  /** Most recent TodoWrite snapshot; empty until the agent calls TodoWrite. */
  todos: TodoStatus[];
}

/** Internal accumulator: same as DerivedState plus `inTurn`, which is true
 *  between UserPromptSubmit and Stop/StopFailure. Used to tell apart a real
 *  permission/input prompt (Notification fired mid-turn — CC actually needs
 *  the user) from an idle reminder (Notification fired ~60s after Stop —
 *  CC's bell-like "you've gone afk" nudge, not an actual question). */
interface ReducerState extends DerivedState {
  inTurn: boolean;
}

const ZERO: ReducerState = { awaiting: false, awaitingPlan: false, errored: false, subagentDepth: 0, todos: [], inTurn: false };

export function reduceEvents(events: readonly SessionEvent[]): DerivedState {
  let state = ZERO;
  for (const ev of events) state = applyEvent(state, ev);
  // Strip the internal flag — callers only get the public projection.
  const { inTurn: _inTurn, ...derived } = state;
  return derived;
}

function applyEvent(state: ReducerState, ev: SessionEvent): ReducerState {
  switch (ev.event) {
    case "SessionStart":
    case "SessionEnd":
      return ZERO;

    case "UserPromptSubmit":
      return { ...state, inTurn: true, awaiting: false, awaitingPlan: false, errored: false };

    case "Notification":
      // Only an in-turn Notification is a real prompt to the user. After Stop,
      // CC keeps firing Notification every ~60 s as an idle reminder — those
      // would falsely flip the icon to awaiting while the user is afk.
      return state.inTurn ? { ...state, awaiting: true } : state;

    case "PreToolUse":
      return ev.tool === "ExitPlanMode" ? { ...state, awaitingPlan: true } : state;

    case "PostToolUse":
      if (ev.tool === "ExitPlanMode") return { ...state, awaitingPlan: false };
      if (ev.tool === "TodoWrite" && ev.todos) return { ...state, todos: ev.todos };
      return state;

    case "Stop":
      return { ...state, inTurn: false, awaiting: false, awaitingPlan: false };

    case "StopFailure":
      return { ...state, inTurn: false, awaiting: false, awaitingPlan: false, errored: true };

    case "SubagentStart":
      return { ...state, subagentDepth: state.subagentDepth + 1 };

    case "SubagentStop":
      return { ...state, subagentDepth: Math.max(0, state.subagentDepth - 1) };

    default:
      return state;
  }
}

/** Tolerant NDJSON parser: skips blank lines, malformed JSON, and entries
 *  missing the required `ts`/`event` fields. The last line may be a partial
 *  write (hook in progress) — silently dropped. */
export function parseEventLog(text: string): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.ts === "number" && typeof obj.event === "string") {
        const todos = Array.isArray(obj.todos)
          && obj.todos.every((s: unknown) => typeof s === "string" && VALID_TODO_STATUS.has(s as TodoStatus))
          ? (obj.todos as TodoStatus[])
          : undefined;
        out.push({
          ts: obj.ts,
          event: obj.event,
          tool: typeof obj.tool === "string" ? obj.tool : undefined,
          todos,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}
