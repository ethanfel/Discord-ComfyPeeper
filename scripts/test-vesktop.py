#!/usr/bin/env python3
"""CI-only real Vesktop smoke test; never reuse a personal Discord profile."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from installer import core  # noqa: E402


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vesktop", required=True, type=Path)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("Run this integration test on an isolated GitHub Actions runner, not a personal desktop.")
    core.ensure_closed()
    with tempfile.TemporaryDirectory(prefix="peeper-vesktop-ci-") as temp:
        directory = Path(temp)
        profile = directory / "profile"
        core.atomic_write(profile / "state.json", core.encode_object({"firstLaunch": False}))
        core.atomic_write(profile / "settings.json", core.encode_object({
            "enableSplashScreen": False, "tray": False, "minimizeToTray": False,
            "arRPC": False, "hardwareAcceleration": False, "checkUpdates": False,
        }))
        installation = core.Installation(profile)
        installation.activate(core.bundled_payload())
        subprocess.run(["node", str(ROOT / "scripts/test-vesktop.mjs"),
                        str(args.vesktop.resolve()), str(profile), str(directory / "electron")],
                       cwd=ROOT, check=True, timeout=150)
        # Only after the test's own child has exited can files be removed.
        installation.uninstall()


if __name__ == "__main__":
    main()
