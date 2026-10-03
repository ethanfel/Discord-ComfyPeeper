import base64
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from installer import core


def make_bundle(version="0.1.0", extra=None, manifest_edit=None):
    files = {name: f"ComfyPeeper test bundle {version}".encode() for name in core.REQUIRED_FILES}
    files["package.json"] = b"{}"
    files.update(extra or {})
    manifest = {"schema": 1, "version": version, "vencord_commit": "a" * 40, "peeper_commit": "b" * 40,
                "plugins": ["ComfyPeeper"], "updater_disabled": True,
                "files": {name: core.sha256(data) for name, data in files.items()}}
    if manifest_edit:
        manifest_edit(manifest)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in files.items():
            archive.writestr(name, data)
        archive.writestr("manifest.json", json.dumps(manifest))
    data = output.getvalue()
    return core.Bundle(data, core.sha256(data))


class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name).resolve()
        self.profile = self.home / ".config/vesktop"
        self.profile.mkdir(parents=True)
        self.state = {"windowBounds": {"width": 999}, "firstLaunch": False}
        self.settings = {"themeLinks": ["keep-me"], "plugins": {
            "ComfyPeeper": {"enabled": False, "endpoints": "preserve"},
            "OtherPlugin": {"enabled": True},
        }}
        core.atomic_write(self.profile / "state.json", core.encode_object(self.state))
        core.atomic_write(self.profile / "settings/settings.json", core.encode_object(self.settings))
        self.inst = core.Installation(self.profile)
        self.closed = patch.object(core, "vesktop_pids", return_value=[])
        self.closed.start()
        self.addCleanup(self.closed.stop)

    def test_install_enables_plugin_and_preserves_all_other_settings(self):
        self.inst.activate(make_bundle())
        current = self.inst.info()["current"]
        self.assertTrue(self.inst.verify_release(self.inst.info()).is_dir())
        state = core.read_object(self.profile / "state.json")
        self.assertEqual(state["windowBounds"], self.state["windowBounds"])
        self.assertEqual(state["vencordDir"], str(self.inst.release_path(current["directory"])))
        settings = core.read_object(self.profile / "settings/settings.json")
        self.assertTrue(settings["plugins"]["ComfyPeeper"]["enabled"])
        self.assertEqual(settings["plugins"]["ComfyPeeper"]["endpoints"], "preserve")
        self.assertEqual(settings["plugins"]["OtherPlugin"], {"enabled": True})
        self.assertEqual(settings["themeLinks"], ["keep-me"])

    def test_update_rollback_and_remove_preserve_changes_made_after_install(self):
        self.inst.activate(make_bundle())
        self.inst.activate(make_bundle("0.2.0"))
        self.inst.rollback()
        self.assertEqual(self.inst.info()["current"]["version"], "0.1.0")
        self.inst.rollback()
        self.assertEqual(self.inst.info()["current"]["version"], "0.2.0")
        settings = core.read_object(self.profile / "settings/settings.json")
        settings["plugins"]["ComfyPeeper"]["endpoints"] = "edited-after-install"
        settings["themeLinks"].append("new-theme")
        core.atomic_write(self.profile / "settings/settings.json", core.encode_object(settings))
        self.inst.uninstall()
        self.assertEqual(core.read_object(self.profile / "state.json"), self.state)
        restored = core.read_object(self.profile / "settings/settings.json")
        self.assertFalse(restored["plugins"]["ComfyPeeper"]["enabled"])
        self.assertEqual(restored["plugins"]["ComfyPeeper"]["endpoints"], "edited-after-install")
        self.assertEqual(restored["themeLinks"], ["keep-me", "new-theme"])
        self.assertFalse((self.inst.root / "releases").exists())

    def test_restores_previous_custom_vencord(self):
        custom = self.home / "personal-vencord"
        custom.mkdir()
        self.state["vencordDir"] = str(custom)
        core.atomic_write(self.profile / "state.json", core.encode_object(self.state))
        self.assertTrue(self.inst.custom_build_warning())
        self.inst.activate(make_bundle())
        self.inst.uninstall()
        self.assertEqual(core.read_object(self.profile / "state.json"), self.state)
        self.assertTrue(custom.is_dir())

    def test_existing_managed_custom_bundle_triggers_warning(self):
        managed = self.profile / "sessionData/vencordFiles"
        managed.mkdir(parents=True)
        (managed / "vencordDesktopRenderer.js").write_text("// Standalone: false\nComfyPeeperCollector")
        self.assertTrue(self.inst.custom_build_warning())
        self.inst.activate(make_bundle())
        self.inst.uninstall()
        self.assertEqual((managed / "vencordDesktopRenderer.js").read_text(), "// Standalone: false\nComfyPeeperCollector")

    def test_repair_replaces_corrupt_files_without_losing_rollback(self):
        self.inst.activate(make_bundle())
        self.inst.activate(make_bundle("0.2.0"))
        current = self.inst.info()["current"]
        target = self.inst.release_path(current["directory"]) / "vencordDesktopRenderer.js"
        target.write_text("broken")
        self.assertIn("repair", self.inst.status())
        self.inst.repair()
        self.assertIn("installed and enabled", self.inst.status())
        self.assertEqual(self.inst.info()["previous"]["version"], "0.1.0")
        self.inst.rollback()
        self.assertEqual(self.inst.info()["current"]["version"], "0.1.0")

    def test_repair_restores_selection_and_enabled_flag(self):
        self.inst.activate(make_bundle())
        core.atomic_write(self.profile / "state.json", core.encode_object(self.state))
        self.assertIn("not selected", self.inst.status())
        self.inst.repair()
        core.atomic_write(self.profile / "settings/settings.json", core.encode_object(self.settings))
        self.assertIn("disabled", self.inst.status())
        self.inst.repair()
        self.assertIn("installed and enabled", self.inst.status())

    def test_running_vesktop_blocks_every_mutation(self):
        with patch.object(core, "vesktop_pids", return_value=[123]):
            for action in (lambda: self.inst.activate(make_bundle()), self.inst.repair, self.inst.rollback, self.inst.uninstall):
                with self.assertRaisesRegex(core.InstallError, "still running"):
                    action()
        self.assertFalse(self.inst.root.exists())
        self.assertEqual(core.read_object(self.profile / "state.json"), self.state)

    def test_incomplete_write_rolls_back_all_settings(self):
        actual_write = core.atomic_write
        failed = False

        def fail_once(path, data):
            nonlocal failed
            if path == self.profile / "settings/settings.json" and not failed:
                failed = True
                raise OSError("simulated full disk")
            actual_write(path, data)

        with patch.object(core, "atomic_write", side_effect=fail_once):
            with self.assertRaisesRegex(OSError, "full disk"):
                self.inst.activate(make_bundle())
        self.assertEqual(core.read_object(self.profile / "state.json"), self.state)
        self.assertEqual(core.read_object(self.profile / "settings/settings.json"), self.settings)
        self.assertFalse(self.inst.paths["installation"].exists())
        self.assertFalse((self.inst.root / "pending.json").exists())

    def test_interrupted_operation_recovered_on_next_run(self):
        self.inst.root.mkdir()
        pending = {}
        for key, path in self.inst.paths.items():
            before = path.read_bytes() if path.exists() else None
            pending[key] = {"before": base64.b64encode(before).decode() if before else None,
                            "after": base64.b64encode(b'{"partial": true}\n').decode()}
        core.atomic_write(self.inst.root / "pending.json", core.encode_object(pending))
        core.atomic_write(self.profile / "state.json", b'{"partial": true}\n')
        with self.inst.locked():
            pass
        self.assertEqual(core.read_object(self.profile / "state.json"), self.state)
        self.assertEqual(core.read_object(self.profile / "settings/settings.json"), self.settings)

    def test_interrupted_operation_does_not_overwrite_later_external_edits(self):
        self.inst.root.mkdir()
        pending = {key: {"before": None, "after": base64.b64encode(b"{}").decode()} for key in self.inst.paths}
        core.atomic_write(self.inst.root / "pending.json", core.encode_object(pending))
        with self.assertRaisesRegex(core.InstallError, "settings changed"):
            with self.inst.locked():
                pass
        self.assertEqual(core.read_object(self.profile / "state.json"), self.state)

    def test_cannot_downgrade_with_old_installer(self):
        self.inst.activate(make_bundle("0.2.0"))
        with self.assertRaisesRegex(core.InstallError, "older bundle"):
            self.inst.activate(make_bundle())
        self.assertEqual(self.inst.info()["current"]["version"], "0.2.0")

    def test_corrupt_json_left_untouched(self):
        (self.profile / "state.json").write_text("{ broken")
        with self.assertRaisesRegex(core.InstallError, "not valid JSON"):
            self.inst.activate(make_bundle())
        self.assertEqual((self.profile / "state.json").read_text(), "{ broken")

    def test_no_rollback_before_first_update(self):
        self.inst.activate(make_bundle())
        with self.assertRaisesRegex(core.InstallError, "no previous"):
            self.inst.rollback()

    def test_remove_does_not_override_new_custom_selection(self):
        self.inst.activate(make_bundle())
        self.state["vencordDir"] = "another-build"
        core.atomic_write(self.profile / "state.json", core.encode_object(self.state))
        with self.assertRaisesRegex(core.InstallError, "selection changed"):
            self.inst.uninstall()
        self.assertEqual(core.read_object(self.profile / "state.json"), self.state)

    def test_absent_plugin_settings_restored_without_disabling_other_plugins(self):
        core.atomic_write(self.profile / "settings/settings.json", core.encode_object({"plugins": {}}))
        self.inst.activate(make_bundle())
        self.inst.uninstall()
        self.assertNotIn("enabled", core.read_object(self.profile / "settings/settings.json")["plugins"]["ComfyPeeper"])

    def test_invalid_release_record_cannot_escape_install_directory(self):
        with self.assertRaises(core.InstallError):
            self.inst.release_path("../../elsewhere")

    def test_second_installer_cannot_take_lock(self):
        with self.inst.locked():
            with self.assertRaisesRegex(core.InstallError, "Another Peeper"):
                with core.Installation(self.profile).locked():
                    pass


