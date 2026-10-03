# Install ComfyPeeper — Windows and Linux

The easiest route is **Vesktop + the ComfyPeeper installer**. You do not need
Git, Node.js, pnpm, Python, administrator access, or terminal commands.

## Install

1. Install [Vesktop](https://vesktop.dev/), open it once, and sign in to Discord.
2. Fully quit Vesktop from its system-tray icon.
3. [Download the latest ComfyPeeper installer](https://github.com/ethanfel/Discord-ComfyPeeper/releases/latest):
   - **Windows:** open `ComfyPeeper-Setup-Windows-x64.exe`.
   - **Linux:** extract `ComfyPeeper-Setup-Linux-x64.tar.gz`, then open
     `ComfyPeeper-Installer` inside the extracted folder.
4. The installer finds your Vesktop profile. If several appear, select the one you use.
5. Click **Install Peeper**. When it finishes, reopen Vesktop.

ComfyPeeper is enabled automatically. Its settings are under
**Settings → Vencord → Plugins → ComfyPeeper**. Add your ComfyUI address there
if you want to send or queue workflows; browsing embedded workflows does not
require a ComfyUI server.

The installer includes a tested Vencord + Peeper bundle. First installation can
run offline. It does not install another Discord application or rebuild Vesktop.

## Keep it working

Keep the downloaded installer; it is also your update and recovery tool.

| Button | What it does |
| --- | --- |
| Install Peeper | Installs the tested bundle included with the installer. |
| Update | Downloads the latest published Peeper bundle, including its tested Vencord version. |
| Repair | Verifies/reinstalls the saved bundle and re-enables Peeper. Works offline. |
| Roll back | Switches to the previous Peeper release after an update. |
| Remove | Restores your original Vencord selection and removes installer-owned bundles. |

Quit Vesktop before any of these operations. The installer will tell you if it
is still running; it does not kill the application.

Your Discord login, saved workflow library, themes, and plugin configuration are
preserved. Removing Peeper restores its previous enabled state, while keeping
other settings you changed after installation.

## Supported installations

- **Windows 10/11, x64:** normal Vesktop and portable installations.
- **Linux, x86-64:** glibc 2.35 or newer (Ubuntu 22.04+, Debian 12+, current Fedora
  and Arch), with an X11/XWayland desktop. Native, Flatpak, and Snap profile paths
  are detected; packaging confinement can vary by distribution.
- **Vesktop:** tested against 1.6.7's custom Vencord loader. Use a current release.

For a portable or unlisted installation, click **Browse** and select Vesktop's
data folder (normally `%APPDATA%\vesktop` on Windows, `~/.config/vesktop` on Linux,
or `Data` beside portable Vesktop). Open Vesktop once first so the profile exists.

The first graphical release targets **Vesktop**, not the standard Discord app.
For standard Discord or a browser userscript, use the existing advanced
[source-build guide](INSTALL.md) or [Windows source-build guide](INSTALL-WINDOWS.md).
ARM and macOS installer builds are not included in this release.

## Existing custom plugins

The downloadable bundle contains **ComfyPeeper plus Vencord's standard plugins**.
It cannot include your private Collector plugin or other personal user plugins.
The installer explains this before switching an existing custom build. It keeps
your original build so **Remove** can restore it.

To keep multiple personal plugins active together, continue using the source-build
scripts. They remain available under `scripts/`; the graphical release does not
modify your source checkout.

## Troubleshooting

- **No Vesktop found:** install/open Vesktop once, quit it, then click Refresh.
  Browse can select a portable or custom data folder.
- **Vesktop is still running:** closing its window can leave it in the tray.
  Right-click the tray icon and choose Quit.
- **Linux will not open the file:** extract the archive first. Its executable
  permission is stored in the archive. If your filesystem discarded it, open
  Properties → Permissions → Allow executing file as program.
- **Windows publisher warning:** these initial builds are unsigned. Check that
  the download came from this repository's Releases page. Signing can be added
  when a code-signing certificate is available.
- **Cannot reach GitHub:** Install and Repair use local files. Update needs a
  working connection. A rate limit or outage will leave your existing build active.
- **Missing/broken Peeper:** quit Vesktop and choose Repair. If a new update caused
  the issue, choose Roll back.
- **Interrupted installation:** rerun the installer while Vesktop is closed and
  choose Repair. A small journal restores interrupted settings writes before retrying.

This installer does not change graphics, audio, accessibility, or speech flags.
Vesktop/Electron problems are separate from installing Peeper.

## How the installation is stored

Peeper releases live under `comfypeeper-installer/` inside your selected Vesktop
data folder, so Flatpak and portable installations can access them. The installer
sets **`vencordDir` in Vesktop's `state.json`**, enables `ComfyPeeper` in Vencord's
plugin settings, and keeps versioned bundles for recovery. It does not overwrite
Vesktop's managed `sessionData/vencordFiles` directory.

Vesktop 1.6.7 requires a `package.json` alongside the Vencord bundles; the release
includes it. The bundled Vencord updater is disabled so it cannot replace Peeper
with a stock build. Use the installer's Update button instead.

Each bundle has checksums and a manifest naming the exact Peeper/Vencord revisions.
Checksums detect damaged downloads; they are not a publisher signature. Complete
corresponding source is included in the release as `ComfyPeeper-Source.tar.gz`.
