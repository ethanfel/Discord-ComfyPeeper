#!/usr/bin/env python3
"""Package an isolated, already-tested Vencord checkout for the installer."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import zipfile


def git(directory, *args):
    return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--vencord", required=True, type=Path)
    parser.add_argument("--output", default="payload", type=Path)
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    config = json.loads((root / "installer/release.json").read_text())
    commit = git(args.vencord, "rev-parse", "HEAD")
    if commit != config["vencord_commit"]:
        raise SystemExit("Vencord does not match the tested commit in installer/release.json")
    userplugins = args.vencord / "src/userplugins"
    if {p.name for p in userplugins.iterdir() if not p.name.startswith(".")} != {"comfyPeeper"}:
        raise SystemExit("Release builds must contain only the public ComfyPeeper user plugin")
    for source in (root / "comfyPeeper").rglob("*"):
        if source.is_file() and source.read_bytes() != (userplugins / "comfyPeeper" / source.relative_to(root / "comfyPeeper")).read_bytes():
            raise SystemExit("The bundled Peeper source differs from the release checkout")
    names = ["vencordDesktopMain.js", "vencordDesktopPreload.js", "vencordDesktopRenderer.js", "vencordDesktopRenderer.css"]
    files = {name: (args.vencord / "dist" / name).read_bytes() for name in names}
    for name in names:
        if name.endswith(".js") and (b"// Standalone: true" not in files[name] or b"// Updater Disabled: true" not in files[name]):
            raise SystemExit("Build with pnpm build --standalone --disable-updater before packaging")
    if b"ComfyPeeper" not in files["vencordDesktopRenderer.js"]:
        raise SystemExit("ComfyPeeper is missing from the renderer")
    files["package.json"] = b"{}\n"  # required by Vesktop 1.6.7
    files["LICENSE-VENCORD.txt"] = (args.vencord / "LICENSE").read_bytes()
    files["LICENSE-COMFYPEEPER.txt"] = (root / "LICENSE").read_bytes()
    for source in (args.vencord / "dist").glob("vencordDesktop*.LEGAL.txt"):
        files[source.name] = source.read_bytes()
    peeper_commit = git(root, "rev-parse", "HEAD")
    files["NOTICE.txt"] = (
        f"ComfyPeeper {config['version']} with a modified Vencord build.\n"
        f"Peeper source: https://github.com/ethanfel/Discord-ComfyPeeper/tree/{peeper_commit}\n"
        f"Vencord source: https://github.com/Vendicated/Vencord/tree/{commit}\n"
        "Complete corresponding source and build instructions accompany this release.\n"
        "Vencord's stock updater is disabled; use the Peeper installer to update this bundle.\n"
        "GPL-3.0-or-later. See the included license files. No warranty.\n"
    ).encode()
    manifest = {"schema": 1, "version": config["version"], "vencord_commit": commit,
                "vencord_version": config["vencord_version"], "peeper_commit": peeper_commit,
                "built_at": datetime.now(timezone.utc).isoformat(), "plugins": ["ComfyPeeper"],
                "updater_disabled": True,
                "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    files["manifest.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    args.output.mkdir(parents=True, exist_ok=True)
    bundle = args.output / "ComfyPeeper-Bundle.zip"
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in sorted(files.items()):
            archive.writestr(name, data)
    digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    bundle.with_suffix(".zip.sha256").write_text(f"{digest}  {bundle.name}\n")
    # Include the actual source trees, not just a link or a promise to supply it.
    # Build dependencies remain available through the included upstream lockfile.
    with tarfile.open(args.output / "ComfyPeeper-Source.tar.gz", "w:gz") as archive:
        for directory, subdirs, filenames in os.walk(args.vencord):
            subdirs[:] = [name for name in subdirs if name not in {".git", "node_modules", "dist", "__pycache__"}]
            for filename in filenames:
                path = Path(directory) / filename
                archive.add(path, arcname=str(Path("source/Vencord") / path.relative_to(args.vencord)), recursive=False)
        for tracked in git(root, "ls-files").splitlines():
            path = root / tracked
            if path.is_file():
                archive.add(path, arcname=str(Path("source/ComfyPeeper") / tracked), recursive=False)
    print(f"Packaged Peeper {config['version']} / Vencord {commit[:7]}: {bundle}")


if __name__ == "__main__":
    main()
