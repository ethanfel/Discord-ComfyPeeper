#!/usr/bin/env python3
"""Smoke-test the shipped DMG, including a Finder-style launch, on Apple Silicon."""

from pathlib import Path
import platform
import plistlib
import subprocess
import sys
import tempfile


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
