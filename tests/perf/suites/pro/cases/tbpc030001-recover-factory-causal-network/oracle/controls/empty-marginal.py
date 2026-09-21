#!/usr/bin/env python3
import csv
import json
import sys
from pathlib import Path

observations, spec_path, output = map(Path, sys.argv[1:])
spec = json.loads(spec_path.read_text(encoding="utf-8"))
with observations.open(newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))
means = {
    name: sum(float(row[name]) for row in rows) / len(rows)
    for name in spec["variables"]
}
output.mkdir(parents=True, exist_ok=True)
(output / "edges.csv").write_text("source,target\n", encoding="utf-8")
assigned = spec["intervention"]["values"]
with (output / "samples.csv").open("w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=spec["variables"])
    writer.writeheader()
    row = {name: assigned.get(name, means[name]) for name in spec["variables"]}
    for _ in range(spec["intervention"]["sample_count"]):
        writer.writerow(row)
