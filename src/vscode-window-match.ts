import type { SessionOrigin } from "./sessions.js";

/** Minimal shape the matcher needs; backends pass richer objects (HWND, etc.)
 *  and get the same object back, so this is generic over the carrier. */
export interface TitledWindow {
  title: string;
}

/**
 * Pick the VS Code window whose title best matches `cwd`, or null.
 *
 * A title must carry every word of the cwd basename to qualify; parent-path words
 * (+1 each) and the [WSL] marker (+/-3 by origin) only rank qualifiers, so a stray
 * "dev" or [WSL] on an unrelated window never wins. Ties go to the first window.
 * Titles are user-reshapable and word-split, so both sides use `wordTokens`.
 */
export function pickBestWindow<W extends TitledWindow>(
  cwd: string,
  windows: readonly W[],
  origin: SessionOrigin,
): W | null {
  const components = pathComponents(cwd);
  if (components.length === 0) return null;
  const baseTokens = wordTokens(components[components.length - 1]);
  if (baseTokens.length === 0) return null;
  const restTokens = components.slice(0, -1).flatMap(wordTokens);

  let best: W | null = null;
  let bestScore = 0;
  for (const w of windows) {
    const titleTokens = titleTokenSet(w.title);
    if (!baseTokens.every((t) => titleTokens.has(t))) continue;
    let score = 10;
    for (const t of restTokens) if (titleTokens.has(t)) score += 1;
    const hasWsl = /\[wsl/i.test(w.title);
    if (hasWsl) score += origin === "wsl" ? 3 : -3;
    // Strict `>` keeps the first window on a score tie.
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return best;
}

/** Path components of a cwd, split on `/` and `\`, empties dropped. Each
 *  component is further word-split by `wordTokens` so spaces/punctuation in a
 *  folder name don't survive as an unmatchable token. */
function pathComponents(cwd: string): string[] {
  return cwd.split(/[/\\]+/).filter(Boolean);
}

/** Lowercased word tokens, split on whitespace, path separators, and the
 *  punctuation VS Code uses in titles (em dash, pipe, brackets, parens, colon).
 *  Used for both cwd path components and window titles so the two tokenize
 *  consistently. */
function wordTokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[\s/\\—|()[\]:]+/)
    .filter(Boolean);
}

/** Lowercased token set of a window title. */
function titleTokenSet(title: string): Set<string> {
  return new Set(wordTokens(title));
}
