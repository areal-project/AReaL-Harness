Complete `/app/solve_network.py` with this CLI:

```text
python3 /app/solve_network.py OBSERVATIONS.csv SPEC.json OUTPUT_DIR
```

The observations are UTF-8 CSV from an acyclic linear-Gaussian structural model.
The spec declares `variables`,
ordered `tiers`, `within_tier_order`, `root_variables`, `edge_threshold`, and an
`intervention` containing `values`, `sample_count`, and `seed`. Inputs are
read-only. Candidate causal directions follow tier order, then the declared
within-tier order; roots have no incoming edges.

For each non-root target, fit ordinary least squares with an intercept against
all preceding variables, retain predictors whose absolute fitted coefficient is
at least `edge_threshold`, then refit against only those predictors. A root uses
an intercept-only fit. Residual variance is SSE divided by the number of rows
minus the fitted parameter count, including the intercept.

Write `edges.csv` with header `source,target`, one inferred nonzero structural
edge per row, sorted by target then source in declared variable order. Write
`samples.csv` with the variables as its header in declared order and exactly
`sample_count` numeric rows. Samples must implement the declared `do`
intervention: assigned variables are constant, incoming mechanisms are severed,
and the fitted mechanisms and noise of other variables continue to propagate.
The seed must make repeated runs byte-identical.

Public inputs are under `/app/data`. The task is offline.
