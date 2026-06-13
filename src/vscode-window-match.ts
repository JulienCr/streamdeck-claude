import type { SessionOrigin } from "./sessions.js";

/** Minimal shape the matcher needs; backends pass richer objects (HWND, etc.)
 *  and get the same object back, so this is generic over the carrier. */
export interface TitledWindow {
  title: string;
}

/**
 * Pick the VS Code window whose title best matches `cwd`, or null if none
 * qualifies. Matching is title-based and best-effort: VS Code's default window
 * title contains the workspace name (`${rootName}`) and a `[WSL: <distro>]`
 * marker, but a user can reshape it via `window.title`, and the active editor
 * filename prefixes it. We therefore score on tokens, not exact strings.
 *
 * A window MUST contain every word of the cwd basename as a token to qualify.
 * Among qualifying windows, additional scoring ranks the best match:
 *   +10  every basename word appears as a token in the title  (REQUIRED to qualify)
 *   + N  N additional cwd path-component words also appear as tokens (tie-break)
 *   + 3  origin is "wsl" and the title carries a [WSL] marker
 *   - 3  origin is "windows" and the title carries a [WSL] marker
 * Highest score wins; ties resolve to the first window; no basename match → null.
 *
 * cwd path components and window titles are tokenized identically (`wordTokens`),
 * so a workspace folder whose name contains spaces or punctuation (e.g.
 * `My Project`) splits into `["my", "project"]` on both sides and can match —
 * rather than producing an unsplittable `"my project"` token that no title
 * (which VS Code renders word-split) could ever carry.
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
    // The basename is the REQUIRED signal — a window only qualifies if its
    // title carries *every* word of the cwd's last path component. Path-overlap
    // and [WSL] bias then only *rank* qualifying windows; they can't manufacture
    // a match on their own (a stray "dev"/"home" token or a [WSL] marker on an
    // unrelated window must never win).
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
