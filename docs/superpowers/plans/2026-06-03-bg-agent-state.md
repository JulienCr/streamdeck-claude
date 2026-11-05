# Agents background (kind:"bg") comme état distinct — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Afficher les sessions Claude Code `kind:"bg"` (background agents) comme des slots visuellement distincts (palette indigo + badge "bg" + états `bg_*`), avec une liveness fondée sur la fraîcheur de `updatedAt` + le statut (et non sur le PID du daemon partagé), pour qu'un job bg fini/abandonné disparaisse comme une session morte.

**Architecture:** `sessions.ts` lit le champ `kind` et, pour les bg, dérive l'état depuis `status`/`waitingFor` du json (pas via l'event-log, qu'un agent headless ne nourrit pas). `live-pids.ts` résout la liveness des bg localement (sans spawn) : `vivant = updatedAt frais ET status non-terminal` ; les interactives gardent le check PID. Le registre `STATES` gagne 4 entrées `bg_*` (palette dédiée + motifs réutilisés), `render.ts` dessine un badge "bg". Côté kill (palier 3 de `feat/aggressive-kill`), les slots bg sont marqués `killable=false` car leur PID est un daemon `--bg-spare` partagé — on ne l'arme jamais.

**Tech Stack:** TypeScript ESM (Node 20, `strict`), rollup, SVG via `setImage`. **Pas de suite de tests** dans ce repo — la vérification se fait par `pnpm build` (le typecheck rollup sert de garde-fou) + test manuel sur le Stream Deck. Les étapes "test" du squelette TDD sont donc remplacées par build + vérif manuelle.

**Imports:** rappel projet — les imports de modules `.ts` utilisent l'extension `.js` (NodeNext).

**Prérequis / branche:** ce plan modifie le palier kill de `slot-action.ts` (introduit par `feat/aggressive-kill`, non encore mergée dans `main`). **Brancher `feat/bg-agent-state` depuis `feat/aggressive-kill`**, ou attendre le merge de celle-ci dans `main` puis brancher depuis `main`. Ne pas brancher depuis `main` tant qu'`aggressive-kill` n'y est pas — la Task 4 ne compilerait pas.

**Spec:** `docs/superpowers/specs/2026-06-03-bg-agent-state-design.md`

---

### Task 1: États `bg_*` + badge "bg" (`src/icons/states.ts`, `src/icons/render.ts`)

Ces deux fichiers vont ensemble : `render.ts` consomme `isBgState` ajouté dans `states.ts`.

**Files:**
- Modify: `src/icons/states.ts`
- Modify: `src/icons/render.ts`

- [ ] **Step 1: `states.ts` — ajouter les 4 entrées `bg_*` au registre `STATES`**

Dans `STATES`, juste après l'entrée `finished:` et avant `empty:`, insérer :

```ts
  bg_working:             { palette: { bg: "#10131a", accent: "#8b9cff", label: "#c7d2fe" }, animated: true,  pulseBg: false, motif: spinnerArc },
  bg_awaiting_permission: { palette: { bg: "#12132e", accent: "#a5b4fc", label: "#ddd6fe" }, animated: true,  pulseBg: true,  motif: permissionPulse },
  bg_awaiting:            { palette: { bg: "#12132e", accent: "#a5b4fc", label: "#ddd6fe" }, animated: true,  pulseBg: true,  motif: awaitingPulse },
  bg_idle:                { palette: { bg: "#10131a", accent: "#6b7fd0", label: "#c7d2fe" }, animated: true,  pulseBg: false, motif: clawdIdleLook },
```

(Tous les motifs référencés — `spinnerArc`, `permissionPulse`, `awaitingPulse`, `clawdIdleLook` — sont **déjà** importés en tête de `states.ts`.)

- [ ] **Step 2: `states.ts` — ajouter le helper `isBgState` en fin de fichier**

Après la ligne `export type SessionState = keyof typeof STATES;` :

```ts
/** True for the dedicated background-agent states. The `bg_` prefix is the
 *  single source of truth — render.ts uses this to draw the "bg" badge. */
export const isBgState = (s: SessionState): boolean => s.startsWith("bg_");
```

- [ ] **Step 3: `render.ts` — importer `isBgState` et ajouter le helper de badge**

Étendre l'import existant depuis `./states.js` :

```ts
import { STATES, isBgState, type SessionState } from "./states.js";
```

