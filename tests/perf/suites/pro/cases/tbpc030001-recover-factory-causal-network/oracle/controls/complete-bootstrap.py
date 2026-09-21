#!/usr/bin/env python3
import csv
import json
import random
import sys
from pathlib import Path

observations, spec_path, output = map(Path, sys.argv[1:])
spec = json.loads(spec_path.read_text(encoding="utf-8"))
order = [name for tier in spec["tiers"] for name in sorted(tier)]
with observations.open(newline="", encoding="utf-8") as handle:
    rows = list(csv.DictReader(handle))
output.mkdir(parents=True, exist_ok=True)
roots = set(spec["root_variables"])
with (output / "edges.csv").open("w", newline="", encoding="utf-8") as handle:
    writer = csv.writer(handle)
    writer.writerow(["source", "target"])
    for position, target in enumerate(order):
        if target not in roots:
            for source in order[:position]:
                writer.writerow([source, target])
rng = random.Random(spec["intervention"]["seed"])
assigned = spec["intervention"]["values"]
with (output / "samples.csv").open("w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=spec["variables"])
    writer.writeheader()
    for _ in range(spec["intervention"]["sample_count"]):
        source = rows[rng.randrange(len(rows))]
        writer.writerow({name: assigned.get(name, source[name]) for name in spec["variables"]})
