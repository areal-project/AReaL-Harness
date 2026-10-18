"""Independent generated behavioral checks for the AWK replacement."""

from __future__ import annotations

import random
import tempfile
import unittest
from pathlib import Path

from sandbox_runner import run_isolated


CANDIDATE = Path("/app/rollup.py")


def case_name(index: int) -> str:
    prefixes = ("A", "A0", "A_", "B", "Z-")
    return f"{prefixes[index % len(prefixes)]}{index:04d}"


def build_stream(seed: int, case_count: int, event_count: int) -> tuple[dict[str, bytes], dict[str, bytes]]:
    rng = random.Random(seed)
    ids = [case_name(index) for index in range(case_count)]
    rng.shuffle(ids)
    state = {}
    events = []
    for index, case_id in enumerate(ids):
        owner = f"owner{index % 11}"
        score = rng.randint(-2_000_000_000, 2_000_000_000)
        events.append(f"OPEN\t{case_id}\t{owner}\t{score}")
        state[case_id] = {"owner": owner, "score": score, "state": "OPEN", "events": 1, "tags": set()}

    while len(events) < event_count:
        case_id = rng.choice(ids)
        current = state[case_id]
        selector = len(events) % 7
        if current["state"] == "CLOSED":
            events.append(f"REOPEN\t{case_id}")
            current["state"] = "OPEN"
        elif selector == 0:
            events.append(f"CLOSE\t{case_id}")
            current["state"] = "CLOSED"
        elif selector in (1, 2):
            value = rng.randint(-2_000_000_000, 2_000_000_000)
            events.append(f"ADD\t{case_id}\t{value}")
            current["score"] += value
        elif selector == 3:
            owner = f"owner{rng.randrange(17)}"
            events.append(f"OWNER\t{case_id}\t{owner}")
            current["owner"] = owner
        else:
            tag = rng.choice(("alpha", "Alpha", "z-last", "a-first", "tag 2", "tag_10"))
            events.append(f"TAG\t{case_id}\t{tag}")
            current["tags"].add(tag)
        current["events"] += 1

    report = []
    for case_id in sorted(state):
        current = state[case_id]
        report.append(
            "|".join(
                (
                    case_id,
                    current["owner"],
                    current["state"],
                    str(current["score"]),
                    str(current["events"]),
                    ",".join(sorted(current["tags"])),
                )
            )
        )
    input_bytes = ("\n".join(events) + "\n").encode("utf-8")
    output_bytes = ("\n".join(report) + "\n").encode("utf-8")
    self_check = sum(1 for line in input_bytes.splitlines() if line.startswith(b"OPEN\t"))
    assert self_check == case_count and len(input_bytes) <= 262144
    return {"/work/events.tsv": input_bytes}, {"/work/report.txt": output_bytes}


def stream_truth(events: list[str]) -> tuple[dict[str, bytes], dict[str, bytes]]:
    state = {}
    for line in events:
        fields = line.split("\t")
        operation, case_id = fields[:2]
        if operation == "OPEN":
            state[case_id] = {"owner": fields[2], "score": int(fields[3]), "state": "OPEN", "events": 1, "tags": set()}
            continue
        current = state[case_id]
        current["events"] += 1
        if operation == "ADD":
            current["score"] += int(fields[2])
        elif operation == "OWNER":
            current["owner"] = fields[2]
        elif operation == "TAG":
            current["tags"].add(fields[2])
        elif operation == "CLOSE":
            current["state"] = "CLOSED"
        elif operation == "REOPEN":
            current["state"] = "OPEN"
    report = [
        "|".join((case_id, current["owner"], current["state"], str(current["score"]), str(current["events"]), ",".join(sorted(current["tags"]))))
        for case_id, current in sorted(state.items())
    ]
    input_bytes = ("\n".join(events) + "\n").encode("utf-8")
    assert 1 <= len(events) <= 4096 and len(input_bytes) <= 262144
    return {"/work/events.tsv": input_bytes}, {"/work/report.txt": ("\n".join(report) + "\n").encode("utf-8")}


