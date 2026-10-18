Create `/app/modes.py` defining this function:

```python
dominant_modes(matrices)
```

`matrices` is a C-contiguous NumPy `complex128` array with shape `(batch, n,
n)`, where `1 <= batch <= 256` and `3 <= n <= 16`. Every entry is finite.
Each matrix is diagonalizable, its eigenvector-basis condition number is at
most 1500, and it has exactly one eigenvalue of largest modulus. The ratio of
that modulus to the second-largest modulus is at least 1.15. Every eigenvalue
has modulus between `0.05` and `2`, inclusive, and every matrix has 2-norm at
most `3000`.

Return C-contiguous `complex128` arrays `(values, vectors)` with shapes
`(batch,)` and `(batch, n)`. For each matrix `A`, return its unique
largest-modulus eigenvalue and a unit Euclidean-norm eigenvector `v`; phase is
unrestricted. Outputs must be finite. The input's shape, dtype, strides, and
bytes must remain unchanged.

Against the independently computed target, relative eigenvalue error is at
most `1e-8`, and

```text
norm(A @ v - value * v) / (norm(A, 2) * norm(v, 2))
```

is at most `1e-10`. Euclidean normalization error is at most `1e-10`.
Repeated calls must satisfy the same contract; phase need not repeat.

The candidate uses one OS task and one numerical-library thread.
`/app/public/benchmark.py` normatively defines the profiles, fresh inputs,
warmups, seven repetitions, interleaving, timed interval, and sum-of-medians
score. Candidate score must be at most `0.85` of reference; every timed result
must satisfy the numerical contract. Network access is unavailable. Preserve
all read-only files under `/app/public`.
