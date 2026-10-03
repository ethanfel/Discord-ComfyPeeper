Install ComfyPeeper on Windows, Linux, or Apple Silicon Mac without Git, Node,
pnpm, or Python. New in **0.1.1**: a native ARM64 Mac app and disk image.

1. Install [Vesktop](https://vesktop.dev/), open it once, then quit it from the tray (Cmd+Q on Mac).
2. Download the installer for your system:
   - **Windows:** `ComfyPeeper-Setup-Windows-x64.exe` — open it directly.
   - **Linux:** `ComfyPeeper-Setup-Linux-x64.tar.gz` — extract, then open `ComfyPeeper-Installer`.
   - **Apple Silicon Mac:** `ComfyPeeper-Setup-macOS-arm64.dmg` — open, copy **ComfyPeeper Installer** to Applications or a folder you own, then open the app.
3. Click **Install Peeper**, then reopen Vesktop. Peeper is already enabled.

The installer includes the tested bundle, so installation works offline.
Use the same app for **Update**, **Repair**, **Roll back**, and **Remove**.
Your login, plugin settings, and saved workflow library are preserved.

This first easy installer targets **Vesktop 1.6.7+**. Standard Discord and browser
users can still use the source-build guides. Other custom plugins are not part
of the prebuilt bundle; the installer detects existing custom builds and explains
the change before installation.

Windows 10/11 x64; Linux x86-64 with glibc 2.35+ and X11/XWayland.
Mac: macOS 14 Sonoma or newer, Apple Silicon (M-series) only. No Intel build.
Windows builds are currently unsigned; Windows may show a publisher warning.
Mac builds are ad-hoc signed, **not Apple-notarized or Developer ID signed**.
If macOS blocks the app and you trust this repository's download, try opening
it, then use **System Settings → Privacy & Security → Open Anyway**.
See [Apple's guidance](https://support.apple.com/en-us/102445); do not disable Gatekeeper.

[Installation help](https://github.com/ethanfel/Discord-ComfyPeeper/blob/main/docs/EASY-INSTALL.md)

`ComfyPeeper-Bundle.zip` and `ComfyPeeper-Source.tar.gz` are for updates/developers;
regular users only need their platform's installer.