Ajouter, juste après la fonction `renderSlotBadge` (vers la ligne 77) :

```ts
function renderBgBadge(accent: string): string {
  // Coin haut-gauche, miroir du badge numéro de slot (haut-droite) → jamais de collision.
  return `<text x="16" y="22" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10" font-weight="700" fill="${accent}" opacity="0.8" text-anchor="start">bg</text>`;
}
```

- [ ] **Step 4: `render.ts` — dessiner le badge "bg" dans `renderIcon`**

Dans `renderIcon`, juste après la ligne qui calcule `slotBadge` :

```ts
  const slotBadge = isEmpty ? "" : renderSlotBadge(slotText, accent);
```

ajouter :

```ts
  const bgBadge = isBgState(state) ? renderBgBadge(accent) : "";
```

Puis, dans le template SVG retourné, insérer `${bgBadge}` juste après `${slotBadge}` :

```ts
${slotBadge}
${bgBadge}
${topLine}
```

- [ ] **Step 5: Build**

Run: `pnpm build`
Expected: build OK. Les 4 nouveaux états sont dans le registre mais pas encore produits par `deriveState` — c'est attendu.

- [ ] **Step 6: Commit**

```bash
git add src/icons/states.ts src/icons/render.ts
git commit -m "feat(icons): add bg_* states + bg badge for background agents"
```

---

### Task 2: Parsing `kind:"bg"` + dérivation d'état (`src/sessions.ts`)

**Files:**
- Modify: `src/sessions.ts`

- [ ] **Step 1: étendre `RawSession`**

Remplacer l'interface `RawSession` par :

```ts
interface RawSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  status?: string;
  updatedAt?: number;
  name?: string;
  /** "interactive" | "bg" (Claude Code 2.1.x). Absent sur les anciennes versions. */
  kind?: string;
  /** Pour les bg en attente : ex. "permission prompt". */
  waitingFor?: string;
}
```

(`jobId` n'est lu par aucune logique → omis, YAGNI.)

- [ ] **Step 2: étendre `SessionInfo`**

Ajouter ces champs à l'interface `SessionInfo` (après `origin: SessionOrigin;` — ou n'importe où dans le corps) :

```ts
  /** "interactive" par défaut si le json n'a pas de champ `kind`. */
  kind: "interactive" | "bg";
  /** Statut brut du json pour les bg (ex. "waiting", "running"). undefined pour interactive. */
  bgStatus?: string;
  /** `waitingFor` du json pour les bg (ex. "permission prompt"). */
  bgWaitingFor?: string;
  /** mtime logique du json (ms). Sert à la liveness des bg (fraîcheur). */
  updatedAt?: number;