class BundleTests(unittest.TestCase):
    def test_rejects_wrong_archive_checksum(self):
        with self.assertRaisesRegex(core.InstallError, "checksum"):
            core.Bundle(make_bundle().data, "0" * 64)

    def test_rejects_missing_required_file(self):
        with self.assertRaisesRegex(core.InstallError, "incomplete"):
            make_bundle(manifest_edit=lambda m: m["files"].pop("package.json"))

    def test_rejects_file_checksum_mismatch(self):
        with self.assertRaisesRegex(core.InstallError, "verification failed"):
            make_bundle(manifest_edit=lambda m: m["files"].update({"package.json": "0" * 64}))

    def test_rejects_archive_path_traversal_and_windows_paths(self):
        for name in ("../evil.js", "/evil.js", "C:\\evil.js", "dir/evil.js", "..", "evil:ads"):
            with self.subTest(name=name), self.assertRaises(core.InstallError):
                make_bundle(extra={name: b"bad"})

    def test_rejects_case_insensitive_duplicates(self):
        with self.assertRaisesRegex(core.InstallError, "duplicate"):
            make_bundle(extra={"PACKAGE.JSON": b"{}"})

    def test_rejects_enabled_stock_updater(self):
        with self.assertRaisesRegex(core.InstallError, "not a supported"):
            make_bundle(manifest_edit=lambda m: m.update(updater_disabled=False))

    def test_network_errors_have_actionable_messages(self):
        with patch.object(core, "urlopen", side_effect=core.URLError("offline")):
            with self.assertRaisesRegex(core.InstallError, "offline"):
                core.latest_bundle()

    def test_untrusted_url_is_rejected_before_network(self):
        with patch.object(core, "urlopen") as fetch:
            with self.assertRaises(core.InstallError):
                core.download("https://untrusted.invalid/bundle.zip")
            fetch.assert_not_called()

    def test_latest_requires_matching_tag(self):
        bundle = make_bundle()
        release = {"tag_name": "v0.2.0", "assets": [
            {"name": n, "browser_download_url": f"https://github.com/{core.REPOSITORY}/releases/download/v0.2.0/{n}"}
            for n in (core.BUNDLE_NAME, core.BUNDLE_NAME + ".sha256")]}
        with patch.object(core, "download", side_effect=[json.dumps(release).encode(), bundle.digest.encode(), bundle.data]):
            with self.assertRaisesRegex(core.InstallError, "does not match"):
                core.latest_bundle()


