"""Independent generated behavioral checks for the COBOL replacement."""

from __future__ import annotations

import random
import tempfile
import unittest
from pathlib import Path

from sandbox_runner import run_isolated


CANDIDATE = Path("/app/allocate.py")


def item_name(index: int) -> bytes:
    return f"I{index:05d}".encode("ascii")


def build_case(seed: int, stock_count: int, request_count: int) -> tuple[dict[str, bytes], dict[str, bytes]]:
    rng = random.Random(seed)
    rows = []
    for index in range(stock_count):
        hand = rng.randint(2, 700000)
        reserved = rng.randint(0, hand)
        rows.append(
            {
                "item": item_name(index),
                "bin": f"{index % 36:04X}".encode("ascii"),
                "hand": hand,
                "reserved": reserved,
                "flag": rng.choice((b"Y", b"N")),
            }
        )
    rng.shuffle(rows)
    by_item = {row["item"]: row for row in rows}

    requests = []
    audit = bytearray()
    for index in range(request_count):
        if index % 9 == 0:
            item = b"Z99999"
        else:
            item = rng.choice(rows)["item"]
        operation = b"A" if index % 3 else b"R"
        row = by_item.get(item)
        if row is None:
            quantity = rng.randint(1, 999999)
        elif index % 7 == 0:
            quantity = min(999999, row["hand"] + 1)
        elif operation == b"A":
            available = row["hand"] - row["reserved"]
            quantity = max(1, min(999999, available if index % 5 else available + 1))
        else:
            quantity = max(1, min(999999, row["reserved"] if index % 5 else row["reserved"] + 1))
        request = f"{index + 1:04d}".encode("ascii") + operation + item + f"{quantity:06d}".encode("ascii")
        requests.append(request)

        accepted = False
        result = 0
        if row is not None:
            if operation == b"A" and quantity <= row["hand"] - row["reserved"]:
                row["reserved"] += quantity
                accepted = True
            if operation == b"R" and quantity <= row["reserved"]:
                row["reserved"] -= quantity
                accepted = True
            row["flag"] = b"Y" if row["reserved"] == row["hand"] else b"N"
            result = row["reserved"]
        audit.extend(request + (b"Y" if accepted else b"N") + f"{result:06d}".encode("ascii"))

    initial_rows = []
    truth_rows = []
    # Recreate initial values from a second deterministic pass so truth mutation
    # never becomes the serialized candidate input.
    initial_rng = random.Random(seed)
    original_by_item = {}
    for index in range(stock_count):
        hand = initial_rng.randint(2, 700000)
        reserved = initial_rng.randint(0, hand)
        original_by_item[item_name(index)] = {
            "hand": hand,
            "reserved": reserved,
            "flag": initial_rng.choice((b"Y", b"N")),
            "bin": f"{index % 36:04X}".encode("ascii"),
        }
    for row in rows:
        original = original_by_item[row["item"]]
        initial_rows.append(
            row["item"] + original["bin"] + f"{original['hand']:06d}{original['reserved']:06d}".encode("ascii") + original["flag"]
        )
        truth_rows.append(
            row["item"] + row["bin"] + f"{row['hand']:06d}{row['reserved']:06d}".encode("ascii") + row["flag"]
        )
    inputs = {
        "/work/case/STOCK.DAT": b"".join(initial_rows),
        "/work/case/REQUESTS.DAT": b"".join(requests),
    }
    expected = {
        "/work/output/STOCK.DAT": b"".join(truth_rows),
        "/work/output/AUDIT.DAT": bytes(audit),
    }
    return inputs, expected


