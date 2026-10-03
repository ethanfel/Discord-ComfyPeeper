#!/usr/bin/env python3
"""Build the native installer on its target OS; macOS is Apple Silicon only."""

import hashlib
import json
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile


def build_command(root: Path, target: str, machine: str) -> tuple[str, list[str]]:
    windows, mac = target == "win32", target == "darwin"
    if target not in {"win32", "linux", "darwin"}:
        raise SystemExit(f"Unsupported installer platform: {target}")
    if mac and machine.lower() != "arm64":
        raise SystemExit("Build the macOS installer with native arm64 Python on Apple Silicon; Intel is not supported.")
    if not mac and machine.lower() not in {"amd64", "x86_64"}:
        raise SystemExit("Windows and Linux installers require an x64 build host.")
    name = "ComfyPeeper-Setup-Windows-x64" if windows else "ComfyPeeper Installer" if mac else "ComfyPeeper-Installer"
    command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean",
               "--onedir" if mac else "--onefile", "--windowed",
               "--name", name, "--paths", str(root), "--specpath", str(root / "build"),
               "--add-data", f"{root / 'payload/ComfyPeeper-Bundle.zip'}{';' if windows else ':'}payload",
               "--add-data", f"{root / 'payload/ComfyPeeper-Bundle.zip.sha256'}{';' if windows else ':'}payload",
               "--add-data", f"{root / 'LICENSE'}{';' if windows else ':'}.",
               "--add-data", f"{root / 'installer/THIRD-PARTY-NOTICES.txt'}{';' if windows else ':'}.",
               "--collect-data", "certifi", "--copy-metadata", "certifi", "--copy-metadata", "psutil"]
    if mac:
        # Never publish an Intel or universal app under an arm64 download name.
        # PyInstaller ad-hoc signs the bundled native libraries automatically.
        command += ["--target-architecture", "arm64", "--osx-bundle-identifier", "io.github.ethanfel.comfypeeper-installer"]
    command.append(str(root / "installer/main.py"))
    return name, command


def package_macos(root: Path, output: Path, name: str) -> Path:
    app = output / f"{name}.app"
    version = json.loads((root / "installer/release.json").read_text())["version"]
    plist_path = app / "Contents/Info.plist"
    info = plistlib.loads(plist_path.read_bytes())
    info.update(CFBundleShortVersionString=version, CFBundleVersion=version,
                CFBundleDisplayName="ComfyPeeper Installer", LSMinimumSystemVersion="14.0",
                NSHighResolutionCapable=True)
    plist_path.write_bytes(plistlib.dumps(info))
    # Updating Info.plist changes the app seal. Re-sign it, then fail the build
    # if any nested signature is invalid. Ad-hoc signing is NOT notarization.
    subprocess.run(["codesign", "--force", "--sign", "-", str(app)], check=True)
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
    artifact = output / "ComfyPeeper-Setup-macOS-arm64.dmg"
    with tempfile.TemporaryDirectory(prefix="peeper-dmg-", dir=root / "build") as temp:
        stage = Path(temp)
        subprocess.run(["ditto", str(app), str(stage / app.name)], check=True)
        (stage / "Applications").symlink_to("/Applications")
        for filename in ("START-HERE.txt", "THIRD-PARTY-NOTICES.txt"):
            shutil.copy2(root / "installer" / filename, stage / filename)
        subprocess.run(["hdiutil", "create", "-volname", "ComfyPeeper", "-srcfolder", str(stage),
                        "-format", "UDZO", "-fs", "HFS+", "-ov", str(artifact)], check=True)
    return artifact


def main():
    root = Path(__file__).resolve().parent.parent
    name, command = build_command(root, sys.platform, platform.machine())
    output = root / "dist"
    output.mkdir(exist_ok=True)
    subprocess.run(command, cwd=root, check=True)
    if sys.platform == "darwin":
        artifact = package_macos(root, output, name)
    elif sys.platform == "win32":
        artifact = output / f"{name}.exe"
    else:
        binary = output / name
        binary.chmod(0o755)
        artifact = output / "ComfyPeeper-Setup-Linux-x64.tar.gz"
        with tarfile.open(artifact, "w:gz") as archive:
            archive.add(binary, arcname="ComfyPeeper/ComfyPeeper-Installer")
            archive.add(root / "installer/START-HERE.txt", arcname="ComfyPeeper/START-HERE.txt")
            archive.add(root / "installer/THIRD-PARTY-NOTICES.txt", arcname="ComfyPeeper/THIRD-PARTY-NOTICES.txt")
    artifact.with_name(artifact.name + ".sha256").write_text(f"{hashlib.sha256(artifact.read_bytes()).hexdigest()}  {artifact.name}\n")
    shutil.copy2(root / "installer/THIRD-PARTY-NOTICES.txt", output / "THIRD-PARTY-NOTICES.txt")
    print(artifact)


if __name__ == "__main__":
    main()
