"""Validated bundles and reversible, per-user Vesktop installations.

No Discord login data is read. Only Vesktop state, Vencord plugin settings, and
our own files are changed. All mutation entry points share the same process
check, cross-process lock, and recoverable transaction journal.
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import ssl
import stat
import sys
import tempfile
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen
import uuid
import zipfile

import certifi
import psutil

from installer import VERSION

REPOSITORY = "ethanfel/Discord-ComfyPeeper"
RELEASES_URL = f"https://github.com/{REPOSITORY}/releases"
BUNDLE_NAME = "ComfyPeeper-Bundle.zip"
REQUIRED_FILES = {
    "vencordDesktopMain.js", "vencordDesktopPreload.js",
    "vencordDesktopRenderer.js", "vencordDesktopRenderer.css", "package.json",
}
MAX_DOWNLOAD = 32 * 1024 * 1024
MAX_UNPACKED = 80 * 1024 * 1024
MANAGED_NAME = "comfypeeper-installer"
Log = Callable[[str], None]


class InstallError(Exception):
    """An actionable error suitable for display in the installer."""


def read_object(path: Path, *, missing_ok: bool = True) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        if missing_ok:
            return {}
        raise InstallError(f"Required file is missing: {path}") from None
    except (ValueError, UnicodeError):
        raise InstallError(f"{path.name} is not valid JSON. Restore or repair it before continuing.") from None
    if not isinstance(value, dict):
        raise InstallError(f"{path.name} must contain a JSON object.")
    return value


def encode_object(value: dict) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def profile_path(path: Path) -> Path:
    path = path.expanduser().resolve()
    if not (path / "state.json").is_file() and (path / "Data" / "state.json").is_file():
        path = path / "Data"  # Windows portable Vesktop
    if not path.is_dir() or not any((path / name).is_file() for name in ("state.json", "settings.json")):
        raise InstallError("Choose Vesktop's data folder. Launch Vesktop once first, then fully quit it.")
    return path


def discover_profiles(home: Path | None = None, env: dict | None = None, platform: str | None = None) -> list[Path]:
    home, env, platform = home or Path.home(), os.environ if env is None else env, platform or sys.platform
    candidates = []
    if env.get("VENCORD_USER_DATA_DIR"):
        candidates.append(Path(env["VENCORD_USER_DATA_DIR"]))
    if platform == "win32":
        candidates += [Path(env.get("APPDATA", str(home / "AppData" / "Roaming"))) / "vesktop"]
        local = Path(env.get("LOCALAPPDATA", str(home / "AppData" / "Local")))
        candidates += [local / "Programs" / "Vesktop" / "Data"]
    elif platform == "darwin":
        candidates.append(home / "Library/Application Support/vesktop")
    else:
        candidates += [Path(env.get("XDG_CONFIG_HOME", str(home / ".config"))) / "vesktop",
                       home / ".var/app/dev.vencord.Vesktop/config/vesktop",
                       home / "snap/vesktop/current/.config/vesktop"]
    found = []
    for candidate in candidates:
        try:
            resolved = profile_path(candidate)
        except InstallError:
            continue
        if resolved not in found:
            found.append(resolved)
    return found


def vesktop_pids() -> list[int]:
    found = []
    for process in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            name = (process.info["name"] or "").casefold()
            args = process.info["cmdline"] or []
            if name in {"vesktop", "vesktop.exe", "vesktop helper", "vesktop helper (renderer)",
                        "vesktop helper (gpu)", "vesktop helper (plugin)"} or (
                name.startswith("electron") and any("vesktop" in arg.casefold() and arg.endswith(".asar") for arg in args)
            ):
                found.append(process.pid)
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    return found


def quit_instruction() -> str:
    if sys.platform == "darwin":
        return "Quit Vesktop with Cmd+Q or Vesktop → Quit Vesktop."
    return "Right-click Vesktop's tray icon and choose Quit."


def ensure_closed() -> None:
    if vesktop_pids():
        raise InstallError(f"Vesktop is still running. {quit_instruction()} Then try again.")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Bundle:
    def __init__(self, data: bytes, expected_hash: str):
        if len(data) > MAX_DOWNLOAD or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
            raise InstallError("Invalid bundle size or checksum.")
        if sha256(data) != expected_hash:
            raise InstallError("The download checksum does not match. Download the installer or update again.")
        self.data, self.digest = data, expected_hash
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > 40 or sum(item.file_size for item in entries) > MAX_UNPACKED:
                    raise InstallError("The bundle is unexpectedly large.")
                names = [item.filename for item in entries]
                if len(names) != len(set(names)) or len(names) != len(set(n.casefold() for n in names)):
                    raise InstallError("The bundle contains duplicate files.")
                for item in entries:
                    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", item.filename) or item.is_dir():
                        raise InstallError("The bundle contains an invalid file path.")
                    if stat.S_ISLNK(item.external_attr >> 16):
                        raise InstallError("The bundle contains a symbolic link.")
                if "manifest.json" not in names:
                    raise InstallError("The bundle has no manifest.")
                self.manifest = json.loads(archive.read("manifest.json"))
                m = self.manifest
                if not isinstance(m, dict) or m.get("schema") != 1 or not re.fullmatch(r"\d+\.\d+\.\d+", m.get("version", "")):
                    raise InstallError("This bundle needs a newer installer. Download it from the releases page.")
                if m.get("plugins") != ["ComfyPeeper"] or m.get("updater_disabled") is not True:
                    raise InstallError("This is not a supported ComfyPeeper bundle.")
                for field in ("vencord_commit", "peeper_commit"):
                    if not re.fullmatch(r"[0-9a-f]{40}", m.get(field, "")):
                        raise InstallError("The bundle is missing its source revision.")
                hashes = m.get("files")
                if not isinstance(hashes, dict) or set(names) != set(hashes) | {"manifest.json"} or not REQUIRED_FILES <= set(hashes):
                    raise InstallError("The bundle is incomplete.")
                self.files = {}
                for name, digest in hashes.items():
                    contents = archive.read(name)
                    if not isinstance(digest, str) or sha256(contents) != digest:
                        raise InstallError(f"Bundle verification failed for {name}.")
                    self.files[name] = contents
                if b"ComfyPeeper" not in self.files["vencordDesktopRenderer.js"]:
                    raise InstallError("The bundle does not contain ComfyPeeper.")
                self.files["manifest.json"] = encode_object(m)
        except (zipfile.BadZipFile, KeyError, TypeError, ValueError, RuntimeError) as exc:
            raise InstallError(f"The bundle is damaged or incompatible: {exc}") from None

    @property
    def version(self) -> str:
        return self.manifest["version"]

    def extract(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=False)
        for name, contents in self.files.items():
            (directory / name).write_bytes(contents)


def bundled_payload() -> Bundle:
    directory = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent)) / "payload"
    archive = directory / BUNDLE_NAME
    try:
        digest = (directory / f"{BUNDLE_NAME}.sha256").read_text().split()[0]
        return Bundle(archive.read_bytes(), digest)
    except (OSError, IndexError):
        raise InstallError("The bundled files are missing. Download the complete installer from GitHub Releases.") from None


def download(url: str, limit: int = MAX_DOWNLOAD) -> bytes:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in {"github.com", "api.github.com"}:
        raise InstallError("Unexpected release download address.")
    request = Request(url, headers={"User-Agent": f"ComfyPeeper-Installer/{VERSION}", "Accept": "application/vnd.github+json"})
    try:
        with urlopen(request, timeout=30, context=ssl.create_default_context(cafile=certifi.where())) as response:
            if urlparse(response.url).scheme != "https":
                raise InstallError("The release redirected to an insecure connection.")
            data = response.read(limit + 1)
        if len(data) > limit:
            raise InstallError("The release download exceeded its size limit.")
        return data
    except HTTPError as exc:
        if exc.code == 404:
            raise InstallError("No published update was found. You can still install the bundle included with this installer.") from None
        raise InstallError(f"GitHub could not provide the update (HTTP {exc.code}). Try again later.") from None
    except (URLError, TimeoutError, OSError):
        raise InstallError("Cannot reach GitHub. Check your connection or install the included bundle offline.") from None


def latest_bundle(log: Log = lambda _: None) -> Bundle:
    log("Checking for a published ComfyPeeper update…")
    try:
        release = json.loads(download(f"https://api.github.com/repos/{REPOSITORY}/releases/latest", 1024 * 1024))
        assets = {asset["name"]: asset["browser_download_url"] for asset in release["assets"]}
        for name in (BUNDLE_NAME, BUNDLE_NAME + ".sha256"):
            if not assets[name].startswith(f"https://github.com/{REPOSITORY}/releases/download/"):
                raise InstallError("Unexpected bundle location in release metadata.")
        digest = download(assets[BUNDLE_NAME + ".sha256"], 1024).decode("ascii").split()[0]
        log("Downloading and checking the update…")
        bundle = Bundle(download(assets[BUNDLE_NAME]), digest)
        if release["tag_name"] != "v" + bundle.version or release.get("prerelease") or release.get("draft"):
            raise InstallError("The bundle does not match the published release.")
        return bundle
    except (KeyError, TypeError, ValueError, IndexError, UnicodeError):
        raise InstallError("This release does not include a compatible Peeper bundle. Download the latest installer.") from None


def capture_field(obj: dict, key: str) -> dict:
    return {"exists": key in obj, "value": obj.get(key)}


def restore_field(obj: dict, key: str, saved: dict) -> None:
    if saved["exists"]:
        obj[key] = saved["value"]
    else:
        obj.pop(key, None)


class Installation:
    def __init__(self, profile: Path, log: Log = lambda _: None):
        self.profile = profile_path(profile)
        self.root = self.profile / MANAGED_NAME
        if self.root.is_symlink() or any((self.root / name).is_symlink() for name in ("releases", "downloads")):
            raise InstallError("The installer folder points outside this Vesktop profile. Restore it to a regular folder before continuing.")
        self.log = log
        self.paths = {
            "state": self.profile / "state.json",
            "settings": self.profile / "settings" / "settings.json",
            "installation": self.root / "installation.json",
        }

    def info(self) -> dict:
        info = read_object(self.paths["installation"])
        if info and (info.get("schema") != 1 or not isinstance(info.get("current"), dict)):
            raise InstallError("The installation record is incompatible. Download the latest installer.")
        return info

    def custom_build_warning(self) -> bool:
        info = self.info()
        state = read_object(self.paths["state"])
        if info:
            return bool(state.get("vencordDir") and state["vencordDir"] != str(self.release_path(info["current"]["directory"])))
        if state.get("vencordDir"):
            return True
        renderer = self.profile / "sessionData/vencordFiles/vencordDesktopRenderer.js"
        if renderer.is_file():
            # Source-built bundles or an older managed Peeper installation may
            # include extra user plugins. Never imply they are in our release.
            data = renderer.read_bytes()
            return b"Standalone: false" in data or b"ComfyPeeper" in data
        return False

    @contextmanager
    def locked(self):
        ensure_closed()
        self.root.mkdir(parents=True, exist_ok=True)
        with (self.root / "operation.lock").open("a+b") as lock:
            try:
                # Windows byte-range locks also prohibit reads of that byte
                # from another handle. Inspect the size without reading it.
                if os.fstat(lock.fileno()).st_size == 0:
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                if sys.platform == "win32":
                    import msvcrt
                    msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise InstallError("Another Peeper installer is using this profile. Close it and try again.") from None
            try:
                self.recover()
                yield
            finally:
                lock.seek(0)
                if sys.platform == "win32":
                    msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(lock, fcntl.LOCK_UN)

    def recover(self) -> None:
        journal = self.root / "pending.json"
        if not journal.exists():
            return
        pending = read_object(journal, missing_ok=False)
        if set(pending) != set(self.paths):
            raise InstallError("The recovery journal is invalid. Keep the installer folder and contact the maintainer.")
        for key, entry in pending.items():
            current = self.paths[key].read_bytes() if self.paths[key].exists() else None
            current64 = base64.b64encode(current).decode() if current is not None else None
            if current64 not in (entry["before"], entry["after"]):
                raise InstallError("Vesktop settings changed during an interrupted install. Keep the recovery files and contact the maintainer.")
        self.log("Restoring the settings from the interrupted operation…")
        for key, entry in pending.items():
            if entry["before"] is None:
                self.paths[key].unlink(missing_ok=True)
            else:
                atomic_write(self.paths[key], base64.b64decode(entry["before"], validate=True))
        journal.unlink()

    def transaction(self, objects: dict[str, dict]) -> None:
        ensure_closed()
        pending = {}
        for key, path in self.paths.items():
            before = path.read_bytes() if path.exists() else None
            pending[key] = {
                "before": base64.b64encode(before).decode() if before is not None else None,
                "after": base64.b64encode(encode_object(objects[key])).decode(),
            }
        journal = self.root / "pending.json"
        atomic_write(journal, encode_object(pending))
        try:
            for key, path in self.paths.items():
                atomic_write(path, base64.b64decode(pending[key]["after"]))
        except BaseException:
            self.recover()
            raise
        journal.unlink()

    def release_path(self, name: str) -> Path:
        if not isinstance(name, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9]{12}-[a-f0-9]{8}", name):
            raise InstallError("The installed release record is invalid.")
        path = self.root / "releases" / name
        if path.is_symlink():
            raise InstallError("The installed release unexpectedly points to another folder.")
        return path

    def verify_release(self, info: dict, key: str = "current") -> Path:
        record = info[key]
        path = self.release_path(record["directory"])
        bundle = self.cached_bundle(record)
        for name, contents in bundle.files.items():
            file = path / name
            if not file.is_file() or file.is_symlink() or file.read_bytes() != contents:
                raise InstallError("The installed files need repair. Choose Repair, or install an update.")
        return path

    def cached_bundle(self, record: dict) -> Bundle:
        digest = record.get("sha256", "")
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise InstallError("The installed checksum is invalid.")
        path = self.root / "downloads" / f"{digest}.zip"
        if not path.is_file():
            raise InstallError("The saved repair bundle is missing. Use Update to download a fresh copy.")
        return Bundle(path.read_bytes(), digest)

    def status(self) -> str:
        if (self.root / "pending.json").exists():
            return "An interrupted installation needs recovery. Quit Vesktop, then choose Repair."
        info = self.info()
        if not info.get("current"):
            return "Ready to install ComfyPeeper."
        try:
            path = self.verify_release(info)
            state = read_object(self.paths["state"])
            if state.get("vencordDir") != str(path):
                return "ComfyPeeper is installed but not selected in Vesktop. Choose Repair."
            settings = read_object(self.paths["settings"])
            if not settings.get("plugins", {}).get("ComfyPeeper", {}).get("enabled"):
                return "ComfyPeeper is installed but disabled. Choose Repair to enable it."
            return f"ComfyPeeper {info['current']['version']} is installed and enabled."
        except InstallError as exc:
            return str(exc)

    def activate(self, bundle: Bundle, *, repair: bool = False) -> None:
        with self.locked():
            info = self.info()
            state = read_object(self.paths["state"])
            settings = read_object(self.paths["settings"])
            plugins = settings.setdefault("plugins", {})
            if not isinstance(plugins, dict) or not isinstance(plugins.get("ComfyPeeper", {}), dict):
                raise InstallError("ComfyPeeper's plugin settings are malformed. Repair the settings file first.")
            plugin = plugins.setdefault("ComfyPeeper", {})
            if not info.get("current"):
                info = {"schema": 1, "original_directory": capture_field(state, "vencordDir"),
                        "original_enabled": capture_field(plugin, "enabled")}
            current = info.get("current")
            if repair and current and current.get("sha256") != bundle.digest:
                raise InstallError("Another operation changed the selected release. Choose Repair again.")
            if current and not repair and tuple(map(int, bundle.version.split("."))) < tuple(map(int, current["version"].split("."))):
                raise InstallError("This installer includes an older bundle. Choose Update, or use Roll back to restore your previous version.")
            cache = self.root / "downloads" / f"{bundle.digest}.zip"
            atomic_write(cache, bundle.data)
            name = f"{bundle.version}-{bundle.digest[:12]}-{uuid.uuid4().hex[:8]}"
            path = self.release_path(name)
            self.log("Installing verified files…")
            bundle.extract(path)
            if current and not repair:
                info["previous"] = current
            info["current"] = {"directory": name, "version": bundle.version, "sha256": bundle.digest,
                               "vencord_commit": bundle.manifest["vencord_commit"], "peeper_commit": bundle.manifest["peeper_commit"]}
            state["vencordDir"] = str(path)
            plugin["enabled"] = True
            self.transaction({"state": state, "settings": settings, "installation": info})
            self.log(f"ComfyPeeper {bundle.version} is installed. Open Vesktop to use it.")

    def repair(self) -> None:
        # Recover before reading the current record, then activate under a new
        # lock. activate re-reads settings, preserving unrelated user changes.
        with self.locked():
            info = self.info()
            bundle = self.cached_bundle(info["current"]) if info.get("current") else bundled_payload()
        self.activate(bundle, repair=True)

    def rollback(self) -> None:
        with self.locked():
            info = self.info()
            if not info.get("previous"):
                raise InstallError("There is no previous Peeper release to restore. Remove Peeper to restore your original Vencord selection.")
            path = self.verify_release(info, "previous")
            info["current"], info["previous"] = info["previous"], info["current"]
            state = read_object(self.paths["state"])
            settings = read_object(self.paths["settings"])
            state["vencordDir"] = str(path)
            settings.setdefault("plugins", {}).setdefault("ComfyPeeper", {})["enabled"] = True
            self.transaction({"state": state, "settings": settings, "installation": info})
            self.log(f"Restored ComfyPeeper {info['current']['version']}. Open Vesktop when ready.")

    def uninstall(self) -> None:
        with self.locked():
            info = self.info()
            if not info.get("current"):
                raise InstallError("This profile has no Peeper installation managed by this installer.")
            state = read_object(self.paths["state"])
            selected = state.get("vencordDir")
            if selected != str(self.release_path(info["current"]["directory"])):
                raise InstallError("Vesktop's custom Vencord selection changed. This installer will not replace that selection; choose Repair first if you want to return to Peeper.")
            original = info["original_directory"]
            if original["exists"] and original["value"] and not Path(original["value"]).is_dir():
                raise InstallError("Your previous custom Vencord folder is missing. Restore that folder before removing Peeper.")
            settings = read_object(self.paths["settings"])
            plugin = settings.setdefault("plugins", {}).setdefault("ComfyPeeper", {})
            restore_field(state, "vencordDir", original)
            restore_field(plugin, "enabled", info["original_enabled"])
            self.transaction({"state": state, "settings": settings, "installation": {}})
            # Only delete installer-owned release/cache trees after restoration
            # is committed. Cookies, local library, themes and settings stay.
            for name in ("releases", "downloads"):
                directory = self.root / name
                if directory.is_dir() and not directory.is_symlink():
                    shutil.rmtree(directory)
            self.log("Peeper removed. Your previous Vencord selection, settings, and library are preserved.")
