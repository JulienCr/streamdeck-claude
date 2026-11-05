# Kill agressif d'un agent par appui long (3s) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ajouter un 3ᵉ palier d'appui sur les slots agents — maintenir ≥3s tue le process de la session (SIGTERM puis SIGKILL), avec un anneau de progression "KILL" affiché pendant le hold.

**Architecture:** Nouveau module `kill-session.ts` (dispatch par plateforme, `process.kill` natif sur macOS). `SlotAction` arme deux timers (wipe-log à 500ms, kill à 3s) et porte un flag temporel `killArmingSince` + le `pid`. Le `render-loop` dessine une frame "KILL" animée tant que `killArmingSince` est posé ; le tick d'animation re-render quand un slot est en arming.

**Tech Stack:** TypeScript ESM (Node 20, `strict`), rollup, SVG via `setImage`. **Pas de suite de tests** dans ce repo — la vérification se fait par `pnpm build` (le typecheck rollup sert de garde-fou) + test manuel sur le Stream Deck. Les étapes "test" du squelette TDD sont donc remplacées par build + vérif manuelle.

**Imports:** rappel projet — les imports de modules `.ts` utilisent l'extension `.js` (NodeNext).

---

### Task 1: Module `kill-session.ts`

**Files:**
- Create: `src/kill-session.ts`

- [ ] **Step 1: Écrire le module**

```ts
import { platform } from "node:os";
import streamDeck from "@elgato/streamdeck";
import type { SessionOrigin } from "./sessions.js";
import { WSL_DISTRO } from "./env.js";
import { spawnCapture } from "./spawn-capture.js";

/** Délai avant d'escalader SIGTERM → SIGKILL si le process refuse de partir. */
const SIGKILL_ESCALATION_MS = 2000;

/**
 * Best-effort : termine le process d'une session Claude Code. SIGTERM d'abord,
 * puis SIGKILL après SIGKILL_ESCALATION_MS s'il est toujours vivant.
 *
 * Dispatch par plateforme (miroir de live-pids.ts). Sur macOS/Linux la session
 * vit dans notre propre namespace de process, donc `process.kill` direct suffit
 * (le tag `origin` y vaut "wsl" mais est sans effet). La branche win32 est
 * dormante sur Mac.
 */
export async function killSession(pid: number, origin: SessionOrigin): Promise<void> {
  if (platform() === "win32") {
    await killWindows(pid, origin);
    return;
  }
  killNative(pid);
}

function killNative(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ESRCH") return; // déjà mort
    streamDeck.logger.warn(`SIGTERM ${pid} failed: ${code ?? String(err)}`);
    return;
  }
  setTimeout(() => {
    try {
      process.kill(pid, 0); // sonde : throw ESRCH si mort
      process.kill(pid, "SIGKILL");
      streamDeck.logger.info(`escalated to SIGKILL for ${pid}`);
    } catch {
      // déjà mort entre-temps — rien à faire
    }
  }, SIGKILL_ESCALATION_MS);
}

async function killWindows(pid: number, origin: SessionOrigin): Promise<void> {
  if (origin === "wsl") {
    await spawnCapture("wsl.exe", ["-d", WSL_DISTRO, "--", "kill", "-TERM", String(pid)]);
    setTimeout(() => {
      void spawnCapture("wsl.exe", ["-d", WSL_DISTRO, "--", "kill", "-KILL", String(pid)]);
    }, SIGKILL_ESCALATION_MS);
    return;
  }
  await spawnCapture("taskkill.exe", ["/PID", String(pid), "/T"]);
  setTimeout(() => {
    void spawnCapture("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
  }, SIGKILL_ESCALATION_MS);
}
```

- [ ] **Step 2: Vérifier que `WSL_DISTRO` et `spawnCapture` sont exportés comme attendu**

Run: `grep -n "export.*WSL_DISTRO" src/env.ts && grep -n "export.*spawnCapture" src/spawn-capture.ts`
Expected: une ligne pour chacun (les deux sont déjà utilisés par `live-pids.ts`).

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: build OK, aucune erreur TypeScript (le module est autonome, non encore importé).

- [ ] **Step 4: Commit**

