import unittest

try:
    from .folder_paths import (
        folder_branch_like_patterns,
        folder_path_variants,
        normalize_folder_path,
    )
except ImportError:
    from folder_paths import (
        folder_branch_like_patterns,
        folder_path_variants,
        normalize_folder_path,
    )


class FolderPathTests(unittest.TestCase):
    def test_normalizes_trailing_separators(self):
        self.assertEqual(normalize_folder_path(" /Users/achbj/Movies/ "), "/Users/achbj/Movies")
        self.assertEqual(normalize_folder_path(r"C:\Users\achbj\Movies\\"), r"C:\Users\achbj\Movies")
        self.assertEqual(normalize_folder_path("/"), "/")
        self.assertEqual(normalize_folder_path("C:\\"), "C:\\")

    def test_builds_separator_variants(self):
        self.assertEqual(
            folder_path_variants(r"C:\Users\achbj\Movies"),
            [r"C:\Users\achbj\Movies", "C:/Users/achbj/Movies"],
        )

    def test_builds_descendant_like_patterns_without_sibling_prefixes(self):
        self.assertEqual(
            folder_branch_like_patterns("/Users/achbj/Movies"),
            [
                r"/Users/achbj/Movies/%",
                r"/Users/achbj/Movies\\%",
                r"\\Users\\achbj\\Movies/%",
                r"\\Users\\achbj\\Movies\\%",
            ],
        )

    def test_escapes_sql_like_wildcards(self):
        self.assertIn(
            r"/Users/a\%b/cache/%",
            folder_branch_like_patterns("/Users/a%b/cache"),
        )


if __name__ == "__main__":
    unittest.main()
