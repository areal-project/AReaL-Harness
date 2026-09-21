Create a regular x86-64 ELF shared object `/app/factor_kernel.so` that exports:

```c
int factor_risk(size_t assets, size_t factors,
                const double *weights, const double *expected_returns,
                const double *exposures, const double *factor_covariance,
                const double *specific_variance,
                double *portfolio_return, double *portfolio_variance,
                double *variance_gradient);
```

For every call, `1 <= assets <= 256` and `1 <= factors <= 32`; arrays are
valid, disjoint, finite, and contiguous. `weights`, `expected_returns`, and
`specific_variance` have `assets` elements; specific variances are
nonnegative. `exposures` is an assets-by-factors row-major matrix.
`factor_covariance` is a factors-by-factors row-major symmetric
positive-semidefinite matrix.

Let `x = exposures^T * weights`. Return zero. Set the return to
`weights^T * expected_returns`; variance to `x^T * factor_covariance * x +
sum_i specific_variance[i]*weights[i]^2`; and gradient to twice
`exposures * factor_covariance * x + specific_variance * weights`. Preserve
all input bytes. Each result must be finite and within `3e-12` relative or
absolute error of the real-valued formula. The evaluator supplies the caller.
The task is offline.