def build_schema_boundary_stream() -> tuple[dict[str, bytes], dict[str, bytes]]:
    return stream_truth([
        "OPEN\tA\ta\t-2147483648",
        "ADD\tA\t2147483647",
        "ADD\tA\t0",
        "TAG\tA\t~",
        "TAG\tA\t!",
        "TAG\tA\tA",
        "TAG\tA\ta",
        "TAG\tA\tA",
        "OPEN\tZ_______________\tz_______________\t2147483647",
        "ADD\tZ_______________\t-2147483648",
        "TAG\tZ_______________\t" + "~" * 40,
    ])


def build_open_case_max_stream() -> tuple[dict[str, bytes], dict[str, bytes]]:
    return stream_truth([f"OPEN\tC{index:04d}\towner\t0" for index in range(4096)])


def build_byte_near_max_stream() -> tuple[dict[str, bytes], dict[str, bytes]]:
    case_id = "Z_______________"
    tag = "~" * 40
    return stream_truth([f"OPEN\t{case_id}\tz_______________\t0"] + [f"TAG\t{case_id}\t{tag}"] * 4095)


def build_reachable_extreme_stream(value: int) -> tuple[dict[str, bytes], dict[str, bytes]]:
    return stream_truth([f"OPEN\tX\tx\t{value}"] + [f"ADD\tX\t{value}"] * 4095)


class TaskTests(unittest.TestCase):
    def assert_inputs(self, inputs: dict[str, bytes], expected: dict[str, bytes]) -> None:
        source_before = CANDIDATE.read_bytes()
        result = run_isolated(
            CANDIDATE,
            ["/work/events.tsv", "/work/report.txt"],
            input_files=inputs,
            collect_paths=("/work/events.tsv", "/work/report.txt", "/work"),
            candidate_path="/app/rollup.py",
        )
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"")
        self.assertEqual(result.files.get("/work/report.txt"), expected["/work/report.txt"])
        self.assertEqual(result.files.get("/work/events.tsv"), inputs["/work/events.tsv"])
        self.assertEqual(set(result.files), {"/work/events.tsv", "/work/report.txt"})
        self.assertEqual(result.entries, {"/work": "directory", "/work/events.tsv": "regular", "/work/report.txt": "regular"})
        self.assertEqual(CANDIDATE.read_bytes(), source_before)

    def assert_stream(self, seed: int, cases: int, events: int) -> None:
        inputs, expected = build_stream(seed, cases, events)
        self.assert_inputs(inputs, expected)

    def test_01_generated_families(self) -> None:
        for seed, cases, events in ((23011, 4, 31), (23012, 13, 127), (23013, 29, 401)):
            with self.subTest(seed=seed):
                self.assert_stream(seed, cases, events)

    def test_02_minimum_and_maximum_boundaries(self) -> None:
        self.assert_stream(23020, 1, 1)
        self.assert_stream(23021, 64, 4096)

    def test_03_repeat_independence(self) -> None:
        self.assert_stream(23031, 8, 73)
        self.assert_stream(23032, 3, 22)

    def test_04_schema_and_sort_boundaries(self) -> None:
        self.assert_inputs(*build_schema_boundary_stream())

    def test_05_maximum_open_cases(self) -> None:
        self.assert_inputs(*build_open_case_max_stream())

    def test_06_near_maximum_bytes(self) -> None:
        inputs, expected = build_byte_near_max_stream()
        self.assertGreater(len(inputs["/work/events.tsv"]), 250000)
        self.assert_inputs(inputs, expected)

    def test_07_reachable_signed_extremes(self) -> None:
        for value in (-2147483648, 2147483647):
            with self.subTest(value=value):
                self.assert_inputs(*build_reachable_extreme_stream(value))

    def test_08_runner_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            probe = Path(temporary) / "probe.py"
            probe.write_text("import os\ntry:\n os.system('true')\nexcept PermissionError:\n print('blocked')\n", encoding="utf-8")
            result = run_isolated(probe, [])
            self.assertEqual((result.returncode, result.stdout, result.stderr), (0, b"blocked\n", b""))


if __name__ == "__main__":
    unittest.main()
