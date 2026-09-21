"""Behavioral checks for causal network recovery and intervention sampling."""

from __future__ import annotations

import csv
import hashlib
import math
import subprocess
import tempfile
import unittest
from pathlib import Path

from hidden_sem import make_case


PROGRAM = Path("/app/solve_network.py")


def run_case(seed: int):
    temporary = tempfile.TemporaryDirectory(prefix="causal-hidden-")
    root = Path(temporary.name)
    case = make_case(root / "input", seed)
    output = root / "output"
    subprocess.run(
        ["python3", str(PROGRAM), str(case["observations"]), str(case["spec_path"]), str(output)],
        check=True,
        timeout=45,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    for path, expected_hash in case["input_hashes"].items():
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise AssertionError(f"input was modified: {path.name}")
    return temporary, case, output


class TaskTests(unittest.TestCase):
    def assert_program(self) -> None:
        self.assertTrue(PROGRAM.is_file(), "required CLI is missing")

    def test_exact_structure_on_independent_networks(self) -> None:
        self.assert_program()
        for seed in (271, 814):
            temporary, case, output = run_case(seed)
            self.addCleanup(temporary.cleanup)
            with (output / "edges.csv").open(newline="", encoding="utf-8") as handle:
                reader = csv.DictReader(handle)
                self.assertEqual(reader.fieldnames, ["source", "target"])
                rows = list(reader)
            self.assertEqual(set(path.name for path in output.iterdir()), {"edges.csv", "samples.csv"})
            self.assertTrue(all(set(row) == {"source", "target"} and None not in row for row in rows))
            actual = [(row["source"], row["target"]) for row in rows]
            self.assertEqual(len(actual), len(set(actual)), "duplicate edge rows are forbidden")
            self.assertEqual(set(actual), case["edges"])
            order = case["spec"]["variables"]
            self.assertEqual(actual, sorted(actual, key=lambda edge: (order.index(edge[1]), order.index(edge[0]))))

    def test_true_intervention_distribution(self) -> None:
        self.assert_program()
        for seed in (271, 814):
            temporary, case, output = run_case(seed)
            self.addCleanup(temporary.cleanup)
            with (output / "samples.csv").open(newline="", encoding="utf-8") as handle:
                reader = csv.DictReader(handle)
                self.assertEqual(reader.fieldnames, case["spec"]["variables"])
                raw_rows = list(reader)
                self.assertTrue(all(set(row) == set(reader.fieldnames) and None not in row for row in raw_rows))
                rows = [{name: float(row[name]) for name in reader.fieldnames} for row in raw_rows]
            self.assertEqual(len(rows), case["spec"]["intervention"]["sample_count"])
            self.assertTrue(all(math.isfinite(value) for row in rows for value in row.values()))
            for name, assigned in case["spec"]["intervention"]["values"].items():
                self.assertTrue(all(value[name] == float(assigned) for value in rows))
            for name in case["spec"]["variables"]:
                observed_mean = sum(row[name] for row in rows) / len(rows)
                observed_variance = sum((row[name] - observed_mean) ** 2 for row in rows) / (len(rows) - 1)
                self.assertTrue(math.isclose(observed_mean, case["means"][name], abs_tol=0.16), name)
                self.assertTrue(
                    math.isclose(observed_variance, case["variances"][name], rel_tol=0.20, abs_tol=0.12),
                    name,
                )

    def test_seed_is_byte_deterministic(self) -> None:
        self.assert_program()
        temporary, case, output = run_case(392)
        self.addCleanup(temporary.cleanup)
        first = {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in ("edges.csv", "samples.csv")}
        subprocess.run(
            ["python3", str(PROGRAM), str(case["observations"]), str(case["spec_path"]), str(output)],
            check=True,
            timeout=45,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        second = {name: hashlib.sha256((output / name).read_bytes()).hexdigest() for name in first}
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
