import base64
import io
import json
from pathlib import Path
import shutil
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

    def test_same_release_reinstall_preserves_rollback_and_reuses_files(self):
        self.inst.activate(make_bundle())
        latest = make_bundle("0.1.1")
        self.inst.activate(latest)
        before = self.inst.info()
        self.inst.activate(latest)
        self.assertEqual(self.inst.info(), before)
        self.inst.rollback()
        self.assertEqual(self.inst.info()["current"]["version"], "0.1.0")

    def test_download_repairs_missing_or_corrupt_cache_without_losing_rollback(self):
        self.inst.activate(make_bundle())
        latest = make_bundle("0.1.1")
        self.inst.activate(latest)
        before = self.inst.info()
        cache = self.inst.root / "downloads" / f"{latest.digest}.zip"
        for corruption in (None, b"broken"):
            with self.subTest(corruption=corruption):
                cache.unlink()
                if corruption is not None:
                    cache.write_bytes(corruption)
                self.inst.activate(latest)
                self.assertEqual(cache.read_bytes(), latest.data)
                self.assertEqual(self.inst.info(), before)

    def test_offline_repair_uses_matching_embedded_bundle_when_cache_is_missing(self):
        bundle = make_bundle()
        self.inst.activate(bundle)
        (self.inst.root / "downloads" / f"{bundle.digest}.zip").unlink()
        with patch.object(core, "bundled_payload", return_value=bundle):
            self.inst.repair()
        self.assertIn("installed and enabled", self.inst.status())

    def test_offline_repair_does_not_downgrade_when_cache_is_missing(self):
        latest = make_bundle("0.2.0")
        self.inst.activate(latest)
        (self.inst.root / "downloads" / f"{latest.digest}.zip").unlink()
        with patch.object(core, "bundled_payload", return_value=make_bundle()):
            with self.assertRaisesRegex(core.InstallError, "Use Update"):
                self.inst.repair()
        self.assertEqual(self.inst.info()["current"]["version"], "0.2.0")

    def test_updates_and_repairs_keep_only_current_and_rollback(self):
        for version in ("0.1.0", "0.1.1", "0.1.2", "0.1.3"):
            self.inst.activate(make_bundle(version))
        before = self.inst.info()
        for _ in range(4):
            self.inst.repair()
        self.assertEqual(self.inst.info(), before)
        self.assertEqual({p.name for p in (self.inst.root / "releases").iterdir()},
                         {before[key]["directory"] for key in ("current", "previous")})
        self.assertEqual({p.name for p in (self.inst.root / "downloads").iterdir()},
                         {before[key]["sha256"] + ".zip" for key in ("current", "previous")})
        self.inst.rollback()
        self.assertEqual(self.inst.info()["current"]["version"], "0.1.2")

    def test_corrupt_release_repair_collects_replaced_files_only(self):
        self.inst.activate(make_bundle())
        self.inst.activate(make_bundle("0.1.1"))
        before = self.inst.info()
        broken = self.inst.release_path(before["current"]["directory"])
        (broken / "package.json").write_text("bad")
        self.inst.repair()
        self.assertFalse(broken.exists())
        self.assertEqual(self.inst.info()["previous"], before["previous"])
        self.assertEqual(len(list((self.inst.root / "releases").iterdir())), 2)

    def test_cleanup_keeps_unknown_files_and_symlinks(self):
        self.inst.activate(make_bundle())
        unknown = self.inst.root / "releases/notes"
        unknown.mkdir()
        (unknown / "keep.txt").write_text("user notes")
        external = self.home / "external"
        external.mkdir()
        (external / "keep.txt").write_text("external data")
        link = self.inst.root / "releases" / ("0.0.1-" + "a" * 12 + "-" + "b" * 8)
        try:
            link.symlink_to(external, target_is_directory=True)
        except OSError:
            self.skipTest("Host does not permit symlinks")
        self.inst.repair()
        self.assertTrue(link.is_symlink())
        self.assertEqual((external / "keep.txt").read_text(), "external data")
        self.assertEqual((unknown / "keep.txt").read_text(), "user notes")

    def test_cleanup_is_deferred_while_recovery_journal_exists(self):
        self.inst.activate(make_bundle())
        orphan = self.inst.root / "downloads" / ("a" * 64 + ".zip")
        orphan.write_bytes(b"orphan")
        core.atomic_write(self.inst.root / "pending.json", b"{}")
        self.inst.cleanup()
        self.assertTrue(orphan.exists())

    def test_cleanup_failure_does_not_fail_committed_update(self):
        self.inst.activate(make_bundle())
        self.inst.activate(make_bundle("0.1.1"))
        with patch.object(core.shutil, "rmtree", side_effect=PermissionError("locked file")):
            self.inst.activate(make_bundle("0.1.2"))
        self.assertIn("0.1.2 is installed and enabled", self.inst.status())

    def test_failed_update_keeps_previous_and_current_bundles(self):
        self.inst.activate(make_bundle())
        self.inst.activate(make_bundle("0.1.1"))
        before = self.inst.info()
        with patch.object(self.inst, "transaction", side_effect=OSError("full disk")):
            with self.assertRaises(OSError):
                self.inst.activate(make_bundle("0.1.2"))
        self.assertEqual(self.inst.info(), before)
        self.assertEqual(len(list((self.inst.root / "releases").iterdir())), 2)
        self.inst.verify_release(before)
        self.inst.verify_release(before, "previous")

    def test_malformed_nested_settings_never_crash_status_or_get_overwritten(self):
        self.inst.activate(make_bundle())
        self.inst.activate(make_bundle("0.1.1"))
        for bad in ({"plugins": None}, {"plugins": []}, {"plugins": {"ComfyPeeper": None}},
                    {"plugins": {"ComfyPeeper": "bad"}}):
            with self.subTest(settings=bad):
                data = core.encode_object(bad)
                core.atomic_write(self.profile / "settings/settings.json", data)
                self.assertIn("malformed", self.inst.status())
                for action in (self.inst.repair, self.inst.rollback, self.inst.uninstall):
                    with self.assertRaisesRegex(core.InstallError, "malformed"):
                        action()
                self.assertEqual((self.profile / "settings/settings.json").read_bytes(), data)

    def test_malformed_installation_record_is_actionable(self):
        self.inst.activate(make_bundle())
        info = self.inst.info()
        info["current"].pop("directory")
        core.atomic_write(self.inst.paths["installation"], core.encode_object(info))
        with self.assertRaisesRegex(core.InstallError, "record is invalid"):
            self.inst.info()

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
    def test_snap_selection_survives_refresh_and_old_revision_removal(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(core, "vesktop_pids", return_value=[]):
            home = Path(temp).resolve()
            old = home / "snap/vesktop/100"
            new = home / "snap/vesktop/101"
            core.atomic_write(old / ".config/vesktop/state.json", b"{}")
            alias = old.parent / "current"
            try:
                alias.symlink_to(old.name, target_is_directory=True)
            except OSError:
                self.skipTest("Host does not permit symlinks")
            inst = core.Installation(core.discover_profiles(home, {}, "linux")[0])
            inst.activate(make_bundle())
            selected = core.read_object(inst.paths["state"])["vencordDir"]
            self.assertIn("current", Path(selected).parts)
            shutil.copytree(old, new)
            alias.unlink()
            alias.symlink_to(new.name, target_is_directory=True)
            old.rename(old.with_name("retired-100"))
            moved = core.Installation(core.discover_profiles(home, {}, "linux")[0])
            self.assertTrue(Path(selected).is_dir())
            self.assertIn("installed and enabled", moved.status())
            moved.repair()
            moved.uninstall()
            self.assertNotIn("vencordDir", core.read_object(moved.paths["state"]))

    def test_snap_existing_absolute_selection_migrates_on_repair(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(core, "vesktop_pids", return_value=[]):
            home = Path(temp).resolve()
            profile = home / "snap/vesktop/100/.config/vesktop"
            core.atomic_write(profile / "state.json", b"{}")
            try:
                (home / "snap/vesktop/current").symlink_to("100", target_is_directory=True)
            except OSError:
                self.skipTest("Host does not permit symlinks")
            inst = core.Installation(profile)
            inst.activate(make_bundle())
            state = core.read_object(inst.paths["state"])
            state["vencordDir"] = str(inst.release_path(inst.info()["current"]["directory"]))
            core.atomic_write(inst.paths["state"], core.encode_object(state))
            inst.repair()
            self.assertIn("current", Path(core.read_object(inst.paths["state"])["vencordDir"]).parts)

    def test_inactive_snap_revision_is_not_modified(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(core, "vesktop_pids", return_value=[]):
            home = Path(temp).resolve()
            profile = home / "snap/vesktop/100/.config/vesktop"
            core.atomic_write(profile / "state.json", b"{}")
            core.atomic_write(home / "snap/vesktop/101/.config/vesktop/state.json", b"{}")
            try:
                (home / "snap/vesktop/current").symlink_to("101", target_is_directory=True)
            except OSError:
                self.skipTest("Host does not permit symlinks")
            with self.assertRaisesRegex(core.InstallError, "no longer current"):
                core.Installation(profile).activate(make_bundle())
            self.assertEqual(core.read_object(profile / "state.json"), {})

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