```

- [ ] **Step 3: `readOneSource` — calculer `kind`, sauter l'event-log pour les bg, peupler les champs**

Dans `readOneSource`, remplacer tout le bloc depuis `const status = raw.status === "busy" ? "busy" : "idle";` jusqu'à la fin du `out.push({ ... });` par :

```ts
        const status = raw.status === "busy" ? "busy" : "idle";
        const kind: "interactive" | "bg" = raw.kind === "bg" ? "bg" : "interactive";

        let derived: DerivedState = {
          awaiting: false, awaitingPermission: false, awaitingQuestion: false, awaitingPlan: false, errored: false, subagentDepth: 0, todos: [],
        };
        // Un agent bg tourne en headless et ne nourrit pas le pipeline de hooks :
        // son json (status/waitingFor) est la source de vérité. On saute donc
        // entièrement la lecture/réduction de l'event-log pour les bg.
        if (kind !== "bg") {
          const eventsPath = join(src.path, `${raw.sessionId}.events.ndjson`);
          try {
            const st = await stat(eventsPath);
            const cached = eventLogCache.get(eventsPath);
            if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
              derived = cached.derived;
            } else {
              const text = await readFile(eventsPath, "utf8");
              derived = reduceEvents(parseEventLog(text));
              eventLogCache.set(eventsPath, { mtimeMs: st.mtimeMs, size: st.size, derived });
            }
          } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException)?.code;
            if (code !== "ENOENT") {
              streamDeck.logger.warn(
                `event-log read failed ${src.origin}/${raw.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // no event log yet (ENOENT) — defaults are fine; don't cache
          }
        }

        out.push({
          pid: raw.pid,
          sessionId: raw.sessionId,
          cwd: raw.cwd,
          label: raw.name?.trim() || basename(raw.cwd),
          startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
          rawStatus: status,
          kind,
          bgStatus: kind === "bg" ? raw.status : undefined,
          bgWaitingFor: kind === "bg" ? raw.waitingFor : undefined,
          updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : undefined,
          awaiting: derived.awaiting,
          awaitingPermission: derived.awaitingPermission,
          awaitingQuestion: derived.awaitingQuestion,
          awaitingPlan: derived.awaitingPlan,
          errored: derived.errored,
          subagentActive: derived.subagentDepth > 0,
          todos: derived.todos,
          origin: src.origin,
        });
```

- [ ] **Step 4: `deriveState` — branche bg + helper `deriveBgState`**

Dans `deriveState`, ajouter la branche bg juste après le garde `if (!alive)` :

```ts
export function deriveState(s: SessionInfo, alive: boolean): SessionState {
  if (!alive) return "finished";
  if (s.kind === "bg") return deriveBgState(s);
  if (s.errored) return "error";
  if (s.awaitingPlan) return "awaiting_plan";
  if (s.awaitingPermission) return "awaiting_permission";
  if (s.awaitingQuestion) return "awaiting_question";
  if (s.awaiting) return "awaiting";
  if (s.rawStatus === "busy" && s.subagentActive) return "subagent";
  if (s.rawStatus === "busy") return "working";
  return "idle";
}

/** Mappe le json d'un agent bg vers un état bg_*. Table best-effort (un seul
 *  échantillon connu : status="waiting"/waitingFor="permission prompt") ; tout
 *  statut non-terminal inconnu retombe sur bg_idle. Les statuts terminaux sont
 *  déjà filtrés en amont par la liveness (→ finished/retiré), donc absents ici. */
function deriveBgState(s: SessionInfo): SessionState {
  const waitingFor = (s.bgWaitingFor ?? "").toLowerCase();
  if (waitingFor.includes("permission")) return "bg_awaiting_permission";
  const status = (s.bgStatus ?? "").toLowerCase();
  if (status === "waiting") return "bg_awaiting";
  if (status === "busy" || status === "running") return "bg_working";
  return "bg_idle";
}
```

- [ ] **Step 5: Build**

Run: `pnpm build`
Expected: build OK. (`deriveBgState` retourne des littéraux `bg_*` désormais valides comme `SessionState` grâce à la Task 1.)

- [ ] **Step 6: Commit**

```bash
git add src/sessions.ts
git commit -m "feat(sessions): parse kind:bg, derive bg_* state from json status"
```

---

### Task 3: Liveness des bg (`src/live-pids.ts`)

**Files:**
- Modify: `src/live-pids.ts`

- [ ] **Step 1: ajouter les constantes + le helper `bgAlive`**

Juste après le bloc `const cache: Record<SessionOrigin, OriginCache> = { ... };` (vers la ligne 30) :

```ts
/** Un agent bg compte comme vivant tant que son json a été rafraîchi récemment.
 *  Généreux exprès : un job bg silencieux mais vivant ne doit pas disparaître.
 *  Tunable. */
const FRESH_MS = 90_000;
/** Statuts bg considérés comme terminaux → le job est fini, on le retire.
 *  Best-effort (cf. spec §6) ; à confirmer en observant d'autres jobs. */
const TERMINAL_BG_STATUS = new Set(["completed", "failed", "cancelled", "done"]);

/** Liveness d'une session bg, sans toucher au PID (daemon --bg-spare partagé) :
 *  fraîcheur de updatedAt ET statut non-terminal. */
function bgAlive(s: SessionInfo, now: number): boolean {
  if (s.updatedAt == null) return false;
  if (now - s.updatedAt >= FRESH_MS) return false;
  return !TERMINAL_BG_STATUS.has((s.bgStatus ?? "").toLowerCase());
}
```

- [ ] **Step 2: partitionner bg vs interactive dans `filterLiveSessions`**

Remplacer le corps de `filterLiveSessions` par :

```ts
export async function filterLiveSessions(sessions: SessionInfo[]): Promise<LivenessResult> {
  const now = Date.now();
  // Les bg ne passent pas par le check PID : leur PID est un daemon partagé.
  // Seules les interactives alimentent les checks wsl/windows.
  const byOrigin: Record<SessionOrigin, number[]> = { wsl: [], windows: [] };
  for (const s of sessions) {
    if (s.kind !== "bg") byOrigin[s.origin].push(s.pid);
  }

  const [wslRes, winRes] = await Promise.all([
    checkWslLive(byOrigin.wsl),
    checkWindowsLive(byOrigin.windows),
  ]);

  const live = new Set<string>();
  for (const s of sessions) {
    if (s.kind === "bg") {
      if (bgAlive(s, now)) live.add(s.sessionId);
      continue;
    }
    const livePids = s.origin === "wsl" ? wslRes.live : winRes.live;
    if (livePids.has(s.pid)) live.add(s.sessionId);
  }

  const errors = [wslRes.error, winRes.error].filter(Boolean) as string[];
  return {
    live,
    fromCache: wslRes.fromCache || winRes.fromCache,
    error: errors.length ? errors.join("; ") : undefined,
  };
}
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: build OK. (`bgAlive` lit `s.kind`, `s.updatedAt`, `s.bgStatus` ajoutés en Task 2.)

- [ ] **Step 4: Commit**

```bash
git add src/live-pids.ts
git commit -m "feat(live-pids): bg liveness via updatedAt freshness + terminal status"
```

---

### Task 4: Sécurité kill — slots bg non-killables (`src/slot-action.ts`, `src/render-loop.ts`)

Couplés : `render-loop.ts` pose `killable` que `slot-action.ts` lit.

**Files:**
- Modify: `src/slot-action.ts`
- Modify: `src/render-loop.ts`

- [ ] **Step 1: `slot-action.ts` — ajouter `killable` à `SlotState`**

Ajouter le champ à l'interface `SlotState` (après `killArmingSince?: number;`) :

```ts
  /** False pour un agent bg : son PID est un daemon --bg-spare partagé, le tuer
   *  flinguerait le daemon. Posé chaque tick par le render-loop. */
  killable?: boolean;
```

- [ ] **Step 2: `slot-action.ts` — n'armer le kill (et l'anneau) que si `killable`**

Remplacer `onKeyDown` par :

```ts
  override onKeyDown(ev: KeyDownEvent): void {
    const slot = this.state.get(ev.action.id);
    if (!slot?.clipboardPayload || !slot.sessionId || !slot.origin || slot.pid === undefined) {
      // Empty slot — keep the "nothing to do here" feedback. No timer armed, so
      // KeyUp is also a no-op.
      void ev.action.showAlert();
      return;
    }
    const id = ev.action.id;
    const sessionId = slot.sessionId;
    const origin = slot.origin;
    const pid = slot.pid;
    // Un agent bg n'est pas killable (daemon partagé) : on garde le palier 1
    // (wipe du log) mais ni l'anneau KILL ni le palier 2.
    const killable = slot.killable === true;
    const wipeTimer = setTimeout(() => {
      this.pressTimers.delete(id);
      // Palier 1 atteint : wipe le log. L'anneau "KILL" ne s'arme que si un kill
      // peut effectivement suivre.
      if (killable) slot.killArmingSince = Date.now();
      void this.runLongPress(ev, sessionId, origin);
    }, LONG_PRESS_MS);
    this.pressTimers.set(id, wipeTimer);
    if (killable) {
      const killTimer = setTimeout(() => {
        this.killTimers.delete(id);
        // Garde killArmingSince posé pendant le kill pour que l'anneau s'affiche
        // plein (progress clampé à 1) le temps du SIGTERM, puis le libère — sinon
        // le dernier frame visible plafonne à ~0.95 avant de disparaître.
        void this.runKill(ev, pid, sessionId, origin).finally(() => {
          slot.killArmingSince = undefined;
        });
      }, KILL_PRESS_MS);
      this.killTimers.set(id, killTimer);
    }
  }
```

(`onKeyUp` est inchangé : pour un bg relâché après 500 ms, `wipeTimer` a déjà fired et `killTimer` n'a jamais été posé → les deux `if` sont sautés, no-op. `killArmingSince` n'a jamais été posé → le render-loop n'a jamais dessiné l'anneau.)

- [ ] **Step 3: `render-loop.ts` — poser `killable` en bindant le slot**

Dans `renderAll`, là où les champs de `slotState` sont assignés (juste après `slotState.pid = entry?.session.pid;`), ajouter :

```ts
    slotState.killable = entry?.session.kind !== "bg";
```

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: build OK.

- [ ] **Step 5: Commit**

```bash
git add src/slot-action.ts src/render-loop.ts
git commit -m "feat(slot): bg agents not killable (shared daemon pid), gate kill tier"
```

---

### Task 5: Validation intégrée

**Files:** aucun (vérification).

- [ ] **Step 1: Build + validate**

Run: `pnpm build && pnpm sd:validate`
Expected: build OK, manifest/assets valides.

- [ ] **Step 2: Reload du plugin**

Run: `pnpm sd:reload`
Expected: le plugin self-exit puis est respawné (~1 s).

- [ ] **Step 3: Le fantôme `mosaic` a disparu**

Le json `~/.claude/sessions/26658.json` (kind:bg, updatedAt figé depuis ~7 j) est *déjà* stale.
Expected: **aucun** slot `mosaic-sr-fallback-404` ne s'affiche (jamais entré dans `prevLiveIds` → jamais promu finished → ignoré).

- [ ] **Step 4: Un vrai job bg s'affiche correctement**

Lancer un agent background récent (json frais avec `kind:"bg"`).
Expected : slot en **palette indigo** avec **badge "bg"** en haut-gauche, état dérivé du json :
- `waitingFor:"permission prompt"` → `bg_awaiting_permission` (tile pulse).
- `status:"running"`/`"busy"` → `bg_working` (spinner, pas de pulse).
- `status:"waiting"` sans waitingFor permission → `bg_awaiting`.
- autre → `bg_idle`.

- [ ] **Step 5: Sécurité kill sur slot bg**

Maintenir la touche d'un slot bg ≥3 s.
Expected : **pas** d'anneau "KILL", **aucun** process tué (le daemon reste vivant — vérifier `ps -p <pid daemon>`). L'appui court copie quand même le `cwd`.

- [ ] **Step 6: Liveness — disparition à péremption**

Laisser un job bg dépasser `FRESH_MS` (90 s) sans rafraîchissement de son json, ou observer sa complétion.
Expected : le slot passe `finished` (check vert) puis se vide au `FINISHED_TTL_MS` (3 s).

- [ ] **Step 7: Non-régression interactive**

Une session `claude` interactive normale.
Expected : palette/état/comportement **inchangés** (working/awaiting_*/idle, palier kill toujours actif, pas de badge "bg").

---

## Notes de vérification du plan (self-review)

- **Couverture spec :**
  - §1 Détection & données → Task 2 (RawSession+SessionInfo, `kind` défaut interactive, skip event-log bg, label inchangé) ✓
  - §2 Liveness hybride → Task 3 (`bgAlive` = fraîcheur ET non-terminal ; PID jamais utilisé pour bg) ✓
  - §3 Dérivation d'état → Task 2 (`deriveBgState` + table) ✓
  - §4 Visuel `bg_*` → Task 1 (4 états, palette indigo, motifs réutilisés, badge "bg" haut-gauche, pulseBg sur awaiting) ✓
  - §5 Sécurité kill → Task 4 (`killable`, gate du killTimer + de l'anneau) ✓
  - §6 Inconnues → table + `TERMINAL_BG_STATUS` centralisés, catch-all `bg_idle` ✓
  - Fix du bug d'origine → Task 5 Step 3 (mosaic déjà stale → non affiché) ✓
- **Cohérence des types/noms :** `kind: "interactive" | "bg"`, `bgStatus`/`bgWaitingFor`/`updatedAt` (SessionInfo) ; `deriveBgState(s)` → `SessionState` ; états `bg_working`/`bg_awaiting_permission`/`bg_awaiting`/`bg_idle` (mêmes clés dans STATES, deriveBgState, et la vérif manuelle) ; `isBgState(s)` (states.ts → render.ts) ; `bgAlive(s, now)` ; `FRESH_MS`/`TERMINAL_BG_STATUS` (live-pids.ts) ; `SlotState.killable` (slot-action.ts ← render-loop.ts). Cohérents d'une task à l'autre.
- **Buildabilité / ordre :** Task 1 (états) avant Task 2 (deriveBgState référence les littéraux `bg_*`) ; Task 2 (champs SessionInfo) avant Task 3 (bgAlive les lit) et Task 4 (render-loop lit `kind`). Chaque task finit sur un `pnpm build` qui passe.
- **Pas de placeholder :** chaque step montre le code complet à insérer/remplacer, avec chemins exacts.
- **Déviation assumée :** `jobId` listé dans la spec §1 mais non consommé → omis (YAGNI), noté en Task 2 Step 1.
