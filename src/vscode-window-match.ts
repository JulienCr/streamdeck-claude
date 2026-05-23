import type { SessionOrigin } from "./sessions.js";

/** Minimal shape the matcher needs; backends pass richer objects (HWND, etc.)
 *  and get the same object back, so this is generic over the carrier. */
export interface TitledWindow {
  title: string;
}

/**
 * Pick the VS Code window whose title best matches `cwd`, or null if none
 * scores. Matching is title-based and best-effort: VS Code's default window
 * title contains the workspace name (`${rootName}`) and a `[WSL: <distro>]`
 * marker, but a user can reshape it via `window.title`, and the active editor
 * filename prefixes it. We therefore score on tokens, not exact strings.
 *
 * Scoring per window:
 *   +10  the cwd basename appears as a token in the title
 *   + N  N additional cwd path components also appear as tokens (tie-break)
 *   + 3  origin is "wsl" and the title carries a [WSL] marker
 *   - 3  origin is "windows" and the title carries a [WSL] marker
 * Highest score wins; ties resolve to the first window; score <= 0 → no match.
 */
export function pickBestWindow<W extends TitledWindow>(
  cwd: string,
  windows: readonly W[],
  origin: SessionOrigin,
): W | null {
  const cwdTokens = pathTokens(cwd);
  if (cwdTokens.length === 0) return null;
  const base = cwdTokens[cwdTokens.length - 1];
  const rest = cwdTokens.slice(0, -1);

  let best: W | null = null;
  let bestScore = 0;
  for (const w of windows) {
    const titleTokens = titleTokenSet(w.title);
    let score = 0;
    if (titleTokens.has(base)) score += 10;
    for (const t of rest) if (titleTokens.has(t)) score += 1;
    const hasWsl = /\[wsl/i.test(w.title);
    if (hasWsl) score += origin === "wsl" ? 3 : -3;
    if (score > bestScore) {
      bestScore = score;
      best = w;
    }
  }
  return bestScore > 0 ? best : null;
}

/** Lowercased path components of a cwd, both `/` and `\` separated, empties dropped. */
function pathTokens(cwd: string): string[] {
  return cwd
    .toLowerCase()
    .split(/[/\\]+/)
    .filter(Boolean);
}

/** Lowercased token set of a window title, split on whitespace, path separators,
 *  and the separators VS Code uses in titles (em dash, pipe, brackets, parens). */
function titleTokenSet(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[\s/\\—|()[\]]+/)
      .filter(Boolean),
  );
}
