import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceEvents, type SessionEvent } from "./session-events.js";

function ev(event: string, extra: Partial<SessionEvent> = {}): SessionEvent {
  return { ts: 0, event, ...extra };
}

test("SessionStart[compact] mid-turn preserves state through a permission prompt", () => {
  const state = reduceEvents([
    ev("UserPromptSubmit"),
    ev("SessionStart", { source: "compact" }),
    ev("Notification", { notifType: "permission_prompt" }),
  ]);
  assert.equal(state.awaitingPermission, true);
});

test("Notification notifType handling: agent_completed ignored, undefined and elicitation_dialog set awaiting, elicitation_complete clears it", () => {
  assert.equal(
    reduceEvents([ev("UserPromptSubmit"), ev("Notification", { notifType: "agent_completed" })]).awaiting,
    false,
  );
  assert.equal(
    reduceEvents([ev("UserPromptSubmit"), ev("Notification")]).awaiting,
    true,
  );
  assert.equal(
    reduceEvents([
      ev("UserPromptSubmit"),
      ev("Notification", { notifType: "elicitation_dialog" }),
      ev("Notification", { notifType: "elicitation_complete" }),
    ]).awaiting,
    false,
  );
});

test("PostToolUseFailure[ExitPlanMode] clears awaitingPlan like PostToolUse would", () => {
  const state = reduceEvents([
    ev("UserPromptSubmit"),
    ev("PreToolUse", { tool: "ExitPlanMode" }),
    ev("PostToolUseFailure", { tool: "ExitPlanMode" }),
  ]);
  assert.equal(state.awaitingPlan, false);
});

test("SessionStart with no source still resets state", () => {
  const state = reduceEvents([
    ev("UserPromptSubmit"),
    ev("Notification", { notifType: "permission_prompt" }),
    ev("SessionStart"),
  ]);
  assert.deepEqual(state, {
    awaiting: false,
    awaitingPermission: false,
    awaitingQuestion: false,
    awaitingPlan: false,
    errored: false,
    throttled: false,
    compacting: false,
    subagentActive: false,
    bgRunning: 0,
    permissionMode: undefined,
    todos: [],
  });
});

test("PermissionRequest outside a turn sets awaitingPermission", () => {
  const state = reduceEvents([ev("PermissionRequest")]);
  assert.equal(state.awaitingPermission, true);
});

test("StopFailure[rate_limit] sets throttled not errored, cleared by quota_auto_resume_fired", () => {
  const throttled = reduceEvents([ev("UserPromptSubmit"), ev("StopFailure", { errorType: "rate_limit" })]);
  assert.equal(throttled.throttled, true);
  assert.equal(throttled.errored, false);

  const resumed = reduceEvents([
    ev("UserPromptSubmit"),
    ev("StopFailure", { errorType: "rate_limit" }),
    ev("Notification", { notifType: "quota_auto_resume_fired" }),
  ]);
  assert.equal(resumed.throttled, false);
});

test("StopFailure[server_error] sets errored not throttled", () => {
  const state = reduceEvents([ev("UserPromptSubmit"), ev("StopFailure", { errorType: "server_error" })]);
  assert.equal(state.errored, true);
  assert.equal(state.throttled, false);
});

test("PreCompact sets compacting, PostCompact and Stop clear it", () => {
  const compacting = reduceEvents([ev("UserPromptSubmit"), ev("PreCompact")]);
  assert.equal(compacting.compacting, true);

  const postCompacted = reduceEvents([ev("UserPromptSubmit"), ev("PreCompact"), ev("PostCompact")]);
  assert.equal(postCompacted.compacting, false);

  const stopped = reduceEvents([ev("UserPromptSubmit"), ev("PreCompact"), ev("Stop")]);
  assert.equal(stopped.compacting, false);
});

test("orphan SubagentStop (unknown agentId) does not end a running subagent", () => {
  const state = reduceEvents([
    ev("UserPromptSubmit"),
    ev("SubagentStart", { agentId: "a" }),
    ev("SubagentStop", { agentId: "unrelated-internal-agent" }),
  ]);
  assert.equal(state.subagentActive, true);
});

test("bgRunning survives a turn boundary and clears on the next Stop", () => {
  const afterFirstStop = reduceEvents([ev("UserPromptSubmit"), ev("Stop", { bgRunning: 1 })]);
  assert.equal(afterFirstStop.bgRunning, 1);

  const afterNextPrompt = reduceEvents([ev("UserPromptSubmit"), ev("Stop", { bgRunning: 1 }), ev("UserPromptSubmit")]);
  assert.equal(afterNextPrompt.bgRunning, 1);

  const afterSecondStop = reduceEvents([
    ev("UserPromptSubmit"), ev("Stop", { bgRunning: 1 }),
    ev("UserPromptSubmit"), ev("Stop", { bgRunning: 0 }),
  ]);
  assert.equal(afterSecondStop.bgRunning, 0);
});

test("a subagent's PermissionRequest is cleared only by that same agent's tool activity", () => {
  const clearedByOwner = reduceEvents([
    ev("UserPromptSubmit"),
    ev("PermissionRequest", { agentId: "A" }),
    ev("PreToolUse", { tool: "Bash", agentId: "B" }),
    ev("PreToolUse", { tool: "Bash", agentId: "A" }),
  ]);
  assert.equal(clearedByOwner.awaitingPermission, false);

  const notClearedByOther = reduceEvents([
    ev("UserPromptSubmit"),
    ev("PermissionRequest", { agentId: "A" }),
    ev("PreToolUse", { tool: "Bash", agentId: "B" }),
  ]);
  assert.equal(notClearedByOther.awaitingPermission, true);
});

test("legacy Subagent{Start,Stop} lines without agentId still pair +1/-1", () => {
  const bothRunning = reduceEvents([ev("UserPromptSubmit"), ev("SubagentStart"), ev("SubagentStart")]);
  assert.equal(bothRunning.subagentActive, true);

  const oneLeft = reduceEvents([ev("UserPromptSubmit"), ev("SubagentStart"), ev("SubagentStart"), ev("SubagentStop")]);
  assert.equal(oneLeft.subagentActive, true);

  const noneLeft = reduceEvents([
    ev("UserPromptSubmit"), ev("SubagentStart"), ev("SubagentStart"), ev("SubagentStop"), ev("SubagentStop"),
  ]);
  assert.equal(noneLeft.subagentActive, false);
});

test("permissionMode tracks main-thread events only, ignoring subagent-scoped mode", () => {
  const state = reduceEvents([
    ev("SessionStart"),
    ev("UserPromptSubmit", { mode: "default" }),
    ev("PreToolUse", { tool: "Bash", agentId: "sub1", mode: "bypassPermissions" }),
    ev("PreToolUse", { tool: "Bash", mode: "plan" }),
  ]);
  assert.equal(state.permissionMode, "plan");
});
