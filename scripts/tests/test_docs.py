"""文档迁移后检查双向语言导航，防止只有入口而没有对应译文。"""

import importlib.util
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "check_docs", Path(__file__).resolve().parents[1] / "check-docs.py"
)
docs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(docs)


class LanguageNavigationTest(unittest.TestCase):
    def test_nested_page_requires_its_own_translation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "api" / "core.md"
            path.parent.mkdir()
            path.write_text("**中文** | [English](core.en.md)\n\n# Core\n")
            self.assertEqual(docs.language_errors(path), ["缺少对应语言文件: core.en.md"])
            translated = path.with_name("core.en.md")
            translated.write_text("[中文](core.md) | **English**\n\n# Core\n")
            self.assertEqual(docs.language_errors(path), [])
            self.assertEqual(docs.language_errors(translated), [])

    def test_home_link_cannot_replace_reverse_language_switch(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "core.en.md"
            path.with_name("core.md").write_text("# Core\n")
            path.write_text("[中文](../README.md) | **English**\n\n# Core\n")
            self.assertEqual(
                docs.language_errors(path), ["第一行应为: [中文](core.md) | **English**"]
            )

    def test_empty_page_and_directory_instead_of_translation_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "README.md"
            path.write_text("")
            path.with_name("README.en.md").mkdir()
            self.assertEqual(len(docs.language_errors(path)), 2)


if __name__ == "__main__":
    unittest.main()
