"""覆盖终端重绘保留字符与分片控制序列，避免把增量字节误当作完整文本。"""

import runpy
import unittest
from pathlib import Path

TerminalScreen = runpy.run_path(str(Path(__file__).resolve().parents[1] / "terminal_screen.py"))[
    "TerminalScreen"
]


class TerminalScreenTests(unittest.TestCase):
    def test_wide_character_clears_the_covered_old_cell(self):
        screen = TerminalScreen(2, 40)
        screen.feed(b"reply:xi-unicode")
        screen.feed("\x1b[1;7H文".encode())
        self.assertIn("reply:文 -unicode".encode(), screen.text())
        self.assertNotIn("文i".encode(), screen.text())

    def test_model_reload_and_status_keep_unchanged_characters(self):
        screen = TerminalScreen(2, 40)
        screen.feed(b"fixture-third\x1b[2;1HIdle")
        screen.feed(b"\x1b[1;9Hpty  \x1b[2;1HMod\x1b[2;5Hl configuration updated")
        self.assertIn(b"fixture-pty", screen.text())
        self.assertIn(b"Model configuration updated", screen.text())
        self.assertNotIn(b"fixture-third", screen.text())

    def test_split_escape_and_utf8_survive_and_clear_removes_old_text(self):
        screen = TerminalScreen(2, 40)
        screen.feed("模型".encode()[:2])
        screen.feed("模型".encode()[2:] + b"\x1b[1;")
        screen.feed(b"5Hlive")
        self.assertIn("模型live".encode(), screen.text().replace(b" ", b""))
        screen.clear()
        self.assertNotIn(b"live", screen.text())
        screen.feed(b"\x1b[1;1Hnew")
        self.assertIn(b"new", screen.text())