class DetectionTests(unittest.TestCase):
    def test_macos_application_support_and_custom(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            native = home / "Library/Application Support/vesktop"
            custom = home / "Custom Vesktop Data"
            linux = home / ".config/vesktop"
            for path in (native, custom, linux):
                path.mkdir(parents=True)
                (path / "state.json").write_text("{}")
            env = {"VENCORD_USER_DATA_DIR": str(custom), "XDG_CONFIG_HOME": str(home / ".config")}
            self.assertEqual(core.discover_profiles(home, env, "darwin"), [custom, native])
            # Duplicate custom/default paths must not ask users to choose twice.
            env["VENCORD_USER_DATA_DIR"] = str(native)
            self.assertEqual(core.discover_profiles(home, env, "darwin"), [native])

    def test_macos_missing_profile_is_not_created(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            self.assertEqual(core.discover_profiles(home, {}, "darwin"), [])
            self.assertFalse((home / "Library").exists())

    def test_macos_lifecycle_with_spaces_in_profile_path(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(core, "vesktop_pids", return_value=[]):
            home = Path(temp).resolve()
            profile = home / "Library/Application Support/vesktop"
            core.atomic_write(profile / "state.json", b'{"firstLaunch": false}')
            inst = core.Installation(core.discover_profiles(home, {}, "darwin")[0])
            inst.activate(make_bundle())
            inst.activate(make_bundle("0.2.0"))
            inst.repair()
            inst.rollback()
            self.assertEqual(inst.info()["current"]["version"], "0.1.0")
            inst.uninstall()
            self.assertEqual(core.read_object(profile / "state.json"), {"firstLaunch": False})

    def test_vesktop_main_and_macos_helpers_block_install(self):
        names = ["Vesktop", "vesktop.exe", "Vesktop Helper", "Vesktop Helper (Renderer)",
                 "Vesktop Helper (GPU)", "Vesktop Helper (Plugin)", "Discord", "Safari"]
        processes = [SimpleNamespace(pid=i, info={"name": name, "cmdline": []}) for i, name in enumerate(names, 1)]
        with patch.object(core.psutil, "process_iter", return_value=processes):
            self.assertEqual(core.vesktop_pids(), [1, 2, 3, 4, 5, 6])

    def test_macos_running_message_explains_cmd_q(self):
        with patch.object(core.sys, "platform", "darwin"), patch.object(core, "vesktop_pids", return_value=[123]):
            with self.assertRaisesRegex(core.InstallError, "Cmd\\+Q"):
                core.ensure_closed()

    def test_linux_native_flatpak_snap_and_custom(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            paths = [home / ".config/vesktop", home / ".var/app/dev.vencord.Vesktop/config/vesktop",
                     home / "snap/vesktop/current/.config/vesktop", home / "custom"]
            for path in paths:
                path.mkdir(parents=True)
                (path / "state.json").write_text("{}")
            self.assertEqual(set(core.discover_profiles(home, {"VENCORD_USER_DATA_DIR": str(paths[-1])}, "linux")), set(paths))

    def test_windows_roaming_and_portable(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp).resolve()
            roaming = home / "Roaming/vesktop"
            portable = home / "Local/Programs/Vesktop/Data"
            for path in (roaming, portable):
                path.mkdir(parents=True)
                (path / "state.json").write_text("{}")
            env = {"APPDATA": str(home / "Roaming"), "LOCALAPPDATA": str(home / "Local")}
            self.assertEqual(core.discover_profiles(home, env, "win32"), [roaming, portable])
            self.assertEqual(core.profile_path(portable.parent), portable)

    def test_no_fake_profile_is_created(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(core.InstallError):
                core.Installation(Path(temp))
            self.assertEqual(list(Path(temp).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