def build_field_boundary_case() -> tuple[dict[str, bytes], dict[str, bytes]]:
    def stock(item: bytes, bin_id: bytes, hand: int, reserved: int, flag: bytes) -> bytes:
        record = item + bin_id + f"{hand:06d}{reserved:06d}".encode("ascii") + flag
        assert len(record) == 23
        return record

    def request(sequence: int, operation: bytes, item: bytes, quantity: int) -> bytes:
        record = f"{sequence:04d}".encode("ascii") + operation + item + f"{quantity:06d}".encode("ascii")
        assert len(record) == 17
        return record

    stock_rows = (
        stock(b"A00000", b"0000", 0, 0, b"Y"),
        stock(b"Z99999", b"9AZ0", 999999, 999999, b"N"),
        stock(b"ZZZZZZ", b"ZZZZ", 1, 0, b"N"),
    )
    request_rows = (
        request(1, b"A", b"A00000", 1),       # available 0: one over, rejected
        request(2, b"R", b"A00000", 1),       # reserved 0: one over, rejected
        request(9999, b"R", b"Z99999", 999999),  # exact reserved maximum
        request(3, b"A", b"Z99999", 999999),  # exact available maximum
        request(4, b"A", b"Z99999", 1),       # available 0: one over
        request(5, b"R", b"ZZZZZZ", 1),       # reserved 0: one over
    )
    stocks = b"".join(stock_rows)
    requests = b"".join(request_rows)
    expected_stock = b"".join((
        stock(b"A00000", b"0000", 0, 0, b"Y"),
        stock(b"Z99999", b"9AZ0", 999999, 999999, b"Y"),
        stock(b"ZZZZZZ", b"ZZZZ", 1, 0, b"N"),
    ))
    audit = (
        requests[0:17] + b"N000000"
        + requests[17:34] + b"N000000"
        + requests[34:51] + b"Y000000"
        + requests[51:68] + b"Y999999"
        + requests[68:85] + b"N999999"
        + requests[85:102] + b"N000000"
    )
    assert len(stocks) == 3 * 23 and len(requests) == 6 * 17
    assert len(expected_stock) == 3 * 23 and len(audit) == 6 * 24
    return {
        "/work/case/STOCK.DAT": stocks,
        "/work/case/REQUESTS.DAT": requests,
    }, {
        "/work/output/STOCK.DAT": expected_stock,
        "/work/output/AUDIT.DAT": audit,
    }


class TaskTests(unittest.TestCase):
    def assert_inputs(self, inputs: dict[str, bytes], expected: dict[str, bytes]) -> None:
        source_before = CANDIDATE.read_bytes()
        result = run_isolated(
            CANDIDATE,
            ["/work/case", "/work/output"],
            input_files=inputs,
            collect_paths=("/work/case", "/work/output"),
            candidate_path="/app/allocate.py",
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")
        self.assertEqual({key: value for key, value in result.files.items() if key.startswith("/work/output/")}, expected)
        self.assertEqual({key: value for key, value in result.files.items() if key.startswith("/work/case/")}, inputs)
        self.assertEqual(
            result.entries,
            {
                "/work/case": "directory",
                "/work/case/STOCK.DAT": "regular",
                "/work/case/REQUESTS.DAT": "regular",
                "/work/output": "directory",
                "/work/output/STOCK.DAT": "regular",
                "/work/output/AUDIT.DAT": "regular",
            },
        )
        self.assertEqual(CANDIDATE.read_bytes(), source_before)

    def assert_case(self, seed: int, stock_count: int, request_count: int) -> None:
        inputs, expected = build_case(seed, stock_count, request_count)
        self.assert_inputs(inputs, expected)

    def test_01_generated_families(self) -> None:
        for seed, stocks, requests in ((13011, 7, 29), (13012, 19, 83), (13013, 43, 151)):
            with self.subTest(seed=seed):
                self.assert_case(seed, stocks, requests)

    def test_02_minimum_and_maximum_boundaries(self) -> None:
        self.assert_case(13020, 1, 1)
        self.assert_case(13021, 256, 1024)

    def test_03_repeat_independence(self) -> None:
        self.assert_case(13031, 12, 45)
        self.assert_case(13032, 5, 18)

    def test_04_field_boundaries(self) -> None:
        self.assert_inputs(*build_field_boundary_case())

    def test_05_runner_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            probe = Path(temporary) / "probe.py"
            probe.write_text("import os\ntry:\n os.fork()\nexcept PermissionError:\n print('blocked')\n", encoding="utf-8")
            result = run_isolated(probe, [])
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"blocked\n", b""))


if __name__ == "__main__":
    unittest.main()
