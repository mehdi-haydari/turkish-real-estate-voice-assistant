"""Installer checks without installing packages, downloading models or starting inference."""
import ast
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("native_installer", ROOT / "scripts/assistant.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class NativeInstallerTests(unittest.TestCase):
    def test_dry_run_never_downloads_or_mutates_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "installation"
            with patch.object(installer, "LOCAL", target), patch.object(installer, "download") as download:
                output = io.StringIO()
                with redirect_stdout(output):
                    self.assertEqual(installer.main(["install", "--dry-run", "--with-tts"]), 0)
                self.assertFalse(target.exists())
                download.assert_not_called()
                self.assertIn("audiovae", json.loads(output.getvalue())["assets"])

    def test_model_download_is_verified_and_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "upstream", Path(directory) / "model"
            source.write_bytes(b"test model fixture")
            asset = {"url": source.as_uri(), "size": source.stat().st_size,
                     "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
            installer.download(asset, target)
            self.assertEqual(target.read_bytes(), source.read_bytes())
            with patch.object(installer.urllib.request, "urlopen", side_effect=AssertionError("must reuse verified file")):
                installer.download(asset, target)

    def test_corrupt_download_is_not_installed(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "upstream", Path(directory) / "model"
            source.write_bytes(b"broken")
            asset = {"url": source.as_uri(), "size": 6, "sha256": "0" * 64}
            with self.assertRaises(RuntimeError):
                installer.download(asset, target)
            self.assertFalse(target.exists())
            self.assertFalse(target.with_name("model.part").exists())

    def test_native_profiles_and_local_only_tts_assets(self):
        for backend in ("cpu", "metal"):
            specs = installer.service_specs({"backend": backend, "tts": True, "tts_device": "cpu", "threads": 4})
            self.assertEqual([name for name, _, _ in specs], ["llm", "portfolio", "stt", "tts"])
            for _, args, env in specs:
                self.assertIn("127.0.0.1", args)
                self.assertEqual(env["HF_HUB_OFFLINE"], "1")
            self.assertEqual(specs[0][2]["WHISPER_USE_GPU"], "1" if backend == "metal" else "0")
            self.assertTrue(specs[-1][2]["FREYA_VAE_PATH"].endswith("audiovae.pth"))

    def test_no_tts_profile_does_not_start_tts(self):
        self.assertEqual(len(installer.service_specs({"backend": "cpu", "tts": False, "threads": 4})), 3)

    def test_unrelated_process_is_not_owned(self):
        with patch.object(installer.subprocess, "check_output", return_value="python another_project.py start"):
            self.assertFalse(installer.owns_pid(123))

    def test_status_does_not_mistake_other_services_for_this_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(installer, "PIDFILE", Path(directory) / "missing.json"), \
                 patch.object(installer, "read_settings", return_value={}), \
                 patch.object(installer.urllib.request, "urlopen") as request, redirect_stdout(io.StringIO()):
                self.assertEqual(installer.status(None), 1)
                request.assert_not_called()

    def test_asset_manifest_has_immutable_revisions_and_checksums(self):
        lock = installer.manifest()
        for runtime in lock["runtimes"].values():
            self.assertRegex(runtime["revision"], r"^[0-9a-f]{40}$")
        for asset in lock["models"].values():
            self.assertRegex(asset["sha256"], r"^[0-9a-f]{64}$")
            self.assertGreater(asset["size"], 0)
            self.assertTrue(asset["url"].startswith("https://"))
            self.assertFalse(Path(asset["path"]).is_absolute())
            self.assertNotIn("..", Path(asset["path"]).parts)

    def test_python_sources_parse_without_model_imports(self):
        for source in list((ROOT / "services").rglob("*.py")) + list((ROOT / "scripts").rglob("*.py")):
            ast.parse(source.read_text(), filename=str(source))


if __name__ == "__main__":
    unittest.main()
