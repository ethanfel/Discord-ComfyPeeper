# Building and releasing the installer

The user-facing instructions are in [EASY-INSTALL.md](../docs/EASY-INSTALL.md).
The GUI uses Python/Tk, packaged with its runtime using PyInstaller. End users
do not install Python. Linux builds run on Ubuntu 22.04 to set a glibc 2.35 baseline;
Windows builds run on Windows Server 2022 using Python 3.12 x64.

## Test locally

```bash
python -m venv .venv-installer
# Activate the environment using your platform's usual command.
python -m pip install -r installer/requirements.txt
python -m unittest discover -s installer/tests -v
```

Run the UI from the repository root with `python -m installer.main`. Its Install
button expects `payload/ComfyPeeper-Bundle.zip` and the adjacent `.sha256` file.
Building with `python scripts/package-installer.py` packages those two files into
the executable. Do not leave a source archive in `payload` when building the GUI.

`--self-test --test-output result.txt` exercises the real packaged payload,
installation/repair/removal in a temporary profile, and creation of the Tk UI.
It never changes an actual Vesktop profile. On a headless Linux runner use
`xvfb-run -a`. Unit tests additionally exercise updates, rollback, malformed
archives, recovery, locks, detection, and settings preservation on both platforms.

## Updating the bundled Vencord

1. Update the exact `vencord_commit` and version in `installer/release.json`.
2. Adapt ComfyPeeper to upstream changes. Do not silently use a moving branch.
3. Bump the release version in `installer/release.json` and `installer/__init__.py`.
4. The workflow builds an isolated checkout containing only the public Peeper
   plugin. It runs TypeScript and ESLint before building with:

   ```bash
   pnpm build --standalone --disable-updater
   ```

   Standalone mode is essential: without it, a Linux build can hardcode Linux-only
   code paths into a bundle also distributed to Windows. Disabling the stock
   updater prevents it from replacing this custom release.
5. `scripts/package-peeper-bundle.py --vencord build/vencord` verifies the checkout,
   build flags, and plugin source; packages files and checksums; and includes the
   modified upstream source tree with the release.

Avoid using a personal Vencord checkout for releases: private user plugins must
not be distributed. The workflow always creates a fresh checkout.

## Publish

Every relevant push builds both installers and runs their packaged smoke tests.
Download the resulting workflow artifacts for review. A `vX.Y.Z` tag matching
`installer/release.json` publishes the tested artifacts as a GitHub release only
after all jobs pass. The workflow also supports manual runs without publishing.

The release must contain:

- `ComfyPeeper-Setup-Windows-x64.exe` and its SHA-256 file
- `ComfyPeeper-Setup-Linux-x64.tar.gz` and its SHA-256 file
- `ComfyPeeper-Bundle.zip` and its SHA-256 file
- `ComfyPeeper-Source.tar.gz`
- `THIRD-PARTY-NOTICES.txt`

The Update button uses the repository's latest stable GitHub release and requires
the bundle's manifest version to match its release tag. Do not move release tags
or replace assets; publish a new version. Future installer format changes must
increment the manifest schema and keep useful upgrade error messages.

These tests prove packaging and filesystem behavior, not compatibility with every
future Discord deployment. Before publishing, also check Peeper in a real Vesktop
session: startup, a metadata badge, workflow preview, and a toast-producing action.
Do not advertise a native Windows Discord session test when only the Windows
installer self-test has been run.
