Implement the executable `/app/transform_grid.py` with this interface:

```text
python3 /app/transform_grid.py CASE.json OUTPUT.json
```

`CASE.json` is a UTF-8 JSON object with
exactly `version`, `train`, and `query`, where `version` is `1`. `train` is a
list of 2 through 6 objects with exactly `input` and `output`; `query` is one
grid. A grid is a rectangular nonempty list of 1 through 12 rows and 1 through
12 columns containing non-boolean integers from 0 through 9. Each training
output has the same shape as its input.

There is at least one fitting periodic model. A model has a period `p` from 1
through 6, an offset from 0 through `p-1`, and `p` colors from 1 through 9. It
leaves every nonzero input cell unchanged and replaces a zero at row `r`,
column `c` with `colors[(r+c+offset) % p]`. Choose the lexicographically least
tuple `(p, offset, colors)` among all models fitting every training pair, then
apply it to the query.

Write only the transformed grid as compact UTF-8 JSON followed by one LF.
Reject malformed JSON, duplicate or unknown keys, invalid grids, non-fitting
training data, wrong argument counts, or direct/symbolic input-output aliases.
On failure exit nonzero, preserve the input bytes, and remove a stale distinct
regular output. The task is offline.
