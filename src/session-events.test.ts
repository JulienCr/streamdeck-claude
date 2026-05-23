import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEventLog, reduceEvents } from "./session-events.js";

test("SessionStart term is reduced into DerivedState.terminal", () => {
  const log = JSON.stringify({ ts: 1, event: "SessionStart", term: "vscode" });
  assert.equal(reduceEvents(parseEventLog(log)).terminal, "vscode");
});

test("terminal carries through a turn (UserPromptSubmit/Stop preserve it)", () => {
  const log = [
    { ts: 1, event: "SessionStart", term: "warp" },
    { ts: 2, event: "UserPromptSubmit" },
    { ts: 3, event: "Stop" },
  ]
    .map((e) => JSON.stringify(e))
    .join("\n");
  assert.equal(reduceEvents(parseEventLog(log)).terminal, "warp");
});

test("absent term defaults to 'unknown'", () => {
  const log = JSON.stringify({ ts: 1, event: "SessionStart" });
  assert.equal(reduceEvents(parseEventLog(log)).terminal, "unknown");
});

test("an unrecognised term value is coerced to 'unknown'", () => {
  const log = JSON.stringify({ ts: 1, event: "SessionStart", term: "kitty" });
  assert.equal(reduceEvents(parseEventLog(log)).terminal, "unknown");
});
