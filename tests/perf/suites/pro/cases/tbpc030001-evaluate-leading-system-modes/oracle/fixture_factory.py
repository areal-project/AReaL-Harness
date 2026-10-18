"""Evaluator-owned deterministic fixtures for leading complex modes."""

from __future__ import annotations

import numpy as np


def unitary(rng: np.random.Generator, n: int) -> np.ndarray:
    raw = rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))
    q, r = np.linalg.qr(raw)
    diagonal = np.diag(r)
    phases = np.where(np.abs(diagonal) == 0, 1, diagonal / np.abs(diagonal))
    return q * phases


def make_family(seed: int, batch: int, n: int, condition: float, boundary_gap: bool = False):
    rng = np.random.default_rng(seed)
    matrices = []
    truth = []
    singulars = np.geomspace(1.0, condition, n)
    for item in range(batch):
        left = unitary(rng, n)
        right = unitary(rng, n)
        basis = left @ np.diag(singulars) @ right.conj().T
        radii = rng.uniform(0.08, 0.72, n)
        if boundary_gap:
            radii[(item + 1) % n] = 1.0
            leading_modulus = 1.15
        else:
            leading_modulus = 1.18 + 0.04 * (item % 4)
        angles = rng.uniform(-np.pi, np.pi, n)
        eigenvalues = radii * np.exp(1j * angles)
        leading = leading_modulus * np.exp(1j * rng.uniform(-2.8, 2.8))
        eigenvalues[item % n] = leading
        matrix = basis @ np.diag(eigenvalues) @ np.linalg.inv(basis)
        matrices.append(matrix)
        truth.append(leading)
    return (
        np.ascontiguousarray(matrices, dtype=np.complex128),
        np.ascontiguousarray(truth, dtype=np.complex128),
    )


def make_extreme_family(seed: int):
    """Exercise the published eigenvalue and conditioning endpoints together."""
    rng = np.random.default_rng(seed)
    n = 16
    singulars = np.geomspace(1.0, 1500.0, n)
    matrices = []
    truth = []
    for item in range(2):
        left = unitary(rng, n)
        right = unitary(rng, n)
        basis = left @ np.diag(singulars) @ right.conj().T
        radii = np.geomspace(0.05, 2.0 / 1.15, n)
        angles = rng.uniform(-np.pi, np.pi, n)
        eigenvalues = radii * np.exp(1j * angles)
        leading = 2.0 * np.exp(1j * (0.4 + item))
        eigenvalues[item] = leading
        matrix = basis @ np.diag(eigenvalues) @ np.linalg.inv(basis)
        if np.linalg.norm(matrix, 2) > 3000.0 * (1 + 1e-12):
            raise AssertionError("generated matrix exceeds the public norm bound")
        matrices.append(matrix)
        truth.append(leading)
    return (
        np.ascontiguousarray(matrices, dtype=np.complex128),
        np.ascontiguousarray(truth, dtype=np.complex128),
    )
