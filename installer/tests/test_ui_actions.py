import json
from pathlib import Path
import queue
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from installer import core, main
from installer.tests.test_core import make_bundle


def window(profile):
    return SimpleNamespace(busy=False, profile=Mock(get=Mock(return_value=str(profile))),
                           events=queue.Queue(), buttons=[], chooser=Mock(), progress=Mock(),
                           status=Mock(), checking_installer=False, new_installer_version=None,
                           installer_update_button=Mock(), log=Mock())


class ActionTests(unittest.TestCase):
    def test_update_button_uses_download_when_installed_cache_is_missing(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(core, "vesktop_pids", return_value=[]):
            profile = Path(temp).resolve()
            core.atomic_write(profile / "state.json", b"{}")
            bundle = make_bundle("0.1.1")
            inst = core.Installation(profile)
            inst.activate(bundle)
            cache = inst.root / "downloads" / f"{bundle.digest}.zip"
            cache.unlink()
            ui = window(profile)
            with patch.object(core, "latest_bundle", return_value=bundle), \
                    patch.object(main.threading, "Thread", side_effect=lambda **kwargs: SimpleNamespace(start=kwargs["target"])):
                main.InstallerWindow.start(ui, "update")
            self.assertEqual(cache.read_bytes(), bundle.data)
            events = list(ui.events.queue)
            self.assertTrue(any(kind == "done" for kind, _ in events), events)
            self.assertFalse(any(kind == "error" for kind, _ in events), events)

    def test_malformed_settings_render_error_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(core, "vesktop_pids", return_value=[]):
            profile = Path(temp).resolve()
            core.atomic_write(profile / "state.json", b"{}")
            inst = core.Installation(profile)
            inst.activate(make_bundle())
            core.atomic_write(profile / "settings/settings.json", b'{"plugins": null}')
            ui = window(profile)
            main.InstallerWindow.refresh_status(ui)
            self.assertIn("malformed", ui.status.set.call_args.args[0])

    def test_new_installer_is_offered_without_auto_opening_or_replacing_app(self):
        ui = window("unused")
        with patch.object(main, "VERSION", "0.1.1"), patch.object(main.webbrowser, "open") as browser:
            main.InstallerWindow.announce_installer_version(ui, "0.1.2")
            self.assertEqual(ui.new_installer_version, "0.1.2")
            browser.assert_not_called()
            main.InstallerWindow.check_installer_update(ui)
            browser.assert_called_once_with(core.RELEASES_URL + "/latest")

    def test_current_installer_does_not_offer_a_downgrade(self):
        ui = window("unused")
        with patch.object(main, "VERSION", "0.1.2"):
            main.InstallerWindow.announce_installer_version(ui, "0.1.1")
        self.assertIsNone(ui.new_installer_version)

    def test_installer_check_rejects_nonstable_or_invalid_metadata(self):
        for release in ({"tag_name": "v0.2.0", "prerelease": True}, {"tag_name": "main"}, {}):
            with self.subTest(release=release), patch.object(core, "download", return_value=json.dumps(release).encode()):
                with self.assertRaises(core.InstallError):
                    core.latest_installer_version()


if __name__ == "__main__":
    unittest.main()