```bash
git add src/kill-session.ts
git commit -m "feat(kill): add killSession (SIGTERM then SIGKILL escalation)"
```

---

### Task 2: Frame de rendu `renderKillArming`

**Files:**
- Modify: `src/icons/render.ts`

- [ ] **Step 1: Ajouter la fonction en fin de `render.ts`**

Les imports nécessaires (`splitLabel`, `textLine`, `xmlEscape`, `TOP_BASELINE`, `TOP_FONT`, `BORDER_INSET`, `BORDER_SIZE`, `BORDER_RADIUS`, `BORDER_STROKE`) sont **déjà** présents en tête de fichier. Ajouter après `renderIcon` :

```ts
/** Palette dédiée à l'état "kill en cours d'armement" (hors registre STATES :
 *  ce n'est pas un SessionState, juste un overlay éphémère pendant le hold). */
const KILL_BG = "#1a0606";
const KILL_ACCENT = "#ef4444";

export interface KillArmingOptions {
  slot: number;
  label: string;
  /** 0..1 — fraction du hold écoulée entre LONG_PRESS_MS et KILL_PRESS_MS. */
  progress: number;
}

/** Tile rouge avec un anneau de progression + label "KILL", affichée pendant
 *  que l'utilisateur maintient la touche entre 500ms et 3s. À 1.0 l'anneau est
 *  plein → le kill part. Relâcher avant ramène le slot à son état normal. */
export function renderKillArming({ slot, label, progress }: KillArmingOptions): string {
  const p = Math.max(0, Math.min(1, progress));
  const cx = 72;
  const cy = 80;
  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = (circ * (1 - p)).toFixed(2);
  const overlayOpacity = (0.15 + p * 0.45).toFixed(3);
  const { top } = splitLabel(label);
  const topLine = textLine({
    text: top,
    baseline: TOP_BASELINE,
    fontSize: TOP_FONT,
    weight: "700",
    color: KILL_ACCENT,
    now: Date.now(),
    idSuffix: `k${slot}`,
  });
  const slotBadge = `<text x="128" y="22" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10" font-weight="700" fill="${KILL_ACCENT}" opacity="0.8" text-anchor="end">${xmlEscape(String(slot))}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
<rect width="144" height="144" fill="${KILL_BG}"/>
<rect width="144" height="144" fill="${KILL_ACCENT}" opacity="${overlayOpacity}"/>
<rect x="${BORDER_INSET}" y="${BORDER_INSET}" width="${BORDER_SIZE}" height="${BORDER_SIZE}" rx="${BORDER_RADIUS}" fill="none" stroke="${KILL_ACCENT}" stroke-width="${BORDER_STROKE}" stroke-linejoin="round" opacity="0.95"/>
${slotBadge}
${topLine}
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3a1414" stroke-width="6"/>
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${KILL_ACCENT}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${circ.toFixed(2)}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})"/>
<text x="${cx}" y="${cy + 6}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="17" font-weight="700" fill="${KILL_ACCENT}" text-anchor="middle">KILL</text>
</svg>`;
}
```

- [ ] **Step 2: Ré-exporter depuis le barrel `src/icons/index.ts`**

Le barrel utilise des exports nommés. Ajouter `renderKillArming` (et son type) à la ligne qui ré-exporte depuis `./render.js` :

```ts
export { iconNeedsAnimation, isAnimated, renderIcon, renderKillArming, type IconOptions, type KillArmingOptions } from "./render.js";
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: build OK (fonction exportée, non encore consommée).

- [ ] **Step 4: Commit**

```bash
git add src/icons/render.ts src/icons/index.ts
git commit -m "feat(icons): add renderKillArming progress-ring frame"
```

---

### Task 3: `SlotAction` — 3ᵉ timer + arming, câblage `plugin.ts`

Ces deux fichiers sont couplés (la signature du constructeur de `SlotAction` change), donc modifiés et buildés ensemble.

**Files:**
- Modify: `src/slot-action.ts`
- Modify: `src/plugin.ts`

- [ ] **Step 1: `slot-action.ts` — exporter les constantes de palier et ajouter `KILL_PRESS_MS`**

Remplacer le bloc constant existant :

```ts
/** Hold a slot key for at least this long to trigger the per-session reset
 *  instead of the default clipboard-copy short press. */
