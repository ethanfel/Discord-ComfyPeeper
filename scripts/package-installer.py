#!/usr/bin/env python3
"""Build the native installer on Windows or Linux (run on the target OS)."""

import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile


root = Path(__file__).resolve().parent.parent
output = root / "dist"
output.mkdir(exist_ok=True)
windows = sys.platform == "win32"
name = "ComfyPeeper-Setup-Windows-x64" if windows else "ComfyPeeper-Installer"
command = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--windowed",
           "--name", name, "--paths", str(root), "--specpath", str(root / "build"),
           "--add-data", f"{root / 'payload/ComfyPeeper-Bundle.zip'}{';' if windows else ':'}payload",
           "--add-data", f"{root / 'payload/ComfyPeeper-Bundle.zip.sha256'}{';' if windows else ':'}payload",
           "--add-data", f"{root / 'LICENSE'}{';' if windows else ':'}.",
           "--add-data", f"{root / 'installer/THIRD-PARTY-NOTICES.txt'}{';' if windows else ':'}.",
           "--collect-data", "certifi", "--copy-metadata", "certifi", "--copy-metadata", "psutil",
           str(root / "installer/main.py")]
subprocess.run(command, cwd=root, check=True)
binary = output / (name + (".exe" if windows else ""))
if not windows:
    binary.chmod(0o755)
    artifact = output / "ComfyPeeper-Setup-Linux-x64.tar.gz"
    with tarfile.open(artifact, "w:gz") as archive:
        archive.add(binary, arcname="ComfyPeeper/ComfyPeeper-Installer")
        archive.add(root / "installer/START-HERE.txt", arcname="ComfyPeeper/START-HERE.txt")
        archive.add(root / "installer/THIRD-PARTY-NOTICES.txt", arcname="ComfyPeeper/THIRD-PARTY-NOTICES.txt")
else:
    artifact = binary
for path in [artifact]:
    path.with_name(path.name + ".sha256").write_text(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n")
shutil.copy2(root / "installer/THIRD-PARTY-NOTICES.txt", output / "THIRD-PARTY-NOTICES.txt")
print(artifact)
