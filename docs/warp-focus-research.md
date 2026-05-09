# Warp focus research — peut-on focuser le pane Warp d'une session Claude depuis le plugin ?

> Date : 2026-05-09. Hôte testé : Windows 10/11 + Warp installé sous `C:\Users\julie\AppData\Local\Programs\Warp\`. Process Warp en RAM observé : PID 41644 unique, 2 fenêtres visibles.

## Le problème

Le keypress du Stream Deck copie déjà le `cwd` de la session Claude (`src/slot-action.ts:46-59`). On voudrait, en plus ou à la place, **amener au premier plan le pane Warp où tourne précisément cette session Claude**.

Architecture actuelle : on a, par session, `pid` + `sessionId` + `cwd` + `origin (wsl|windows)`. Pas plus. Le plugin tourne sous le SD app sur Windows. Les sessions WSL (le cas habituel) ont un PID Linux **invisible** côté Windows.

## Méthodologie

Sondage direct de l'install Warp + énumération Win32 des fenêtres + lecture des envs des processes Claude vivants. Aucune hypothèse non vérifiée n'a été retenue ; on liste ci-dessous les commandes utilisées pour qu'on puisse re-vérifier en cas d'évolution du produit.

### Commandes de sondage utiles à conserver

```bash
# Surface CLI dispo
ls /mnt/c/Users/julie/AppData/Local/Programs/Warp/{,bin/}
cat /mnt/c/Users/julie/AppData/Local/Programs/Warp/bin/warp.cmd      # = warp.exe %*
cat /mnt/c/Users/julie/AppData/Local/Programs/Warp/bin/oz.cmd        # ajoute WARP_CLI_MODE=1
cat /mnt/c/Users/julie/AppData/Local/Programs/Warp/pwsh.ps1          # shell-integration PS

# URI scheme enregistré ?
cmd.exe /c "reg query HKEY_CLASSES_ROOT\\warp /s"

# Sous-commandes warp.exe ? (silent no-op pour focus/goto/show)
cmd.exe /c "C:\\Users\\julie\\AppData\\Local\\Programs\\Warp\\warp.exe --help"
cmd.exe /c "C:\\Users\\julie\\AppData\\Local\\Programs\\Warp\\warp.exe focus 12345"

# Énumération des fenêtres Warp (HWND, classe, titre, visibilité)
# → script PowerShell qui Add-Type des P/Invoke EnumWindows + GetWindowText (cf. annexe).

# Toutes les actions URI bakées dans le binaire
strings /mnt/c/Users/julie/AppData/Local/Programs/Warp/warp.exe | grep -oE '://action/[a-z_/]+' | sort -u

# Strings shell-integration (OSC, WARP_SESSION_ID, etc.)
strings .../warp.exe | grep -iE '(WARP_PANE|WARP_SESSION|WARP_TAB|pane.?id|tab.?id)'