const LONG_PRESS_MS = 500;
```

par :

```ts
/** Hold ≥ this long → wipe just this agent's event log (palier 1). */
export const LONG_PRESS_MS = 500;
/** Hold ≥ this long → kill the agent process (palier 2). Le wipe à
 *  LONG_PRESS_MS a déjà eu lieu quand on atteint ce seuil. */
export const KILL_PRESS_MS = 3000;
```

- [ ] **Step 2: `slot-action.ts` — étendre `SlotState`**

Ajouter deux champs à l'interface `SlotState` :

```ts
export interface SlotState {
  /** SVG already rendered last tick — used to skip redundant setImage calls. */
  lastSvg?: string;
  /** What we copy to the clipboard when the key is short-pressed. */
  clipboardPayload?: string;
  /** Bound session — used by long-press to wipe just this agent's event log. */
  sessionId?: string;
  origin?: SessionOrigin;
  /** Bound session pid — required to kill the process on a ≥3s hold. */
  pid?: number;
  /** Wall-clock ms du début d'arming (≥LONG_PRESS_MS tenu). undefined = pas en
   *  arming. Lu par le render-loop pour dessiner l'anneau "KILL". */
  killArmingSince?: number;
}
```

- [ ] **Step 3: `slot-action.ts` — second timer + dépendance `killSlot`**

Ajouter la map de timers kill à côté de `pressTimers` :

```ts
  /** Armed kill timers (fire at KILL_PRESS_MS). Same lifecycle as pressTimers. */
  private readonly killTimers = new Map<string, NodeJS.Timeout>();
```

Étendre le constructeur :

```ts
  constructor(
    private readonly resetSlot: (sessionId: string, origin: SessionOrigin) => Promise<void>,
    private readonly killSlot: (pid: number, sessionId: string, origin: SessionOrigin) => Promise<void>,
  ) {
    super();
  }
```

- [ ] **Step 4: `slot-action.ts` — réécrire `onKeyDown`**

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
    const wipeTimer = setTimeout(() => {
      this.pressTimers.delete(id);
      // Palier 1 atteint : wipe le log ET arme le feedback visuel + la fenêtre kill.
      slot.killArmingSince = Date.now();
      void this.runLongPress(ev, sessionId, origin);
    }, LONG_PRESS_MS);
    this.pressTimers.set(id, wipeTimer);
    const killTimer = setTimeout(() => {
      this.killTimers.delete(id);
      slot.killArmingSince = undefined;
      void this.runKill(ev, pid, sessionId, origin);
    }, KILL_PRESS_MS);
    this.killTimers.set(id, killTimer);
  }
```

- [ ] **Step 5: `slot-action.ts` — réécrire `onKeyUp`**

```ts
  override async onKeyUp(ev: KeyUpEvent): Promise<void> {
    const id = ev.action.id;
    const wipeTimer = this.pressTimers.get(id);
    const killTimer = this.killTimers.get(id);
    if (wipeTimer) {
      // Relâché avant 500ms → short press (copie + Warp). Annule tout.
      clearTimeout(wipeTimer);
      this.pressTimers.delete(id);
      if (killTimer) {
        clearTimeout(killTimer);
        this.killTimers.delete(id);
      }
      await this.runShortPress(ev);
      return;
    }
    if (killTimer) {
      // Relâché entre 500ms et 3s → le wipe a déjà eu lieu. Annule le kill et
      // l'arming visuel ; le render-loop reprend l'état normal au prochain tick.
      clearTimeout(killTimer);
      this.killTimers.delete(id);
      const slot = this.state.get(id);
      if (slot) slot.killArmingSince = undefined;
      return;
    }
    // Relâché après 3s → kill déjà fired, no-op.
  }
```

- [ ] **Step 6: `slot-action.ts` — ajouter `runKill` et `anyKillArming`, nettoyer dans `onWillDisappear`**

Ajouter après `runLongPress` :

