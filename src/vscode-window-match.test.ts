import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBestWindow } from "./vscode-window-match.js";

const win = (title: string) => ({ title });

test("matches a window whose title contains the cwd basename as a token", () => {
  const best = pickBestWindow("/home/julien/dev/foo", [win("index.ts — foo [WSL: Ubuntu]")], "wsl");
  assert.equal(best?.title, "index.ts — foo [WSL: Ubuntu]");
});

test("prefers the window with deeper path-component overlap on a basename tie", () => {
  const best = pickBestWindow(
    "/a/b/foo",
    [win("foo"), win("b — foo")],
    "windows",
  );
  assert.equal(best?.title, "b — foo");
});

test("WSL-origin sessions prefer windows with a [WSL] marker", () => {
  const best = pickBestWindow(
    "/home/u/foo",
    [win("foo"), win("foo [WSL: Ubuntu]")],
    "wsl",
  );
  assert.equal(best?.title, "foo [WSL: Ubuntu]");
});

test("windows-origin sessions penalise [WSL] markers", () => {
  const best = pickBestWindow(
    "D:\\dev\\foo",
    [win("foo"), win("foo [WSL: Ubuntu]")],
    "windows",
  );
  assert.equal(best?.title, "foo");
});

test("returns null when nothing scores above zero", () => {
  assert.equal(pickBestWindow("/x/bar", [win("foo — baz")], "windows"), null);
});

test("returns null for an empty window list", () => {
  assert.equal(pickBestWindow("/x/foo", [], "wsl"), null);
});

test("WSL-origin: a [WSL] window with no basename match does not qualify", () => {
  assert.equal(pickBestWindow("/home/u/foo", [win("bar [WSL: Ubuntu]")], "wsl"), null);
});

test("a rest-component match without the basename does not qualify", () => {
  assert.equal(pickBestWindow("/home/dev/foo", [win("dev — bar")], "windows"), null);
});

test("matches a workspace folder whose name contains spaces", () => {
  // base component "My Project" must tokenize the same way the title does,
  // otherwise an unsplittable "my project" token could never match.
  const best = pickBestWindow(
    "/Users/me/My Project",
    [win("editor.ts — My Project")],
    "windows",
  );
  assert.equal(best?.title, "editor.ts — My Project");
});

test("requires every basename word — a partial folder-name match does not qualify", () => {
  assert.equal(
    pickBestWindow("/Users/me/My Project", [win("My — something else")], "windows"),
    null,
  );
});

test("among several qualifying windows the highest score wins", () => {
  const best = pickBestWindow(
    "/home/julien/dev/foo",
    [win("foo"), win("julien — foo"), win("foo [WSL: Ubuntu]")],
    "wsl",
  );
  // "foo [WSL]" = 10 + 3 = 13; "julien — foo" = 10 + 1 = 11; "foo" = 10
  assert.equal(best?.title, "foo [WSL: Ubuntu]");
});
