# Kill agressif d'un agent par appui long (3s)

**Date:** 2026-05-27
**Plateforme cible:** macOS (les branches WSL/Windows restent dormantes, écrites en miroir pour cohérence)

## Contexte

Le plugin affiche une touche par session Claude Code live. Aujourd'hui :

- **Bouton Setup** (`SetupAction.onKeyDown` + bouton "Refresh States" du PI) → `refreshNow()` qui wipe **tous** les `*.events.ndjson` puis re-tick. Comportement conservé tel quel — il fonctionne déjà à l'appui de la touche physique comme via le PI. **Aucun changement.**
- **Slot agent** (`SlotAction`) :
  - appui court (<500ms) → copie `cwd` dans le presse-papier + focus de l'onglet Warp correspondant
  - appui long (≥500ms, `LONG_PRESS_MS`) → `resetSlot` = wipe le `*.events.ndjson` de *cet* agent

Problème à résoudre : un agent reste affiché sur le Stream Deck mais son terminal est introuvable. On veut pouvoir **tuer le process** depuis la touche.

## Objectif

Ajouter un **3ᵉ palier** sur les slots agents : maintenir la touche **≥3s** tue le process de la session. Pendant le hold (entre 500ms et 3s), afficher un **feedback visuel "killing…"** animé (anneau de progression) pour signaler l'imminence du kill et permettre l'annulation en relâchant.

## Décisions validées

| Décision | Choix |
|---|---|
| Bouton Setup | Garder wipe-all (déjà en place, marche sur touche physique) |
| Force du kill | SIGTERM puis escalade SIGKILL si toujours vivant après ~2s |
| Paliers | 3 progressifs : <500ms copie · 500ms→3s wipe-log · ≥3s kill |
| pid pour le kill | Ajouté à `SlotState` (rempli dans le render-loop, comme `sessionId`/`origin`) |
| Sécurité | Feedback visuel animé pendant le hold (anneau de progression 500ms→3s) |

## Architecture

### 1. Nouveau module `src/kill-session.ts`

```ts
export async function killSession(pid: number, origin: SessionOrigin): Promise<void>
```

Dispatch par plateforme (miroir de `live-pids.ts`) :

- **darwin / linux** (notre cas) : `process.kill(pid, "SIGTERM")` immédiat. Puis, en tâche de fond (fire-and-forget, `setTimeout` ~2s), si `process.kill(pid, 0)` ne throw pas `ESRCH` (process encore vivant) → `process.kill(pid, "SIGKILL")`. `ESRCH` = déjà mort, succès. `EPERM` → log.
- **win32 + origin wsl** : `wsl.exe -d <distro> -- kill -TERM <pid>` puis `-KILL` (stub, dormant sur Mac).
- **win32 + origin windows** : `taskkill.exe /PID <pid> /T` puis `/F` (stub, dormant sur Mac).

