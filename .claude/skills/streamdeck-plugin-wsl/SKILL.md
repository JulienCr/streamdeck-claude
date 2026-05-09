---
name: streamdeck-plugin-wsl
description: Use when building or debugging an Elgato Stream Deck plugin from inside WSL. Covers the @elgato/streamdeck Node SDK v2 patterns (SingletonAction + decorator + manual registration, setImage with SVG, manifest layout) and the WSL ↔ Windows symlink + reload workarounds — when `streamdeck link` produces a Linux-style symlink the SD app can't follow, when `streamdeck restart`/`list` errors out with EIO, when setImage doesn't update keys, or when the manifest validator rejects icons.
---

# Building Stream Deck plugins from WSL

The official Elgato docs assume a native Windows or macOS dev box. From WSL most things work, but several spots have a "looks fine, silently broken" failure mode. This skill captures every workaround we've validated end-to-end while shipping `streamdeck-claude`.

## SDK quick reference (`@elgato/streamdeck`, SDK v2)

```ts
import streamDeck, { action, SingletonAction, KeyDownEvent, WillAppearEvent } from "@elgato/streamdeck";

@action({ UUID: "com.example.thing.action" })
export class ThingAction extends SingletonAction {
  override onWillAppear(ev: WillAppearEvent) { /* ev.action.coordinates is your slot index */ }
  override async onKeyDown(ev: KeyDownEvent) { await ev.action.setImage(svgString); }
}

// REQUIRED — the @action decorator only stamps `manifestId`. It does NOT register the
// instance with the SDK. Without this line, every event handler is silently ignored.
streamDeck.actions.registerAction(new ThingAction());
await streamDeck.connect();
```

This was the #1 mistake during initial development. If your action's handlers never fire, this is the cause 90% of the time.

`tsconfig.json` must NOT set `experimentalDecorators: true` — the SDK uses TC39-stage-3 decorators (`ClassDecoratorContext`), not the legacy form. Leave both `experimentalDecorators` and `emitDecoratorMetadata` unset.

`setImage(image)` accepts:
- `imgs/foo.png` — path inside the .sdPlugin folder
- A raw `<svg …>` string
- A `data:image/svg+xml;base64,…` URL

Across SD app versions the data-URL form is the most reliable; raw SVG works in current versions but base64 is what we ship.

## manifest.json gotchas

- `States[].Image` and `Actions[].Icon` are paths **without** the file extension; SD picks PNG > SVG > GIF.
- Validator (`streamdeck validate`) **rejects SVG for `Icon` and `CategoryIcon`** — must be PNG. Each plugin/category PNG also needs an `@2x` variant (e.g. `marketplace.png` 144×144 + `marketplace@2x.png` 288×288). For action State `Image`, SVG is fine.
- `Category` must literally match `Name` (validator warning otherwise).
- If you set a `URL`, it must respond 2xx. Omit it during early development to skip an HTTP probe.
- `Nodejs.Version` must be `"20"` or `"24"`. `OS` is a tuple of `{Platform, MinimumVersion}`. `SDKVersion` is `2` or `3`.
- Add `"DisableAutomaticStates": true` whenever you drive state transitions yourself (otherwise the SD app toggles between the manifest States on every press).

## WSL → Windows install (the real workaround)

The Stream Deck app on Windows needs a directory at `%APPDATA%\Elgato\StreamDeck\Plugins\<uuid>.sdPlugin`. Three paths to put one there from WSL:

| Approach | Result |
|---|---|
| `streamdeck link` from WSL | ❌ Creates a Linux-style symlink whose target is `/home/julien/...`. The SD app on Windows resolves the symlink but can't follow that path → "manifest not found". |
| `cmd.exe /c mklink /D` from WSL with inlined args | ❌ Backslash escaping mangles the UNC target — `\\wsl.localhost\…` arrives as `\\\wsl.localhost\…` and the link is dead-on-arrival. |
| **Drop a `.cmd` file under `/mnt/c/...` and run `cmd.exe /c file.cmd`** | ✅ This is the reliable shape. |

The working installer (see `scripts/link-plugin.sh`):
```sh
WIN_LINK="C:\\Users\\<u>\\AppData\\Roaming\\Elgato\\StreamDeck\\Plugins\\<uuid>.sdPlugin"
WIN_TARGET="\\\\wsl.localhost\\Ubuntu\\home\\<u>\\dev\\<project>\\<uuid>.sdPlugin"
CMD_FILE="/mnt/c/Users/<u>/.tmp-mklink.cmd"
cat > "$CMD_FILE" <<EOF
@echo off
if exist "${WIN_LINK}" rmdir "${WIN_LINK}"
mklink /D "${WIN_LINK}" "${WIN_TARGET}"
EOF
( cd /mnt/c/Users/<u> && cmd.exe /c .tmp-mklink.cmd )
rm -f "$CMD_FILE"
```

