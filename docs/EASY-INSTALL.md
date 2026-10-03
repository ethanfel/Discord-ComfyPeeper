# Install ComfyPeeper — Windows, Linux, and Apple Silicon Mac

The easiest route is **Vesktop + the ComfyPeeper installer**. You do not need
Git, Node.js, pnpm, Python, administrator access, or terminal commands.

## Install

1. Install [Vesktop](https://vesktop.dev/), open it once, and sign in to Discord.
2. Fully quit Vesktop from its system-tray icon, or press **Cmd+Q** on Mac.
3. [Download the latest ComfyPeeper installer](https://github.com/ethanfel/Discord-ComfyPeeper/releases/latest):
   - **Windows:** open `ComfyPeeper-Setup-Windows-x64.exe`.
   - **Linux:** extract `ComfyPeeper-Setup-Linux-x64.tar.gz`, then open
     `ComfyPeeper-Installer` inside the extracted folder.
   - **Mac (Apple Silicon):** open `ComfyPeeper-Setup-macOS-arm64.dmg`, copy
     **ComfyPeeper Installer** to Applications (or a folder you own), then open it.
     See [Mac first launch](#mac-first-launch) below if macOS blocks it.
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

**Upgrading from installer 0.1.0 or 0.1.1:** download the new installer app from
Releases once. The old app's Update button updates Peeper, not the installer
itself, so it cannot receive these recovery fixes automatically.

| Button | What it does |
| --- | --- |
| Install Peeper | Installs the tested bundle included with the installer. |
| Update | Downloads the latest published Peeper bundle, including its tested Vencord version. |
| Repair | Verifies/reinstalls the saved bundle and re-enables Peeper. Works offline. |
| Roll back | Switches to the previous Peeper release after an update. |
| Remove | Restores your original Vencord selection and removes installer-owned bundles. |
| Installer updates | Checks for a newer installer app and offers its download page. |

Update also tells you when the installer app is out of date. It never replaces
the running executable or opens a download page without your click. Install
and Repair remain offline operations.

Reinstalling an identical release preserves the previous rollback target.
Unused installer-created bundles and caches are cleaned up after a successful
operation; the active and rollback releases are kept. Cleanup is deferred if
an interrupted settings transaction still needs recovery.

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
- **Mac, Apple Silicon only (M-series):** macOS 14 Sonoma or newer. The installer
  is native ARM64; no Rosetta or Homebrew needed. Intel Macs are not supported.
- **Vesktop:** tested against 1.6.7's custom Vencord loader. Use a current release.

For a portable or unlisted installation, click **Browse** and select Vesktop's
data folder (normally `%APPDATA%\vesktop` on Windows, `~/.config/vesktop` on Linux,
`~/Library/Application Support/vesktop` on Mac, or `Data` beside portable Windows
Vesktop). Open Vesktop once first so the profile exists. On Mac, use Finder's
**Go → Go to Folder** to reach the otherwise hidden Library folder.

The first graphical release targets **Vesktop**, not the standard Discord app.
For standard Discord or a browser userscript, use the existing advanced
[source-build guide](INSTALL.md) or [Windows source-build guide](INSTALL-WINDOWS.md).
Windows/Linux ARM and Intel Mac installer builds are not included.

## Mac first launch

This release is **not Apple-notarized or Developer ID signed**. It has an ad-hoc
signature for ARM64 integrity, not a verified publisher identity. Download it
only from this repository's Releases page.

If macOS blocks the app after you try to open it, and you trust the download,
go to **System Settings → Privacy & Security → Open Anyway**, then confirm Open.
This creates an exception for this app; do not disable Gatekeeper or other
system-wide security protections. See [Apple's guidance](https://support.apple.com/en-us/102445).
Managed work/school Macs may require approval from their administrator.

Once the installer is open, the installation itself only changes your own
Vesktop profile. Quit Vesktop with **Cmd+Q** first; closing its window is not
enough. You can eject the disk image after copying the installer app out of it.

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
  Right-click the tray icon and choose Quit, or use **Cmd+Q** on Mac.
- **Linux will not open the file:** extract the archive first. Its executable
  permission is stored in the archive. If your filesystem discarded it, open
  Properties → Permissions → Allow executing file as program.
- **Windows publisher warning:** these initial builds are unsigned. Check that
  the download came from this repository's Releases page. Signing can be added
  when a code-signing certificate is available.
- **Mac cannot open the app:** use the Apple Silicon download on macOS 14+.
  For an unidentified-developer warning, see [Mac first launch](#mac-first-launch).
- **Cannot reach GitHub:** Install and Repair use local files. Update needs a
  working connection. A rate limit or outage will leave your existing build active.
- **Missing/broken Peeper:** quit Vesktop and choose Repair. If a new update caused
  the issue, choose Roll back.
- **Interrupted installation:** rerun the installer while Vesktop is closed and
  choose Repair. A small journal restores interrupted settings writes before retrying.
- **Saved repair bundle missing or damaged:** choose Update to download a verified
  copy, even when you already have the latest release. Offline Repair can use the
  installer's embedded bundle if it exactly matches your installed release.
- **Malformed plugin settings:** the installer remains usable and displays the
  file to restore. It does not reset or overwrite malformed plugin configuration.
- **Snap upgrade from an older Peeper installer:** run Repair once with installer
  0.1.2+ to migrate to a stable `current` path. Future Snap refreshes can then move
  your profile between numbered revisions without leaving a stale bundle selection.

This installer does not change graphics, audio, accessibility, or speech flags.
Vesktop/Electron problems are separate from installing Peeper.

## How the installation is stored

Peeper releases live under `comfypeeper-installer/` inside your selected Vesktop
data folder, so Flatpak and portable installations can access them. The installer
sets **`vencordDir` in Vesktop's `state.json`**, enables `ComfyPeeper` in Vencord's
plugin settings, and keeps versioned bundles for recovery. It does not overwrite
Vesktop's managed `sessionData/vencordFiles` directory.
For Snap profiles, the saved selection uses the stable `current` alias while
filesystem operations and locks use the active revision's resolved directory.

Vesktop 1.6.7 requires a `package.json` alongside the Vencord bundles; the release
includes it. The bundled Vencord updater is disabled so it cannot replace Peeper
with a stock build. Use the installer's Update button instead.

Each bundle has checksums and a manifest naming the exact Peeper/Vencord revisions.
Checksums detect damaged downloads; they are not a publisher signature. Complete
corresponding source is included in the release as `ComfyPeeper-Source.tar.gz`.
