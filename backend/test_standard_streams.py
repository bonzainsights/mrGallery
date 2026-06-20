import sys
import unittest

from backend.main import _STANDARD_STREAM_HANDLES, ensure_standard_streams


class StandardStreamTests(unittest.TestCase):
    def test_replaces_missing_standard_streams_for_no_console_builds(self):
        original_streams = {
            "stdin": sys.stdin,
            "stdout": sys.stdout,
            "stderr": sys.stderr,
        }
        original_handle_count = len(_STANDARD_STREAM_HANDLES)

        try:
            sys.stdin = None
            sys.stdout = None
            sys.stderr = None

            ensure_standard_streams()

            self.assertIsNotNone(sys.stdin)
            self.assertIsNotNone(sys.stdout)
            self.assertIsNotNone(sys.stderr)
            self.assertFalse(sys.stderr.isatty())
            sys.stderr.write("")
        finally:
            new_handles = _STANDARD_STREAM_HANDLES[original_handle_count:]
            for stream_name, stream in original_streams.items():
                setattr(sys, stream_name, stream)
            for handle in new_handles:
                handle.close()
            del _STANDARD_STREAM_HANDLES[original_handle_count:]


if __name__ == "__main__":
    unittest.main()
