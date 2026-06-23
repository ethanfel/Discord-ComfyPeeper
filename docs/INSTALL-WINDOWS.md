# Install guide (Windows)

ComfyPeeper is a **Vencord user-plugin**. User-plugins only load in a **Vencord built from
source** — the one-click installer build can't run them. These steps use **PowerShell** (the
default on Windows 10/11). Pick your client below.

- [Prerequisites](#prerequisites)
- [Automatic installer](#automatic-installer)
- [Vencord (Discord desktop)](#vencord-discord-desktop)
- [Vesktop](#vesktop)
- [Browser (Tampermonkey userscript)](#browser-tampermonkey-userscript)
- [Updating](#updating)
- [Uninstalling / reverting](#uninstalling--reverting)
- [Troubleshooting](#troubleshooting)

> The repo's helper scripts (`scripts/*.sh`) are bash — written for Linux/macOS. On Windows,
> follow the **PowerShell** steps here instead (or run the `.sh` scripts under
> [Git Bash](https://git-scm.com/download/win) / WSL if you prefer).

---

## Prerequisites

Install these (accept default options), then **open a fresh PowerShell window** so they're on PATH:

- **[Git for Windows](https://git-scm.com/download/win)**
- **[Node.js LTS](https://nodejs.org)** (18 or newer) — includes `npm`
- **pnpm**. The automatic installer can install this for you if Node/npm is already available.
  Manual install command:
  ```powershell
  npm install -g pnpm
  ```

Get this repo:
```powershell
git clone https://github.com/ethanfel/Discord-ComfyPeeper "$env:USERPROFILE\Discord-ComfyPeeper"
```

---

## Automatic installer

Recommended for most Windows users:

```powershell
cd "$env:USERPROFILE\Discord-ComfyPeeper"
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

The script shows a menu for:

- **Discord desktop**: builds Vencord, then runs `pnpm inject`.
- **Vesktop**: builds Vencord, then copies the built files to
  `%APPDATA%\vesktop\sessionData\vencordFiles`.
- **Browser userscript**: builds `Vencord.user.js` for Tampermonkey.

It also creates `src\userplugins`, removes any old ComfyPeeper copy, and installs the plugin at
the exact path Vencord expects:
`...\Vencord\src\userplugins\comfyPeeper\index.tsx`.

The installer is safe to rerun. It handles common partial installs:

- Reuses an existing `...\Vencord` source checkout, or clones it if missing.
- Clones into an existing empty `...\Vencord` folder.
- Replaces an older `src\userplugins\comfyPeeper` copy before rebuilding.
- Warns if Discord or Vesktop is still running.
- For Vesktop, requires `%APPDATA%\vesktop` to exist so it does not create a fake install. If
  Vesktop was just installed, launch it once, fully quit it from the tray, then rerun the script.

Direct examples:

```powershell
# Vesktop only, with default yes answers
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Client Vesktop -Yes

# Discord desktop
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Client Discord

# Browser / Tampermonkey
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Client Browser
```

The manual steps below do the same thing and are useful for troubleshooting.

---

## Vencord (Discord desktop)

1. **Build Vencord from source:**
   ```powershell
   git clone https://github.com/Vendicated/Vencord "$env:USERPROFILE\Vencord"
   cd "$env:USERPROFILE\Vencord"
   pnpm install --frozen-lockfile
   ```
2. **Add the plugin:**
   ```powershell
   $pluginSrc = "$env:USERPROFILE\Discord-ComfyPeeper\comfyPeeper"
   $userPlugins = "$env:USERPROFILE\Vencord\src\userplugins"
   New-Item -ItemType Directory -Force -Path $userPlugins | Out-Null
   Remove-Item -Recurse -Force (Join-Path $userPlugins "comfyPeeper") -ErrorAction SilentlyContinue
   Copy-Item -Recurse -Force $pluginSrc $userPlugins
   ```
   The final plugin path must be
   `...\Vencord\src\userplugins\comfyPeeper\index.tsx`.
3. **Build & inject:**
   ```powershell
   pnpm build
   pnpm inject      # pick your Discord install (Stable/Canary/PTB); skip if already injected
   ```
   Tip: fully **quit Discord first** — right-click its **system-tray icon** (bottom-right, maybe
   under the **^** "hidden icons" arrow) → *Quit Discord*. Closing the window only minimises it.
4. **Start Discord** → **Settings → Vencord → Plugins** → enable **ComfyPeeper** → set your
   ComfyUI endpoints.

---

## Vesktop

Vesktop bundles its own Vencord and (as of 1.6.5) **ignores the custom "Vencord location"
setting**, so you copy the built files into the folder Vesktop actually loads from:
`%APPDATA%\vesktop\sessionData\vencordFiles`.

```powershell
# 1. a from-source Vencord with the plugin
git clone https://github.com/Vendicated/Vencord "$env:USERPROFILE\Vencord"
cd "$env:USERPROFILE\Vencord"
pnpm install --frozen-lockfile
$pluginSrc = "$env:USERPROFILE\Discord-ComfyPeeper\comfyPeeper"
$userPlugins = "src\userplugins"
New-Item -ItemType Directory -Force -Path $userPlugins | Out-Null
Remove-Item -Recurse -Force (Join-Path $userPlugins "comfyPeeper") -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $pluginSrc $userPlugins
pnpm build

# 2. copy the built files into the dir Vesktop loads from
$managed = "$env:APPDATA\vesktop\sessionData\vencordFiles"
New-Item -ItemType Directory -Force -Path $managed | Out-Null
Copy-Item -Force `
  "dist\vencordDesktopMain.js","dist\vencordDesktopPreload.js", `
  "dist\vencordDesktopRenderer.js","dist\vencordDesktopRenderer.css" `
  $managed
```

Then **fully quit Vesktop** (tray icon → *Quit*) and reopen it → **Settings → Plugins** → enable
**ComfyPeeper**.

> If you can't find `%APPDATA%\vesktop`, paste `%APPDATA%\vesktop\sessionData` into the File
> Explorer address bar. If `vencordFiles` doesn't exist yet, launch Vesktop once first so it
> creates it.

---

## Browser (Tampermonkey userscript)

Run ComfyPeeper on **Discord in a browser** — detection, preview, library, *and* ComfyUI
queueing all work (Vencord's userscript routes requests through `GM_xmlhttpRequest`, bypassing
CORS + mixed-content). **Tampermonkey only** (Violentmonkey / Greasemonkey can't override
`window` on Discord's CSP).

```powershell
cd "$env:USERPROFILE\Vencord"       # clone + pnpm install first if you haven't (see above)
$pluginSrc = "$env:USERPROFILE\Discord-ComfyPeeper\comfyPeeper"
$userPlugins = "src\userplugins"
New-Item -ItemType Directory -Force -Path $userPlugins | Out-Null
Remove-Item -Recurse -Force (Join-Path $userPlugins "comfyPeeper") -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $pluginSrc $userPlugins
pnpm buildWeb
```

This writes `…\Vencord\dist\Vencord.user.js`. Then:

1. Install the **Tampermonkey** extension.
2. Open the built file — paste this in the browser address bar:
   `file:///%USERPROFILE%/Vencord/dist/Vencord.user.js` (or drag the file into the browser).
   Tampermonkey shows an install/update page → confirm.
3. Open **discord.com**, click the **Vencord cog**, enable **ComfyPeeper**, set your endpoints.

Re-import the file after each rebuild to update.

---

## Updating

```powershell
# pull new plugin changes, then rebuild for your client
cd "$env:USERPROFILE\Discord-ComfyPeeper"
git pull

$userPlugins = "$env:USERPROFILE\Vencord\src\userplugins"
New-Item -ItemType Directory -Force -Path $userPlugins | Out-Null
Remove-Item -Recurse -Force (Join-Path $userPlugins "comfyPeeper") -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force "comfyPeeper" $userPlugins

cd "$env:USERPROFILE\Vencord"
pnpm build

# Discord desktop: pnpm inject   (then restart Discord)
# Vesktop: re-copy the dist files (step 2 above), then quit + reopen Vesktop
# Browser: pnpm buildWeb, then re-import the .user.js in Tampermonkey
```

---

## Uninstalling / reverting

- **Vencord desktop:** delete `…\Vencord\src\userplugins\comfyPeeper`, run `pnpm build`, restart
  Discord. To remove Vencord entirely: `pnpm uninject`.
- **Vesktop:** delete `%APPDATA%\vesktop\sessionData\vencordFiles` and restart Vesktop (it
  re-downloads its own Vencord).

---

## Troubleshooting

| symptom | fix |
|---|---|
| `pnpm : cannot be loaded because running scripts is disabled` | PowerShell blocked the script. Run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` (then reopen PowerShell), or use **Command Prompt** instead. |
| `pnpm`/`git`/`node` "not recognized" | Close and reopen the terminal after installing (PATH refresh). Verify with `node -v`, `pnpm -v`, `git -v`. |
| Plugin not in the list | You're on the installer build, not a source build — rebuild from source. Confirm `...\Vencord\src\userplugins\comfyPeeper\index.tsx` exists before building. On Vesktop, also confirm the built files landed in `%APPDATA%\vesktop\sessionData\vencordFiles`. |
| Changes don't show after rebuild | Fully **quit from the system tray** (Discord/Vesktop minimise there) and reopen — closing the window isn't enough. |
| `pnpm inject` can't find Discord | Make sure Discord has been launched at least once; pick the right branch (Stable/Canary/PTB) it offers. |
| Badge never appears | The image must be an **original-quality attachment** (re-compressed media loses metadata). Turn `autoScan` on in settings. |
| Queue says "missing nodes" | The server lacks those custom nodes — install them, or use **Check servers** to pick one that has them. |

See the **[main README](../README.md)** for features, settings, and usage.
