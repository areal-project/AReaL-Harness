"""重建 Crossterm 增量输出，用于真实终端 smoke 的画面断言。"""

import codecs
import re
import unicodedata


class TerminalScreen:
    """Apply the cursor/erase commands emitted by Crossterm before matching text."""

    def __init__(self, rows=40, columns=150):
        self.rows, self.columns = rows, columns
        self.clear()
        self.pending = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")

    def clear(self):
        self.cells = [[" "] * self.columns for _ in range(self.rows)]
        self.row = self.column = 0

    def feed(self, data):
        self.pending += self.decoder.decode(data)
        index = 0
        while index < len(self.pending):
            char = self.pending[index]
            if char == "\x1b":
                if index + 1 == len(self.pending):
                    break
                if self.pending[index + 1] == "[":
                    match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", self.pending[index:])
                    if not match:
                        break
                    params, _, command = match.groups()
                    if params == "?1049" and command == "h":
                        self.clear()
                    values = (
                        [int(value or 0) for value in params.split(";")]
                        if not params.startswith("?")
                        else []
                    )
                    amount = (values[0] if values else 0) or 1
                    if command in ("H", "f"):
                        self.row = amount - 1
                        self.column = ((values[1] if len(values) > 1 else 0) or 1) - 1
                    elif command == "A":
                        self.row -= amount
                    elif command == "B":
                        self.row += amount
                    elif command == "C":
                        self.column += amount
                    elif command == "D":
                        self.column -= amount
                    elif command == "G":
                        self.column = amount - 1
                    elif command == "d":
                        self.row = amount - 1
                    elif command == "J" and values and values[0] == 2:
                        self.cells = [[" "] * self.columns for _ in range(self.rows)]
                    elif command == "K":
                        mode = values[0] if values else 0
                        start = self.column if mode == 0 else 0
                        end = self.column + 1 if mode == 1 else self.columns
                        self.cells[self.row][start:end] = [" "] * (end - start)
                    self.row = max(0, min(self.rows - 1, self.row))
                    self.column = max(0, min(self.columns - 1, self.column))
                    index += len(match.group())
                    continue
                index += 2
                continue
            if char == "\r":
                self.column = 0
            elif char == "\n":
                self.row = min(self.row + 1, self.rows - 1)
            elif char == "\b":
                self.column = max(0, self.column - 1)
            elif char >= " " and not unicodedata.combining(char):
                if self.column >= self.columns:
                    self.column = 0
                    self.row = min(self.row + 1, self.rows - 1)
                self.cells[self.row][self.column] = char
                width = 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
                # 宽字符占据两格，增量重绘不会另发空格来清除被覆盖的旧字符。
                if width == 2 and self.column + 1 < self.columns:
                    self.cells[self.row][self.column + 1] = " "
                self.column += width
            index += 1
        self.pending = self.pending[index:]

    def text(self):
        return "\n".join("".join(row) for row in self.cells).encode()
