"""Deterministic public benchmark inputs for leading complex modes."""

import numpy as np


def _unitary(rng, n):
    raw = rng.normal(size=(n, n)) + 1j * rng.normal(size=(n, n))
    q, r = np.linalg.qr(raw)
    diagonal = np.diag(r)
    phases = np.where(np.abs(diagonal) == 0, 1, diagonal / np.abs(diagonal))
    return q * phases


def make_family(seed, batch, n, condition):
    rng = np.random.default_rng(seed)
    matrices = []
    singulars = np.geomspace(1.0, condition, n)
    for item in range(batch):
        left = _unitary(rng, n)
        right = _unitary(rng, n)
        basis = left @ np.diag(singulars) @ right.conj().T
        radii = rng.uniform(0.08, 0.72, n)
        angles = rng.uniform(-np.pi, np.pi, n)
        eigenvalues = radii * np.exp(1j * angles)
        eigenvalues[item % n] = (1.18 + 0.04 * (item % 4)) * np.exp(1j * rng.uniform(-2.8, 2.8))
        matrices.append(basis @ np.diag(eigenvalues) @ np.linalg.inv(basis))
    return np.ascontiguousarray(matrices, dtype=np.complex128)
