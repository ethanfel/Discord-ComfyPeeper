#!/usr/bin/env python3
"""Smoke-test the shipped DMG, including a Finder-style launch, on Apple Silicon."""

from pathlib import Path
import platform
import plistlib
import re
import subprocess
import sys
import tempfile


def minimum_macos_versions(commands: str) -> list[tuple[int, ...]]:
    versions = []
    for command in re.split(r"\nLoad command \d+", commands):
        if re.search(r"\bcmd LC_BUILD_VERSION\b", command):
            match = re.search(r"\bminos (\d+(?:\.\d+)+)", command)
        elif re.search(r"\bcmd LC_VERSION_MIN_MACOSX\b", command):
            match = re.search(r"\bversion (\d+(?:\.\d+)+)", command)
        else:
            continue
        if match:
            version = tuple(map(int, match[1].split(".")))
            versions.append((version + (0, 0, 0))[:3])
    return versions


def verify_deployment_targets(app: Path) -> None:
    # A plist minimum alone cannot make newer native libraries run on Sonoma.
    magics = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf",
              b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
              b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}
    seen = set()
    for path in app.rglob("*"):
        if not path.is_file() or path.resolve() in seen:
            continue
        seen.add(path.resolve())
        with path.open("rb") as stream:
            if stream.read(4) not in magics:
                continue
        commands = subprocess.check_output(["otool", "-arch", "arm64", "-l", str(path)], text=True)
        versions = minimum_macos_versions(commands)
        if not versions or max(versions) > (14, 0, 0):
            raise SystemExit(f"Native binary cannot target macOS 14: {path.relative_to(app)} ({versions})")


def main():
    if sys.platform != "darwin" or platform.machine() != "arm64":
        raise SystemExit("This smoke test requires Apple Silicon macOS.")
    root = Path(__file__).resolve().parent.parent
    output = root / "dist"
    artifact = output / "ComfyPeeper-Setup-macOS-arm64.dmg"
    with tempfile.TemporaryDirectory(prefix="peeper-macos-test-") as temp:
        directory = Path(temp)
        mount = directory / "mounted"
        mount.mkdir()
        subprocess.run(["hdiutil", "attach", str(artifact), "-readonly", "-nobrowse",
                        "-mountpoint", str(mount)], check=True, timeout=60)
        try:
            # Exercise the app after copying it out of the distribution image,
            # including its symlinks and signatures, not just the build output.
            app = directory / "Copied Apps/ComfyPeeper Installer.app"
            subprocess.run(["ditto", str(mount / app.name), str(app)], check=True)
        finally:
            subprocess.run(["hdiutil", "detach", str(mount)], check=True, timeout=30)
        binary = app / "Contents/MacOS/ComfyPeeper Installer"
        arch = subprocess.check_output(["lipo", "-archs", str(binary)], text=True).strip()
        if arch != "arm64":
            raise SystemExit(f"Expected arm64-only installer; got {arch}")
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
        if info["LSMinimumSystemVersion"] != "14.0":
            raise SystemExit("Unexpected minimum macOS version")
        verify_deployment_targets(app)
        # The CLI launch returns the actual exit code; LaunchServices exercises
        # the same launch path as double-clicking the app in Finder.
        for launch, result in (([str(binary)], output / "smoke-test.txt"),
                               (["open", "-W", "-n", str(app), "--args"], directory / "finder-smoke-test.txt")):
            result.unlink(missing_ok=True)
            subprocess.run([*launch, "--self-test", "--test-output", str(result)], check=True, timeout=90)
            if not result.is_file() or not result.read_text().startswith("PASS:"):
                raise SystemExit("The packaged macOS app did not report a successful self-test")
            print(result.read_text(), end="")
    print("PASS: arm64-only DMG, app signature, copied app and Finder-style launch")


if __name__ == "__main__":
    main()
