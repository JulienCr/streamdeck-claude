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
  /** CC's `source` on SessionStart: `startup`/`resume`/`clear`/`compact`/`fork`. */
  source?: string;
  /** Present only for PostToolUse[TodoWrite] — snapshot of the new list's statuses. */
  todos?: TodoStatus[];
  /** CC's `error_type` on StopFailure: `rate_limit`, `overloaded`, `server_error`, etc. */
  errorType?: string;
  /** CC's `agent_id` — present when this event fired inside a subagent (even
   *  though it's logged under the parent session_id). Absent for main-thread
   *  events and for older logs predating this field. */
  agentId?: string;
  /** CC's `agent_type` (e.g. "sonnet-medium"), present alongside agentId when
   *  the subagent was launched with a known type. Empty for CC-internal agents. */
  agentType?: string;
  /** CC's `permission_mode`: `default`/`plan`/`acceptEdits`/`auto`/`dontAsk`/`bypassPermissions`. */
  mode?: string;
  /** Present only on Stop/SubagentStop when the payload carries `background_tasks`
   *  — count of entries with status "running" (background subagents/shells). */
  bgRunning?: number;
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
  /** StopFailure with a rate_limit/overloaded error_type — an automatic backoff,
   *  not a real error. Cleared by UserPromptSubmit, a non-compact SessionStart,
   *  or Notification[quota_auto_resume_fired]. */
  throttled: boolean;
  /** True between PreCompact and PostCompact. */
  compacting: boolean;
  /** At least one foreground subagent is running, tracked by id — or (for
   *  legacy logs with no agentId) the old +1/-1 depth counter is above zero. */
  subagentActive: boolean;
  /** Latest count of running background tasks (background_tasks with
   *  status "running") from the last Stop/SubagentStop that reported it.
   *  Outlives turn boundaries — background work keeps running after Stop. */
  bgRunning: number;
  /** Last permission mode seen on a main-thread (no agentId) event. */
  permissionMode?: string;
  /** Most recent TodoWrite snapshot; empty until the agent calls TodoWrite. */
  todos: TodoStatus[];
}

/** Internal accumulator: DerivedState (minus the computed `subagentActive`)
 *  plus the bookkeeping needed to compute it and to scope permission-clearing
 *  to the agent that raised the prompt. `inTurn` is true between
 *  UserPromptSubmit and Stop/StopFailure — used to tell apart a real
 *  permission/input prompt (Notification fired mid-turn — CC actually needs
 *  the user) from an idle reminder (Notification fired ~60s after Stop —
 *  CC's bell-like "you've gone afk" nudge, not an actual question). */
interface ReducerState extends Omit<DerivedState, "subagentActive"> {
  inTurn: boolean;
  /** agentIds of foreground subagents with a SubagentStart but no matching
   *  SubagentStop yet. */
  activeSubagents: ReadonlySet<string>;
  /** Fallback +1/-1 counter for Subagent{Start,Stop} lines with no agentId
   *  (logs written before this field existed). */
  legacySubagentDepth: number;
  /** agentId (or "main") that the current awaitingPermission belongs to, so a
   *  parallel agent's tool activity can't clear another agent's padlock. */
  pendingPermissionAgent?: string;
}

const ZERO: ReducerState = {
  awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false,
  errored: false, throttled: false, compacting: false,
  bgRunning: 0, permissionMode: undefined,
  todos: [], inTurn: false,
  activeSubagents: new Set(), legacySubagentDepth: 0, pendingPermissionAgent: undefined,
};