# WARP_SESSION_ID hérité par claude ?
for pid in $(ls ~/.claude/sessions/*.json | xargs -I{} basename {} .json | grep -E '^[0-9]+$'); do
  tr '\0' '\n' < /proc/$pid/environ 2>/dev/null | grep -E '^WARP_SESSION_ID='
done

# Walk parent chain
pid=$$
for i in $(seq 1 8); do
  comm=$(cat /proc/$pid/comm 2>/dev/null) || break
  ppid=$(awk '/^PPid:/{print $2}' /proc/$pid/status)
  echo "pid=$pid comm=$comm ppid=$ppid"
  pid=$ppid; [ "$pid" = 0 ] && break
done
```

## Ce qui existe

| Surface | Statut | Observation |
|---|---|---|
| `warp.cmd` / `warp.exe` sur PATH (`…\Warp\bin\`) | ✅ | `warp.cmd` n'est qu'un wrapper `warp.exe %*`. `oz.cmd` ajoute `WARP_CLI_MODE=1`. |
| Scheme URI `warp://` | ✅ | `HKEY_CLASSES_ROOT\warp\shell\open\command` → `"…\warp.exe" "%0"`. |
| Action URI `warp://action/new_window?path=<cwd>` | ✅ | **Seul** verb d'action présent dans les strings du binaire. Crée un nouveau window/tab à un path donné — pas un focus. |
| Protocole OSC shell-integration | ✅ | ESC `]9277;A`/`B` (output start/end), `]9278;d;<hex-json>` (messages JSON, ex. `InitShell`/`ExitShell`/`Bootstrapped`/`CommandFinished`), `]9279` (reset grid), `]9280;C/D` (autocomplete). Direction **shell → Warp uniquement**. |
| Identité par-pane côté Warp | ✅ (en interne) | Au démarrage du shell, `WARP_SESSION_ID="$(date +%s)$RANDOM"` est généré et envoyé via `]9278;d;{hook:"InitShell", value:{session_id:…, wsl_name:…}}`. Warp associe ce session_id au pane qui détient le pty. La table SQLite interne expose `tab_id`, `pane_id`, `code_pane_id`. |
| Titre de fenêtre = titre du tab actif | ✅ | Empiriquement : 2 fenêtres Warp visibles, titres = `CLAUDE PLUGIN` et `? Debug regen mod functionality`. |

## Ce qui n'existe pas (vérifié)

| Hoped-for | Réalité empirique |
|---|---|
| `warp://focus/<session_id>` ou tout autre verb de focus | **N'existe pas.** Seul `://action/new_window` est dans le binaire (`strings …warp.exe \| grep -oE '://action/[a-z_/]+'`). |
| `warp.exe focus` / `goto` / `show` / `attach` | **Silent no-op.** Aucune sortie, aucun side-effect observable. La CLI Warp n'a pas de `--help` documenté ; `WARP_CLI_MODE=1` ne change rien à la surface visible. |
| `WARP_SESSION_ID` dans l'env de claude | **Absent.** Walké la parent chain depuis le PID Claude (ex. 234003) → zsh → claude → zsh → WSL `Relay`/`SessionLeader` → systemd : la var est vide partout. Les init scripts de Warp visibles dans le binaire (qui exporteraient `WARP_SESSION_ID`) ne sont injectés que dans des shells Warp-managed côté Windows et ne traversent pas `wsl.exe` (pas de `WARP_SESSION_ID` dans `WSLENV`). |
| PID-walk vers une fenêtre Warp unique | **Indistinguable.** Les 2 fenêtres Warp visibles partagent **un seul PID 41644**. Walker les parents depuis le PID Claude jusqu'à `Warp.exe` mène toujours au même processus, donc à *toutes* les fenêtres simultanément. `SetForegroundWindow` aurait besoin du HWND, pas du PID. |
| OSC bidirectionnel (Warp → shell, ou shell qui demande à Warp de focuser) | **Aucun.** Aucune trace d'un OSC `focus_pane` / `set_active` / `select_tab` dans le binaire ou les scripts d'intégration. Le canal est unidirectionnel. |
| Env var per-pane visible aux child-processes | **Aucune.** Seul `WARP_HONOR_PS1=1` (paramètre, pas identifiant). Pas de `WARP_PANE_ID`, `WARP_TAB_ID`, `WARP_WINDOW_ID`. |

## Conclusion

> **Pane-level focus depuis le plugin = pas faisable** avec ce que Warp Windows expose aujourd'hui. Les briques sont chez Warp (il sait par où vient chaque OSC), mais aucune surface externe ne les expose.

Côté upstream :
- [warpdotdev/Warp#8611](https://github.com/warpdotdev/Warp/issues/8611) — "Session ID & Deep Link Support" — exactement la feature qu'on attend (`WARP_SESSION_ID` exposé + `warp://focus/<id>`). Statut : open, pas d'annonce.
- [warpdotdev/Warp#9083](https://github.com/warpdotdev/Warp/issues/9083) — "Expose Tab Configs via URI / CLI" — connexe.

## Ce qu'on peut quand même tenter (si on veut shipper)

Une action **best-effort de window-summon** (pas pane), 3 tiers :

1. **Title-match** : `EnumWindows` + filtre `pname=warp` + `GetWindowText` ; matche `MainWindowTitle` contre `basename(cwd)`. Si match unique → `SetForegroundWindow`.
2. **Single-window fallback** : si Warp n'a qu'une fenêtre visible, focus-la.
3. **Z-order fallback** : la fenêtre Warp la plus récemment active (`GetWindow GW_HWNDPREV`).

Le clipboard copy continue à tourner systématiquement, donc même un focus raté ne casse pas le flow paste-the-cwd.

**Limites assumées** :
- Quand le tab Claude n'est pas le tab actif d'une fenêtre, le titre de la fenêtre montre un *autre* tab → on ne match pas. La fenêtre choisie peut être la mauvaise.
- Aucune sélection de tab/pane à l'intérieur de la fenêtre. Tant que #8611 n'est pas shippée, c'est plafonné là.
- Sessions WSL et Windows-native passent par le même chemin (puisque le PID est inutilisable dans les deux cas, on tombe direct sur le matching par titre).

## Annexe : énumération des fenêtres Warp (PowerShell P/Invoke)

```powershell
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
}
'@
$warp = (Get-Process -Name warp).Id
$proc = [W+EnumWindowsProc]{
  param($h, $l)
  $pidOut = 0; [void][W]::GetWindowThreadProcessId($h, [ref]$pidOut)
  if ($warp -contains $pidOut -and [W]::IsWindowVisible($h)) {
    $t = New-Object System.Text.StringBuilder 512
    [void][W]::GetWindowTextW($h, $t, 512)
    if ($t.Length -gt 0) { Write-Host ("hwnd={0,8} pid={1} title='{2}'" -f $h, $pidOut, $t.ToString()) }
  }
  return $true
}
[void][W]::EnumWindows($proc, [IntPtr]::Zero)
```

Sortie typique :
```
hwnd=  134222 pid=41644 title='CLAUDE PLUGIN'
hwnd=  333898 pid=41644 title='? Debug regen mod functionality'
```

## Workarounds tiers — non applicables ici

### `cc-switch` PR #2466 — `warp://action/new_tab?path=<script>`

[`farion1231/cc-switch#2466`](https://github.com/farion1231/cc-switch/pull/2466) (mergée) montre comment **lancer Warp avec une commande à exécuter** :

```rust
let mut warp_url = url::Url::parse("warp://action/new_tab").unwrap();
warp_url.query_pairs_mut().append_pair("path", &script_file.path().to_string_lossy());
Command::new("open").args(["-a", "Warp", &warp_url.to_string()]).status()
```

Le script tempfile s'`exec` lui-même puis se `rm`. Astucieux, mais :

- **macOS / Linux uniquement** (`#[cfg(unix)]` + `open -a Warp`). Pas porté sur Windows dans la PR.
- **Crée un nouveau tab/fenêtre** — ce n'est pas un focus d'un pane existant. Si on l'adoptait pour le keypress, chaque press ouvrirait un *énième* tab Warp dans le même cwd. Pas ce qu'on veut.
- Sur le binaire Windows installé (2026-04-27), seul `://action/new_window` apparaît dans les strings ; `://action/new_tab` n'est pas présent. À tester par invocation directe avant d'y compter — la doc officielle le mentionne mais il pourrait n'être actif que sur Mac.

Conclusion : utile à connaître pour une feature séparée *"créer un nouveau tab Claude depuis le Stream Deck"*, mais ne résout pas le problème de focus.

## Scripts de re-vérification

`scripts/check-warp/probe.sh` sonde toutes les surfaces ci-dessus et imprime un rapport markdown avec verdict (`🟢` = quelque chose de critique a flippé depuis le baseline 2026-05-09 ; `🔴` = inchangé). À runner après chaque update Warp :

```bash
bash scripts/check-warp/probe.sh                              # rapport sur stdout
bash scripts/check-warp/probe.sh > docs/warp-surface-$(date +%Y%m%d).md   # archive datée
```

Exit code 0 = focus possiblement débloqué, 1 = inchangé, 2 = Warp pas installé / pas runnable.

## À reprendre

- Re-runner `scripts/check-warp/probe.sh` après chaque update Warp.
- Surveiller [warpdotdev/Warp#8611](https://github.com/warpdotdev/Warp/issues/8611) : son shipping débloque le pane-level focus et rend caduque toute la section "best-effort".
- Si la priorité passe à *"ouvrir un nouveau tab Claude"* (workflow différent), porter le pattern cc-switch sur Windows : `cmd /c start warp://action/new_tab?path=<…>` (sous réserve que `new_tab` réponde côté Windows).
