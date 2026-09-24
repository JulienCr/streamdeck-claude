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
    subagentDepth: 0,
    todos: [],
  });
});