/** Notification types (besides permission_prompt) that mean CC needs input. */
const AWAITING_NOTIF_TYPES: ReadonlySet<string> = new Set(["idle_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);
/** Notification types that resolve a pending elicitation. */
const CLEARING_NOTIF_TYPES: ReadonlySet<string> = new Set(["elicitation_complete", "elicitation_response"]);
/** StopFailure error_type values that mean "will auto-retry", not a real error. */
const THROTTLE_ERROR_TYPES: ReadonlySet<string> = new Set(["rate_limit", "overloaded"]);

export function reduceEvents(events: readonly SessionEvent[]): DerivedState {
  let state = ZERO;
  for (const ev of events) state = applyEvent(state, ev);
  const { inTurn: _inTurn, activeSubagents, legacySubagentDepth, pendingPermissionAgent: _pending, ...derived } = state;
  return { ...derived, subagentActive: activeSubagents.size > 0 || legacySubagentDepth > 0 };
}

/** Clears awaitingPermission only if `ev` belongs to the agent (or "main")
 *  that raised it — a parallel subagent's tool call must not clear another
 *  agent's padlock. No pending owner recorded (or a legacy log, where every
 *  event is agentId-less "main") always clears, preserving old behaviour. */
function clearAwaitingPermissionIfOwner(state: ReducerState, ev: SessionEvent): Pick<ReducerState, "awaitingPermission" | "pendingPermissionAgent"> {
  const eventAgent = ev.agentId ?? "main";
  const isOwner = state.pendingPermissionAgent === undefined || eventAgent === state.pendingPermissionAgent;
  return isOwner
    ? { awaitingPermission: false, pendingPermissionAgent: undefined }
    : { awaitingPermission: state.awaitingPermission, pendingPermissionAgent: state.pendingPermissionAgent };
}

function applyEvent(prev: ReducerState, ev: SessionEvent): ReducerState {
  const next = applyEventCore(prev, ev);
  // permission_mode rides on every hook payload; only a main-thread (no
  // agentId) event reflects the top-level session's mode.
  return ev.mode !== undefined && ev.agentId === undefined ? { ...next, permissionMode: ev.mode } : next;
}

function applyEventCore(state: ReducerState, ev: SessionEvent): ReducerState {
  switch (ev.event) {
    case "SessionStart":
      // Mid-turn auto-compaction fires SessionStart{source:compact} without a
      // real turn boundary — preserve state instead of resetting to ZERO. It
      // still marks the end of the compaction itself, so clear `compacting`.
      return ev.source === "compact" ? { ...state, compacting: false } : ZERO;

    case "SessionEnd":
      return ZERO;

    case "UserPromptSubmit":
      // Reset (as at Stop) so a missed SubagentStop or stale padlock can't leak
      // across turns. bgRunning is kept: background work outlives turns.
      return {
        ...state, inTurn: true,
        awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, throttled: false,
        activeSubagents: new Set(), legacySubagentDepth: 0, pendingPermissionAgent: undefined,
      };

    case "Notification": {
      // quota_auto_resume_fired means CC just resumed after a rate-limit backoff
      // — the session is idle (post-StopFailure) by definition, so this must
      // clear `throttled` regardless of the inTurn gate below.
      if (ev.notifType === "quota_auto_resume_fired") return { ...state, throttled: false };
      // Only an in-turn Notification is a real prompt to the user. After Stop,
      // CC keeps firing Notification every ~60 s as an idle reminder — those
      // would falsely flip the icon to awaiting while the user is afk.
      if (!state.inTurn) return state;
      if (ev.notifType === "permission_prompt") return { ...state, awaitingPermission: true, pendingPermissionAgent: ev.agentId ?? "main" };
      // undefined covers older logs / older CC builds predating notifType.
      if (ev.notifType === undefined || AWAITING_NOTIF_TYPES.has(ev.notifType)) return { ...state, awaiting: true };
      if (CLEARING_NOTIF_TYPES.has(ev.notifType)) return { ...state, awaiting: false };
      return state;
    }

    case "PermissionRequest":
      // Always a real dialog — CC never fires this speculatively — so it's not
      // gated on inTurn the way Notification is.
      return { ...state, awaitingPermission: true, pendingPermissionAgent: ev.agentId ?? "main" };

    case "PreCompact":
      return { ...state, compacting: true };

    case "PostCompact":
      return { ...state, compacting: false };

    case "PreToolUse": {
      // Any tool-lifecycle event mid-turn is proof the user resolved a pending
      // Notification (permission_prompt / elicitation): CC never emits tool
      // events while genuinely blocked on the user, so resumed tool activity
      // means it got its answer. `awaiting` has no per-agent owner to check —
      // only awaitingPermission needs the match (see clearAwaitingPermissionIfOwner).
      // Order is safe: the PreToolUse that *triggers* a permission_prompt fires
      // BEFORE its Notification, so this never clears the prompt it raises.
      const next = { ...state, awaiting: false, ...clearAwaitingPermissionIfOwner(state, ev) };
      if (ev.tool === "ExitPlanMode") return { ...next, awaitingPlan: true };
      if (ev.tool === "AskUserQuestion") return { ...next, awaitingQuestion: true };
      return next;
    }

    case "PostToolUse":
    case "PostToolUseFailure": {
      const next = { ...state, awaiting: false, ...clearAwaitingPermissionIfOwner(state, ev) };
      if (ev.tool === "ExitPlanMode") return { ...next, awaitingPlan: false };
      if (ev.tool === "AskUserQuestion") return { ...next, awaitingQuestion: false };
      if (ev.event === "PostToolUse" && ev.tool === "TodoWrite" && ev.todos) return { ...next, todos: ev.todos };
      return next;
    }

    case "Stop":
      // Foreground subagents end with their turn; reset absorbs a missed
      // SubagentStop. Background ones are counted by bgRunning instead.
      return {
        ...state, inTurn: false,
        awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, throttled: false, compacting: false,
        activeSubagents: new Set(), legacySubagentDepth: 0, pendingPermissionAgent: undefined,
        bgRunning: ev.bgRunning ?? state.bgRunning,
      };

    case "StopFailure": {
      const throttling = ev.errorType !== undefined && THROTTLE_ERROR_TYPES.has(ev.errorType);
      return {
        ...state,
        inTurn: false,
        awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false,
        errored: !throttling,
        throttled: throttling,
        compacting: false,
        activeSubagents: new Set(), legacySubagentDepth: 0, pendingPermissionAgent: undefined,
      };
    }

    case "SubagentStart": {
      if (!ev.agentId) return { ...state, legacySubagentDepth: state.legacySubagentDepth + 1 };
      if (state.activeSubagents.has(ev.agentId)) return state;
      return { ...state, activeSubagents: new Set(state.activeSubagents).add(ev.agentId) };
    }

    case "SubagentStop": {
      const bgRunning = ev.bgRunning ?? state.bgRunning;
      if (!ev.agentId) return { ...state, legacySubagentDepth: Math.max(0, state.legacySubagentDepth - 1), bgRunning };
      // Most SubagentStop lines have an agentId with no matching SubagentStart
      // (CC-internal agents) — ignore those instead of ending a real subagent.
      if (!state.activeSubagents.has(ev.agentId)) return { ...state, bgRunning };
      const activeSubagents = new Set(state.activeSubagents);
      activeSubagents.delete(ev.agentId);
      return { ...state, activeSubagents, bgRunning };
    }

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
          source: typeof obj.source === "string" ? obj.source : undefined,
          todos,
          errorType: typeof obj.errorType === "string" ? obj.errorType : undefined,
          agentId: typeof obj.agentId === "string" ? obj.agentId : undefined,
          agentType: typeof obj.agentType === "string" ? obj.agentType : undefined,
          mode: typeof obj.mode === "string" ? obj.mode : undefined,
          bgRunning: typeof obj.bgRunning === "number" ? obj.bgRunning : undefined,
        });
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}
