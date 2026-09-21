"""Independent hidden linear-Gaussian SEM fixtures for verifier use."""

from __future__ import annotations

import csv
import hashlib
import json
import random
from pathlib import Path


NAME_SETS = (
    ("ambient", "feed", "heater", "mixer", "pressure", "yield"),
    ("batch", "coolant", "density", "energy", "flow", "grade"),
)
TOPOLOGIES = (
    ((), (0,), (0, 1), (1, 2), (0, 2, 3), (1, 3, 4)),
    ((), (0,), (0,), (0, 1, 2), (1, 3), (0, 2, 4)),
)


def _moments(order, model, assigned):
    means = {}
    weights = {}
    variances = {}
    for name in order:
        if name in assigned:
            means[name] = assigned[name]
            weights[name] = {}
        else:
            node = model[name]
            means[name] = node["intercept"] + sum(
                coefficient * means[parent]
                for parent, coefficient in node["parents"].items()
            )
            node_weights = {name: 1.0}
            for parent, coefficient in node["parents"].items():
                for source, weight in weights[parent].items():
                    node_weights[source] = node_weights.get(source, 0.0) + coefficient * weight
            weights[name] = node_weights
        variances[name] = sum(
            weight * weight * model[source]["noise_sd"] ** 2
            for source, weight in weights[name].items()
        )
    return means, variances


def _solve(matrix, vector):
    size = len(vector)
    augmented = [list(matrix[row]) + [vector[row]] for row in range(size)]
    for column in range(size):
        pivot = max(range(column, size), key=lambda row: abs(augmented[row][column]))
        if abs(augmented[pivot][column]) < 1e-12:
            raise ValueError("singular hidden regression fixture")
        augmented[column], augmented[pivot] = augmented[pivot], augmented[column]
        scale = augmented[column][column]
        for item in range(column, size + 1):
            augmented[column][item] /= scale
        for row in range(size):
            if row == column:
                continue
            factor = augmented[row][column]
            for item in range(column, size + 1):
                augmented[row][item] -= factor * augmented[column][item]
    return [augmented[row][size] for row in range(size)]


def _regression(rows, target, predictors):
    width = len(predictors) + 1
    gram = [[0.0] * width for _ in range(width)]
    rhs = [0.0] * width
    for row in rows:
        values = [1.0] + [row[name] for name in predictors]
        for left in range(width):
            rhs[left] += values[left] * row[target]
            for right in range(width):
                gram[left][right] += values[left] * values[right]
    beta = _solve(gram, rhs)
    residuals = [
        row[target] - beta[0]
        - sum(beta[index + 1] * row[name] for index, name in enumerate(predictors))
        for row in rows
    ]
    variance = sum(value * value for value in residuals) / (len(rows) - width)
    return beta[0], dict(zip(predictors, beta[1:])), variance


def _fit_from_observations(observations, spec):
    order = [name for tier in spec["tiers"] for name in sorted(tier)]
    with observations.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = [{name: float(row[name]) for name in order} for row in reader]
    fitted = {}
    roots = set(spec["root_variables"])
    for position, target in enumerate(order):
        candidates = [] if target in roots else order[:position]
        _, provisional, _ = _regression(rows, target, candidates)
        retained = [
            name for name in candidates
            if abs(provisional[name]) >= spec["edge_threshold"]
        ]
        intercept, coefficients, variance = _regression(rows, target, retained)
        fitted[target] = {
            "intercept": intercept,
            "parents": coefficients,
            "noise_sd": variance ** 0.5,
        }
    return fitted


def make_case(directory: Path, seed: int) -> dict:
    rng = random.Random(seed)
    tiers = [sorted(pair) for pair in (NAME_SETS[seed % 2][0:2], NAME_SETS[seed % 2][2:4], NAME_SETS[seed % 2][4:6])]
    order = [name for tier in tiers for name in tier]
    parent_positions = TOPOLOGIES[seed % 2]
    model = {}
    edge_counter = 0
    for position, name in enumerate(order):
        parents = {}
        for parent_position in parent_positions[position]:
            magnitude = 0.57 + 0.06 * ((edge_counter + seed) % 5)
            sign = -1.0 if (edge_counter + seed) % 3 == 0 else 1.0
            parents[order[parent_position]] = sign * magnitude
            edge_counter += 1
        model[name] = {
            "intercept": rng.uniform(-0.35, 0.35),
            "parents": parents,
            "noise_sd": rng.uniform(0.72, 1.02),
        }

    directory.mkdir(parents=True, exist_ok=True)
    observations = directory / "observations.csv"
    with observations.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=order)
        writer.writeheader()
        for _ in range(8000):
            row = {}
            for name in order:
                node = model[name]
                row[name] = (
                    node["intercept"]
                    + sum(coefficient * row[parent] for parent, coefficient in node["parents"].items())
                    + rng.gauss(0.0, node["noise_sd"])
                )
            writer.writerow({name: format(row[name], ".12g") for name in order})

    assigned = {order[2]: -0.85 if seed % 2 else 1.3}
    spec = {
        "variables": order,
        "tiers": tiers,
        "within_tier_order": "lexicographic",
        "root_variables": [order[0]],
        "edge_threshold": 0.3,
        "intervention": {"values": assigned, "sample_count": 4200, "seed": seed + 9000},
    }
    spec_path = directory / "spec.json"
    spec_path.write_text(json.dumps(spec, sort_keys=True) + "\n", encoding="utf-8")
    # Acceptance truth is the estimator declared by the task, not the latent
    # SEM parameters used only to synthesize observations.
    fitted = _fit_from_observations(observations, spec)
    means, variances = _moments(order, fitted, assigned)
    edges = {(parent, target) for target, node in fitted.items() for parent in node["parents"]}
    return {
        "observations": observations,
        "spec_path": spec_path,
        "spec": spec,
        "edges": edges,
        "means": means,
        "variances": variances,
        "input_hashes": {
            observations: hashlib.sha256(observations.read_bytes()).hexdigest(),
            spec_path: hashlib.sha256(spec_path.read_bytes()).hexdigest(),
        },
    }
