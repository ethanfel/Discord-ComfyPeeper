from pathlib import Path
import runpy
import unittest


ROOT = Path(__file__).resolve().parents[2]
build_command = runpy.run_path(str(ROOT / "scripts/package-installer.py"))["build_command"]


class PackagingTests(unittest.TestCase):
    def test_macos_is_native_arm64_app_bundle(self):
        name, command = build_command(ROOT, "darwin", "arm64")
        self.assertEqual(name, "ComfyPeeper Installer")
        self.assertIn("--onedir", command)
        self.assertIn("--windowed", command)
        self.assertNotIn("--onefile", command)
        self.assertEqual(command[command.index("--target-architecture") + 1], "arm64")
        self.assertIn("io.github.ethanfel.comfypeeper-installer", command)

    def test_macos_rejects_intel_or_rosetta_python(self):
        with self.assertRaisesRegex(SystemExit, "Apple Silicon"):
            build_command(ROOT, "darwin", "x86_64")

    def test_windows_and_linux_remain_single_file(self):
        for target, machine, name in (("win32", "AMD64", "ComfyPeeper-Setup-Windows-x64"),
                                      ("linux", "x86_64", "ComfyPeeper-Installer")):
            with self.subTest(target=target):
                actual_name, command = build_command(ROOT, target, machine)
                self.assertEqual(actual_name, name)
                self.assertIn("--onefile", command)
                self.assertNotIn("--target-architecture", command)

    def test_does_not_mislabel_unsupported_architecture(self):
        for target in ("win32", "linux"):
            with self.subTest(target=target), self.assertRaisesRegex(SystemExit, "x64"):
                build_command(ROOT, target, "arm64")


if __name__ == "__main__":
    unittest.main()
