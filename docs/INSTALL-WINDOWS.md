# Install guide (Windows)

ComfyPeeper is a **Vencord user-plugin**. User-plugins only load in a **Vencord built from
source** — the one-click installer build can't run them. These steps use **PowerShell** (the
default on Windows 10/11). Pick your client below.

- [Prerequisites](#prerequisites)
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
- **pnpm**:
  ```powershell
  npm install -g pnpm
  ```

Get this repo:
```powershell
git clone https://github.com/ethanfel/Discord-ComfyPeeper "$env:USERPROFILE\Discord-ComfyPeeper"
```

---

## Vencord (Discord desktop)

1. **Build Vencord from source:**
   ```powershell
   git clone https://github.com/Vendicated/Vencord "$env:USERPROFILE\Vencord"
   cd "$env:USERPROFILE\Vencord"
   pnpm install
   ```
2. **Add the plugin:**
   ```powershell
   Copy-Item -Recurse -Force "$env:USERPROFILE\Discord-ComfyPeeper\comfyPeeper" "$env:USERPROFILE\Vencord\src\userplugins\"
   ```
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
pnpm install
Copy-Item -Recurse -Force "$env:USERPROFILE\Discord-ComfyPeeper\comfyPeeper" "src\userplugins\"
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
cd "$env:USERPROFILE\Discord-ComfyPeeper"; git pull
Copy-Item -Recurse -Force "comfyPeeper" "$env:USERPROFILE\Vencord\src\userplugins\"
cd "$env:USERPROFILE\Vencord"; pnpm build

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
| Plugin not in the list | You're on the installer build, not a source build — rebuild from source. On Vesktop, confirm the files landed in `%APPDATA%\vesktop\sessionData\vencordFiles`. |
| Changes don't show after rebuild | Fully **quit from the system tray** (Discord/Vesktop minimise there) and reopen — closing the window isn't enough. |
| `pnpm inject` can't find Discord | Make sure Discord has been launched at least once; pick the right branch (Stable/Canary/PTB) it offers. |
| Badge never appears | The image must be an **original-quality attachment** (re-compressed media loses metadata). Turn `autoScan` on in settings. |
| Queue says "missing nodes" | The server lacks those custom nodes — install them, or use **Check servers** to pick one that has them. |

See the **[main README](../README.md)** for features, settings, and usage.
