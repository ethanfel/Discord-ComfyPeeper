# Install guide

ComfyPeeper is a **Vencord user-plugin**. User-plugins only work in a **Vencord built from
source** — the one-click Vencord installer build cannot load them. You do **not** build Discord
or Vesktop from source: regular installed Discord/Vesktop are the hosts, and the source build is
only the Vencord bundle that contains the plugin. Pick your client below.

> **On Windows?** Use the **[Windows install guide → INSTALL-WINDOWS.md](INSTALL-WINDOWS.md)**
> (PowerShell commands + Windows paths). The steps below assume Linux/macOS.

- [Prerequisites](#prerequisites)
- [Linux automatic installer](#linux-automatic-installer)
- [Vencord (Discord desktop)](#vencord-discord-desktop)
- [Vesktop](#vesktop)
- [Updating](#updating)
- [Uninstalling / reverting](#uninstalling--reverting)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- [Node.js](https://nodejs.org) 18+ and [pnpm](https://pnpm.io) (`npm i -g pnpm`)
- `git`
- This repo cloned somewhere:
  ```bash
  git clone https://github.com/ethanfel/Discord-ComfyPeeper
  ```

---

## Linux automatic installer

Recommended for most Linux users:

```bash
cd Discord-ComfyPeeper
./scripts/install-linux.sh
```

The script shows a menu for:

- **Discord desktop**: builds Vencord, then injects that custom Vencord build into regular
  Discord.
- **Vesktop**: builds Vencord, then copies the built files to the regular Vesktop managed Vencord
  directory.
- **Browser userscript**: builds `Vencord.user.js` for Tampermonkey.

It is safe to rerun. It handles common partial installs:

- Reuses an existing `~/Vencord` source checkout, or clones it if missing.
- Clones into an existing empty `~/Vencord` folder.
- Replaces an older `src/userplugins/comfyPeeper` copy before rebuilding.
- Warns if Discord or Vesktop is still running.
- Detects the normal Vesktop config path, Flatpak Vesktop, and Snap Vesktop. If Vesktop was just
  installed, launch it once, fully quit it, then rerun the script.

Direct examples:

```bash
# Vesktop only, with default yes answers
./scripts/install-linux.sh --client vesktop --yes

# Discord desktop
./scripts/install-linux.sh --client discord

# Browser / Tampermonkey
./scripts/install-linux.sh --client browser
```

The manual steps below do the same thing and are useful for troubleshooting. On macOS, use the
manual steps.

---

## Vencord (Discord desktop)

1. **Build Vencord from source** (follow the official guide:
   <https://docs.vencord.dev/installing/custom-plugins/>):
   ```bash
   git clone https://github.com/Vendicated/Vencord ~/Vencord
   cd ~/Vencord
   pnpm install --frozen-lockfile
   ```
2. **Add the plugin:**
   ```bash
   mkdir -p ~/Vencord/src/userplugins
   rm -rf ~/Vencord/src/userplugins/comfyPeeper
   cp -r /path/to/Discord-ComfyPeeper/comfyPeeper ~/Vencord/src/userplugins/comfyPeeper
   ```
3. **Build & inject:**
   ```bash
   pnpm build
   pnpm inject     # choose your Discord install; skip if already injected
   ```
4. **Restart Discord** → **Settings → Plugins** → enable **ComfyPeeper** → set your endpoints.

---

## Vesktop

Use your normal installed Vesktop. You do **not** build Vesktop from source. The only source build
is Vencord with ComfyPeeper copied into `src/userplugins`.

Vesktop bundles its own Vencord. Importantly, **Vesktop (tested on 1.6.5) ignores the custom
"Vencord location" (`vencordDir`) setting** — so you must place the custom Vencord build in the
directory Vesktop *actually* loads from.

### Option A — Linux automatic installer

From the repo root:

```bash
./scripts/install-linux.sh --client vesktop
```

It handles normal, Flatpak, and Snap Vesktop config paths.

### Option B — Vesktop-only helper script

From the repo root:

```bash
VENCORD_DIR=~/Vencord ./scripts/install-vesktop.sh
```

It will: build a source Vencord (cloning one to `$VENCORD_DIR` if missing), bundle ComfyPeeper,
and copy the result into Vesktop's managed Vencord directory
(`~/.config/vesktop/sessionData/vencordFiles/`).

Then **fully quit Vesktop from the tray** (not just close the window — it minimises to tray) and
reopen it. Enable **ComfyPeeper** in Settings → Plugins.

### Option C — manual

```bash
# 1. a from-source Vencord with the plugin
git clone https://github.com/Vendicated/Vencord ~/Vencord
cd ~/Vencord
pnpm install --frozen-lockfile
mkdir -p src/userplugins
rm -rf src/userplugins/comfyPeeper
cp -r /path/to/Discord-ComfyPeeper/comfyPeeper src/userplugins/comfyPeeper
pnpm build

# 2. copy the built files into the dir Vesktop loads
MANAGED=~/.config/vesktop/sessionData/vencordFiles
cp dist/vencordDesktopMain.js dist/vencordDesktopPreload.js \
   dist/vencordDesktopRenderer.js dist/vencordDesktopRenderer.css "$MANAGED"/
```

Fully quit Vesktop (tray → Quit) and reopen → enable **ComfyPeeper**.

> **Why not `vencordDir`?** Vesktop validates a custom dir by requiring `package.json` + the
> `vencordDesktop*` files, and on this version the setting is not honored from `settings.json`.
> Overwriting the managed copy is the reliable route. The managed copy is stable across launches.

---

## Browser (Tampermonkey userscript)

You can also run ComfyPeeper on **Discord in a web browser** via Vencord's userscript build.

There's no Electron main process in a browser, so ComfyPeeper's native module is unavailable —
but it ships a renderer fallback (`webFallback.ts`) that does the same metadata parsing with
plain `fetch`. Discord's CDN allows cross-origin reads, so **detection, preview, library, and the
upload sidecar all work**. And because Vencord's userscript rewrites `fetch` →
`GM_xmlhttpRequest` (which bypasses both CORS *and* mixed-content), **queueing to ComfyUI also
works — including a remote `http://` instance** — with no `--enable-cors-header` needed.

> **Tampermonkey only.** Violentmonkey / Greasemonkey-on-Firefox can't override `window` on
> CSP-protected sites like Discord, so they won't work. Use Tampermonkey (any Chromium browser,
> or Firefox + Tampermonkey).

### Steps

1. Install the **Tampermonkey** extension in your browser.
2. Build the userscript (clones a source Vencord to `$VENCORD_DIR` if missing):

   ```bash
   VENCORD_DIR=~/Vencord ./scripts/build-userscript.sh
   ```

   This produces `~/Vencord/dist/Vencord.user.js` with ComfyPeeper baked in.
3. Install it in Tampermonkey: dashboard → **Utilities → Import from file** (or open the
   `.user.js` file in the browser and confirm the install prompt).
4. Open **discord.com**, click the **Vencord cog**, enable **ComfyPeeper**, and set your ComfyUI
   endpoints.

To update later, re-run `build-userscript.sh` and re-import the file in Tampermonkey.

---

## Updating

After pulling new changes to this repo (or to Vencord):

```bash
# Vencord desktop
./scripts/install-linux.sh --client discord

# Vesktop
./scripts/install-linux.sh --client vesktop   # then quit + reopen Vesktop

# Browser
./scripts/install-linux.sh --client browser   # then re-import the userscript in Tampermonkey
```

If a Vencord auto-update ever overwrites Vesktop's managed copy and the badge disappears, just
re-run the Vesktop step.

---

## Uninstalling / reverting

- **Vencord desktop:** delete `~/Vencord/src/userplugins/comfyPeeper`, `pnpm build`, restart.
- **Vesktop:** restore the backup the helper made
  (`~/.config/vesktop/sessionData/vencordFiles.bak`), or just let Vesktop re-download its Vencord
  by deleting the managed `vencordFiles` folder; restart Vesktop.

---

## Troubleshooting

| symptom | fix |
|---|---|
| Plugin not in the list | You're on the installer build, not a source build — rebuild from source. Confirm `~/Vencord/src/userplugins/comfyPeeper/index.tsx` exists before building. On Vesktop, also confirm the files landed in `~/.config/vesktop/sessionData/vencordFiles/`. |
| Badge never appears | Enable **MessageAccessoriesAPI** (auto-enabled). Image must be an original-quality attachment (re-compressed media loses metadata). Try `autoScan` on. |
| Overlay badge not on the image | Set **badgeMode → Below the message** (overlay relies on Discord's DOM layout). |
| Queue says "missing nodes" | The server lacks those custom nodes — install them or use **Check servers** to pick one that has them. |
| Changes don't show after rebuild | Fully **quit Vesktop from the tray** and reopen (closing the window isn't enough). |
