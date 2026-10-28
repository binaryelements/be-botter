"""rakazo-browser launches Chromium so that it yields the CPU to the desktop's own services."""

import os
import pathlib
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
LAUNCHER = HERE / "rakazo-browser"

FAKE_BROWSER = """#!/bin/sh
# Field 19 of /proc/<pid>/stat is the nice value; argv follows on the next lines.
awk '{print $19}' /proc/$$/stat > "$RAKAZO_TEST_RECORD"
for arg in "$@"; do printf '%s\\n' "$arg" >> "$RAKAZO_TEST_RECORD"; done
"""


class BrowserLaunchTest(unittest.TestCase):
    def launch(self, *args):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "bin").mkdir()
            fake = root / "bin" / "chromium"
            fake.write_text(FAKE_BROWSER)
            fake.chmod(0o755)
            record = root / "record"
            env = {
                "PATH": f"{root / 'bin'}:{os.environ['PATH']}",
                "HOME": str(root),
                "DISPLAY": ":1",
                "RAKAZO_BROWSER_PROFILE": str(root / "profile"),
                "RAKAZO_TEST_RECORD": str(record),
            }
            result = subprocess.run(
                [str(LAUNCHER), *args], env=env, capture_output=True, text=True, timeout=30
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            lines = record.read_text().splitlines()
            return int(lines[0]), lines[1:]

    def test_runs_chromium_below_the_desktop_services_priority(self):
        # Screenshots, input and the VNC stream share the computer's CPU cap with
        # Chromium's software rendering; a lower priority keeps them responsive.
        nice, _argv = self.launch("https://example.test")
        self.assertEqual(nice, 10)

    def test_keeps_the_browser_flags_and_profile(self):
        nice, argv = self.launch("https://example.test")
        self.assertIn("--disable-gpu", argv)
        self.assertTrue(any(arg.startswith("--user-data-dir=") for arg in argv))
        self.assertEqual(argv[-1], "https://example.test")


if __name__ == "__main__":
    unittest.main()