```ts
  private async runKill(
    ev: KeyDownEvent,
    pid: number,
    sessionId: string,
    origin: SessionOrigin,
  ): Promise<void> {
    try {
      await this.killSlot(pid, sessionId, origin);
      await ev.action.showOk();
    } catch (err) {
      streamDeck.logger.error(`kill failed for ${origin}/${sessionId} pid=${pid}`, err);
      await ev.action.showAlert();
    }
  }

  /** True if any visible slot is mid-hold past LONG_PRESS_MS — consumed by the
   *  animation tick so the progress ring keeps advancing. */
  anyKillArming(): boolean {
    for (const s of this.state.values()) {
      if (s.killArmingSince !== undefined) return true;
    }
    return false;
  }
```

Dans `onWillDisappear`, après le nettoyage de `pressTimers`, ajouter le nettoyage de `killTimers` et de l'arming :

```ts
  override onWillDisappear(ev: WillDisappearEvent): void | Promise<void> {
    this.instances.delete(ev.action.id);
    this.state.delete(ev.action.id);
    const t = this.pressTimers.get(ev.action.id);
    if (t) {
      clearTimeout(t);
      this.pressTimers.delete(ev.action.id);
    }
    const k = this.killTimers.get(ev.action.id);
    if (k) {
      clearTimeout(k);
      this.killTimers.delete(ev.action.id);
    }
    streamDeck.logger.info(`willDisappear: id=${ev.action.id} total=${this.instances.size}`);
  }
```

- [ ] **Step 7: `plugin.ts` — importer `killSession`, ajouter `killSlot`, câbler le constructeur et le tick d'animation**

Ajouter l'import en tête :

```ts
import { killSession } from "./kill-session.js";
```

Ajouter la fonction après `resetSlot` :

```ts
async function killSlot(pid: number, sessionId: string, origin: SessionOrigin): Promise<void> {
  streamDeck.logger.info(`kill requested for ${origin}/${sessionId} pid=${pid}`);
  await killSession(pid, origin);
  // Refresh : l'agent passera "finished" puis disparaîtra au tick suivant.
  await runSlowTick();
}
```

Modifier l'instanciation :

```ts
const slotAction = new SlotAction(resetSlot, killSlot);
```

Modifier la condition du tick d'animation (le `if (!tracker.needsAnimation())`) pour tenir compte de l'arming :

```ts
  if (!tracker.needsAnimation() && !slotAction.anyKillArming()) {
    animateRunning = false;
    return;
  }
```

- [ ] **Step 8: Build**

Run: `pnpm build`
Expected: build OK. (`renderKillArming` reste non consommé jusqu'à Task 4 — c'est attendu.)

- [ ] **Step 9: Commit**

```bash
git add src/slot-action.ts src/plugin.ts
git commit -m "feat(slot): 3rd press tier arms kill at 3s; wire killSlot"
```

---

### Task 4: `render-loop.ts` — dessiner la frame d'arming + propager `pid`

**Files:**
- Modify: `src/render-loop.ts`

- [ ] **Step 1: Importer `renderKillArming` et les constantes de palier**

En tête de `render-loop.ts`, étendre les imports :

```ts
import { isAnimated, renderIcon, renderKillArming } from "./icons/index.js";
import { KILL_PRESS_MS, LONG_PRESS_MS } from "./slot-action.js";
```

(`SlotAction` est déjà importé en `type` ; ajouter l'import de valeurs des constantes via une seconde ligne comme ci-dessus, ou fusionner si l'import de `slot-action.js` existe déjà.)

- [ ] **Step 2: Propager `pid` et brancher l'arming dans la boucle**

Dans `renderAll`, remplacer le bloc qui va de `const slotState = slotAction.getState(action.id);` jusqu'à la fin de la boucle `for` par :

