import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseTerm, type TerminalKind } from "./terminal-kind.js";

test("normaliseTerm maps canonical hook values to kinds", () => {
  const cases: [string | undefined, TerminalKind][] = [
    ["vscode", "vscode"],
    ["warp", "warp"],
    ["iterm", "iterm"],
    ["other", "other"],
  ];
  for (const [input, expected] of cases) {
    assert.equal(normaliseTerm(input), expected);
  }
});

test("normaliseTerm defaults unknown/absent to 'unknown'", () => {
  assert.equal(normaliseTerm(undefined), "unknown");
  assert.equal(normaliseTerm(""), "unknown");
  assert.equal(normaliseTerm("WarpTerminal"), "unknown"); // raw env value, not canonical
});