Le SIGTERM part de façon synchrone (l'appelant `await` cette première phase) ; l'escalade SIGKILL est planifiée et n'est **pas** attendue (le handler ne bloque pas 2s).

> Note origin : sur macOS, `SESSION_SOURCES` ne contient qu'une source taguée `origin: "wsl"` (quirk historique = namespace local natif). Donc côté Mac, `killSession` part **toujours** dans la branche darwin via `process.kill`, indépendamment du tag `origin`. La dispatch teste `platform()` d'abord, `origin` seulement sur `win32`.

### 2. `src/slot-action.ts` — 3ᵉ timer + arming

Constantes :

```ts
const LONG_PRESS_MS = 500;   // inchangé : wipe-log
const KILL_PRESS_MS = 3000;  // nouveau : kill
```

`SlotState` gagne :

```ts
pid?: number;              // rempli par le render-loop, requis pour killSession
killArmingSince?: number;  // timestamp du début d'arming (≥500ms held); undefined = pas en arming
```

Gestion des timers dans `onKeyDown` (slot non vide) — on arme **deux** timers :

- `wipeTimer` à `LONG_PRESS_MS` : à l'échéance → `runLongPress` (wipe-log existant) **et** pose `slot.killArmingSince = Date.now()` (déclenche le feedback visuel).
- `killTimer` à `KILL_PRESS_MS` : à l'échéance → `runKill(pid, sessionId, origin)`, puis efface `killArmingSince`.

`onKeyUp` :

- relâché avant 500ms (`wipeTimer` encore pending) → clear les deux timers, **short press** (copie + Warp). Pas d'arming.
- relâché entre 500ms–3s (`wipeTimer` fired, `killTimer` pending) → clear `killTimer`, efface `killArmingSince` (annule l'arming → le render-loop reprend l'état normal au prochain tick). Le wipe-log a déjà eu lieu, rien d'autre.
- relâché après 3s → no-op (kill déjà fired).

`onWillDisappear` nettoie les deux timers et `killArmingSince`.

Nouvelle méthode publique `anyKillArming(): boolean` — true si au moins un slot a `killArmingSince` défini (consommée par le tick d'animation).

Le `SlotAction` reçoit une 2ᵉ dépendance dans son constructeur :

```ts
constructor(
  private readonly resetSlot: (sessionId, origin) => Promise<void>,
  private readonly killSlot: (pid, sessionId, origin) => Promise<void>,
)
```

### 3. `src/render-loop.ts` — frame "killing…"

Dans la boucle par slot, **avant** le rendu normal :

```ts
if (slotState.killArmingSince !== undefined) {
  const progress = clamp01((Date.now() - slotState.killArmingSince) / (KILL_PRESS_MS - LONG_PRESS_MS));
  const svg = renderKillArming({ slot: slotIndex, label, progress });
  // setImage avec dedup quantisé sur progress (ex: Math.round(progress*100))
  // on continue (skip le rendu d'état normal pour ce slot)
  continue;
}
```

Le presse-papier (`clipboardPayload`, `pid`, `sessionId`, `origin`) reste mis à jour avant ce branchement.

`renderKillArming` : nouvelle fonction dans `src/icons/render.ts` (hors registre `STATES`, ce n'est pas un `SessionState`) — tile rouge avec un **anneau de progression** (arc qui se remplit de 0 à 1) + label "KILL". Réutilise les constantes de `theme.ts`. Dédup via une clé quantisée pour ne pas spammer `setImage` (anneau quantisé au % entier ⇒ ~100 frames max sur 2.5s, en pratique ~20 au pas de 120ms).

### 4. `src/plugin.ts` — câblage

- Nouvelle fn `killSlot(pid, sessionId, origin)` : appelle `killSession(pid, origin)`, log le résultat, puis `runSlowTick()` pour rafraîchir (l'agent passera "finished" puis disparaîtra).
- `new SlotAction(resetSlot, killSlot)`.
- Tick d'animation : la condition de rendu devient `if (tracker.needsAnimation() || slotAction.anyKillArming())` pour que l'anneau s'anime pendant le hold même si rien d'autre ne bouge.

## Feedback utilisateur

- 500ms : l'agent passe en frame "killing…" (anneau à ~0%), wipe-log silencieux en arrière-plan.
- 500ms→3s : l'anneau se remplit. Relâcher annule (retour à l'état normal au tick suivant).
- 3s : `runKill` → `showOk()`, process reçoit SIGTERM (puis SIGKILL si récalcitrant). Confirmation réelle = l'agent passe "finished" puis disparaît.

## Hors scope

- Pas de changement au bouton Setup.
- Pas de confirmation modale (le hold 3s + anneau visible suffit comme garde-fou).
- Branches WSL/Windows de `killSession` écrites mais non testées (Mac-only pour l'instant).

## Fichiers touchés

| Fichier | Nature |
|---|---|
| `src/kill-session.ts` | **nouveau** — `killSession(pid, origin)` |
| `src/slot-action.ts` | 3ᵉ timer, `killArmingSince`/`pid` dans `SlotState`, `anyKillArming()`, dep constructeur |
| `src/render-loop.ts` | branche kill-arming → `renderKillArming` |
| `src/icons/render.ts` | **nouvelle** fn `renderKillArming({ slot, label, progress })` |
| `src/plugin.ts` | fn `killSlot`, câblage `SlotAction`, condition tick anim |

## Vérification

Pas de suite de tests. Validation manuelle :
`pnpm build && pnpm sd:validate && pnpm sd:reload`, puis sur le Stream Deck : lancer un `claude`, vérifier les 3 paliers (copie / wipe / anneau→kill), confirmer que le process meurt (`ps`/Activity Monitor) et que la touche passe finished puis se vide.