```ts
    const slotState = slotAction.getState(action.id);
    if (!slotState) continue;
    slotState.clipboardPayload = entry?.session.cwd;
    slotState.sessionId = entry?.session.sessionId;
    slotState.origin = entry?.session.origin;
    slotState.pid = entry?.session.pid;

    // Hold passé LONG_PRESS_MS : on masque l'état normal par l'anneau "KILL"
    // tant que la touche reste enfoncée (killArmingSince posé par SlotAction).
    if (slotState.killArmingSince !== undefined) {
      const elapsed = Date.now() - slotState.killArmingSince;
      const progress = Math.max(0, Math.min(1, elapsed / (KILL_PRESS_MS - LONG_PRESS_MS)));
      const killSvg = renderKillArming({ slot: slotIndex, label, progress });
      const killUrl = "data:image/svg+xml;base64," + Buffer.from(killSvg, "utf8").toString("base64");
      if (slotState.lastSvg !== killUrl) {
        slotState.lastSvg = killUrl;
        pending.push(
          action.setImage(killUrl).catch((err) => {
            streamDeck.logger.error(`setImage(kill) failed for slot ${slotIndex}`, err);
          }),
        );
      }
      continue;
    }

    if (slotState.lastSvg === dataUrl) continue;
    slotState.lastSvg = dataUrl;
    pending.push(
      action.setImage(dataUrl).catch((err) => {
        streamDeck.logger.error(`setImage failed for slot ${slotIndex}`, err);
      }),
    );
```

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: build OK, aucune erreur.

- [ ] **Step 4: Commit**

```bash
git add src/render-loop.ts
git commit -m "feat(render): show KILL progress ring while a slot is kill-arming"
```

---

### Task 5: Validation intégrée

**Files:** aucun (vérification).

- [ ] **Step 1: Build + validate**

Run: `pnpm build && pnpm sd:validate`
Expected: build OK, manifest/assets valides.

- [ ] **Step 2: Reload du plugin**

Run: `pnpm sd:reload`
Expected: le plugin self-exit puis est respawné (~1s) par l'app Stream Deck.

- [ ] **Step 3: Test manuel des 3 paliers**

Lancer un `claude` dans un terminal (slot apparaît), puis sur la touche correspondante :
1. **Appui court (<500ms)** → la touche fait `showOk`, le `cwd` est dans le presse-papier (Cmd+V pour vérifier), l'onglet Warp est focus si trouvé.
2. **Appui maintenu ~1s puis relâché** → la touche affiche brièvement l'anneau "KILL" (faible), l'agent repasse idle (log wipé), pas de kill. En relâchant entre 0.5 et 3s, l'agent reste vivant.
3. **Appui maintenu ≥3s** → l'anneau se remplit jusqu'au bout, `showOk`, puis le process meurt.

- [ ] **Step 4: Confirmer la mort du process**

Run: `ps -p <pid de la session>` (le pid est dans `~/.claude/sessions/<pid>.json`, ou via Activity Monitor)
Expected: process absent. La touche passe "finished" (check vert) puis se vide au TTL.

- [ ] **Step 5: Vérifier les logs**

Inspecter les logs du plugin (`~/Library/Application Support/com.elgato.StreamDeck/Plugins/com.julien.claudesessions.sdPlugin/logs/` sur macOS) :
Expected: ligne `kill requested for wsl/<sessionId> pid=<pid>` ; le cas échéant `escalated to SIGKILL for <pid>` si SIGTERM n'a pas suffi. Pas d'erreur `kill failed`.

---

## Notes de vérification du plan (self-review)

- **Couverture spec :** Task 1 = `kill-session.ts` (SIGTERM→SIGKILL) ✓ ; Task 2 = frame `renderKillArming` ✓ ; Task 3 = 3ᵉ timer + `pid`/`killArmingSince` dans `SlotState` + `anyKillArming` + câblage `plugin.ts` (killSlot, condition anim) ✓ ; Task 4 = branche render-loop + propagation `pid` ✓ ; Setup button = inchangé (confirmé hors scope) ✓.
- **Cohérence des types :** `killSession(pid, origin)`, `killSlot(pid, sessionId, origin)`, `renderKillArming({ slot, label, progress })`, `anyKillArming()`, `LONG_PRESS_MS`/`KILL_PRESS_MS` (exportés depuis `slot-action.ts`, consommés par `render-loop.ts`) — noms cohérents d'une task à l'autre.
- **Buildabilité :** chaque task termine sur un `pnpm build` qui passe ; les couplages de signature (constructeur `SlotAction`) sont regroupés en Task 3 pour éviter un état intermédiaire non compilable.
- **Step 2 de Task 2 :** seule étape conditionnelle (dépend de la forme du barrel `src/icons/index.ts`) — instruction explicite donnée pour les deux cas (`export *` vs export nommé).
