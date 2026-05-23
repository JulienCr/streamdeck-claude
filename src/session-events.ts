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
  /** CC's `notification_type` on Notification events: `permission_prompt`,
   *  `idle_prompt`, `elicitation_dialog`, `auth_success`. Older logs from
   *  before the hook captured this field will be `undefined`. */
  notifType?: string;
  /** Present only for PostToolUse[TodoWrite] — snapshot of the new list's statuses. */
  todos?: TodoStatus[];
}

/** What the icon needs, derived from the event log. The session's busy/idle
 *  flag still comes from the session JSON's `status` field — that's CC's own
 *  state, not ours to derive. */
export interface DerivedState {
  /** Generic in-turn Notification (non-permission). Catch-all for elicitation /
   *  unknown notifType values so the icon still flags "needs input." */
  awaiting: boolean;
  /** Notification[permission_prompt] in-turn — CC is asking to use a tool. */
  awaitingPermission: boolean;
  /** PreToolUse[AskUserQuestion] in-turn — CC is asking a UI question and
   *  hasn't received an answer yet (PostToolUse fires only after the user
   *  answers). Notification doesn't fire for AskUserQuestion. */
  awaitingQuestion: boolean;
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

const ZERO: ReducerState = { awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, subagentDepth: 0, todos: [], inTurn: false };

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
      // A fresh turn always starts with zero in-flight subagents. Resetting
      // subagentDepth here (and at Stop) keeps a missed SubagentStop — a
      // subagent killed or a hook that didn't fire — from leaking across the
      // turn boundary and stranding the session on the "subagent" icon.
      return { ...state, inTurn: true, awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, subagentDepth: 0 };

    case "Notification":
      // Only an in-turn Notification is a real prompt to the user. After Stop,
      // CC keeps firing Notification every ~60 s as an idle reminder — those
      // would falsely flip the icon to awaiting while the user is afk.
      // Split permission_prompt (CC asking to use a tool — gets its own padlock
      // icon) from anything else in-turn (elicitation_dialog / older logs with
      // no notifType — generic "needs input" awaiting).
      if (!state.inTurn) return state;
      return ev.notifType === "permission_prompt"
        ? { ...state, awaitingPermission: true }
        : { ...state, awaiting: true };

    case "PreToolUse": {
      // Any tool-lifecycle event mid-turn is proof the user resolved a pending
      // Notification (permission_prompt / elicitation): CC never emits tool
      // events while genuinely blocked on the user, so resumed tool activity
      // means it got its answer. Clear those flags here — they have no paired
      // "resolved" event of their own (unlike ExitPlanMode/AskUserQuestion).
      // Order is safe: the PreToolUse that *triggers* a permission_prompt fires
      // BEFORE its Notification, so this never clears the prompt it raises.
      const next = { ...state, awaiting: false, awaitingPermission: false };
      if (ev.tool === "ExitPlanMode") return { ...next, awaitingPlan: true };
      if (ev.tool === "AskUserQuestion") return { ...next, awaitingQuestion: true };
      return next;
    }

    case "PostToolUse": {
      const next = { ...state, awaiting: false, awaitingPermission: false };
      if (ev.tool === "ExitPlanMode") return { ...next, awaitingPlan: false };
      if (ev.tool === "AskUserQuestion") return { ...next, awaitingQuestion: false };
      if (ev.tool === "TodoWrite" && ev.todos) return { ...next, todos: ev.todos };
      return next;
    }

    case "Stop":
      // A subagent cannot outlive the turn that spawned it, so depth is 0 once
      // the main turn stops — reset it to absorb any unmatched SubagentStart.
      return { ...state, inTurn: false, awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, subagentDepth: 0 };

    case "StopFailure":
      return { ...state, inTurn: false, awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: true, subagentDepth: 0 };

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
          notifType: typeof obj.notifType === "string" ? obj.notifType : undefined,
          todos,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}