`cmd.exe` refuses to chdir into a UNC path, so always `cd` to a real Windows-mapped directory before invoking it. Requires **Windows Developer Mode** to create symlinks without admin (Settings → Privacy → For developers).

## `streamdeck restart`/`list` from WSL → EIO

Once the plugin symlink target is a UNC path (per above), `streamdeck list` and `streamdeck restart` both blow up with `EIO: i/o error, readlink '<path>'`. The CLI cannot enumerate plugins where it can't readlink them, and `restart` calls `list` internally. There is no documented switch to skip the readlink.

Workaround we ship: **a self-reload trigger** inside the plugin.

```ts
// In plugin.ts — once per slow tick:
const PROCESS_START_MS = Date.now();
let lastReloadMtime = 0;
async function checkReload() {
  try {
    const s = await stat(RELOAD_FILE); // ~/.claude/.streamdeck-claude.reload (or anywhere)
    if (lastReloadMtime === 0) {
      lastReloadMtime = s.mtimeMs;
      // First sighting only counts as a trigger if the file was modified after we started.
      if (s.mtimeMs > PROCESS_START_MS) process.exit(0);
      return;
    }
    if (s.mtimeMs !== lastReloadMtime) process.exit(0);
  } catch {}
}
```

Then a `pnpm sd:reload` script `touch`es the file. The SD app respawns the plugin within ~1 s. **Watch out for the bug** above (the first-sighting branch): treat `lastReloadMtime === 0` AND `mtime > PROCESS_START_MS` as a trigger; otherwise a fresh reload file written *after* startup is silently swallowed and you wonder why nothing reloads.

Wire `--watch.onEnd` to the reload script for free hot-reload on every rollup rebuild.

## Running the @elgato/cli from WSL

- `pnpm exec streamdeck validate <uuid>.sdPlugin` works — but **needs `HOME=/mnt/c/Users/<u>`** so the CLI finds `AppData\Roaming\Elgato\StreamDeck\Plugins`. From WSL, `$HOME` is `/home/<u>`, where the CLI looks for `$HOME/AppData/...` and gets ENOENT.
- `streamdeck pack <uuid>.sdPlugin --output dist/` works the same way.
- **Do not** name a script `pack` in your `package.json` — it collides with `pnpm pack` (the npm-style tarball builder), which silently shadows your script. Namespace plugin commands as `sd:link`, `sd:pack`, `sd:validate`, etc.
- `streamdeck restart` and `streamdeck list` are unusable from WSL — see above.

## Project layout that works

```
<project>/
├── <uuid>.sdPlugin/
│   ├── manifest.json
│   ├── bin/                   # gitignored; rollup output lands here
│   │   ├── plugin.js
│   │   ├── package.json       # {"type": "module"} — emitted by rollup
│   │   └── build-info.json    # emitted by rollup; PI fetches this
│   ├── imgs/
│   │   ├── plugin/{marketplace,marketplace@2x,category-icon,category-icon@2x}.png
│   │   └── actions/<name>/{icon,icon@2x,key,key@2x}.png
│   └── ui/
│       └── <action>.html      # property inspector
├── src/                       # TS source
├── rollup.config.mjs
└── package.json               # devDeps include @elgato/cli, @elgato/streamdeck, rollup, typescript
```

Reference: `/home/julien/dev/streamdeck-claude/rollup.config.mjs` — note the two trailing emitFile plugins that drop `package.json` (so Node treats `bin/` as ESM) and `build-info.json` (timestamp for the property inspector).

## Build-info pattern (verify your reload actually picked up the new code)

Emit a JSON file from rollup with the build timestamp, fetch it from the property inspector. The PI shows "Last build: <timestamp>" and "Age: 12s ago" so you can see at a glance whether your reload landed. Reference: `com.julien.claudesessions.sdPlugin/ui/slot.html`.

```js
// In rollup.config.mjs
{
  name: "emit-build-info",
  generateBundle() {
    const now = new Date();
    this.emitFile({
      fileName: "build-info.json",
      type: "asset",
      source: JSON.stringify({ builtAt: now.toISOString(), unix: now.getTime() }),
    });
  },
},
```

```html
<!-- In the property inspector, with cache-busting -->
fetch("../bin/build-info.json?t=" + Date.now(), { cache: "no-store" })
```

## `tasklist.exe` quirk (only relevant if you spawn it from the plugin)

If your plugin needs to check whether arbitrary Windows PIDs are alive: **multiple `/FI "PID eq <n>"` filters are AND'd** by tasklist (no row matches multiple PIDs simultaneously). Don't try to batch — dump every process with `tasklist.exe /NH /FO CSV` once, parse the rows, intersect with your candidate PIDs in JS. One spawn, complete answer. (See `src/live-pids.ts` in `streamdeck-claude` for a working implementation.)
