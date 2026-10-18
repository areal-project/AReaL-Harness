[中文](tool-optimization.md) | **English**

# Native tool optimization A/B

Frozen revision `acfdb2e` is compared with pre-change `85f4a27` using the same currently configured `grok-4.7` model. Both versions completed all 12 final pairs normally and passed independent checks. Aggregate input tokens changed by -38.9%, tool calls by -46.3%, and mean elapsed time by -27.9%. This measures output and editing efficiency; it does not demonstrate higher MM480 accuracy.

The [redacted evidence for 56 attempts](tool-optimization-evidence.json) retains every plan, result, usage record and binary digest from exploration, revision and final rounds. Full model traces and private routing are not published. These summaries support aggregation checks, not complete public trace reproduction. This compares two Harness versions; it is not a new end-to-end measurement of Codex, Claude Code or RTK.

## Design and grading

Four cases were fixed before exploration based on the mechanisms under test, with no later case exclusions. `pricing` reuses the repository lite repair task; the others are constructed diagnostic/editing workloads. `output-tail` has 120 long pytest passing-progress lines followed by a failure; `failure-context` includes a multiline nested-value diff; `batch-edit` needs changes to 12 functions with repeated literals. The real model uses the production launcher, Core and Runtime to solve them and run real tests. There is no alternative agent loop or fabricated tool output.

The final round has three repetitions per case and version, paired by case/repetition and randomly interleaved with seed 163 and two concurrent host trials. Environment: macOS 26.3.2 arm64, Python 3.14.2, pytest 8.4.2, debug builds. Both variants use isolated workspaces and private HOME directories without global user skills. Limits are 180 seconds per Turn, 60 seconds stream idle and 80 tool calls. The current model, route and sampling settings are preserved, with identical recorded request parameters throughout; no temperature or reasoning-budget override is applied. Builds and other regression runs finished before final measurement.

After each agent exits, a host grader runs additional assertions and checks that supplied tests were not changed. Correctness and normal completion are recorded separately. All 24 final attempts have complete request usage; none failed, timed out, had invalid grading or were discarded. Elapsed time spans launcher startup through exit/cleanup and excludes builds, fixture setup and grading. Summed trial times are not the wall time of the two-slot batch. Input includes cached input, which is not added twice. Token counts are not billing costs.

Connectivity preflight identified an incompatible host SOCKS proxy for the current HTTP client build. `--direct` removed proxy variables only from test subprocesses; global settings and model provisioning were unchanged. Preflight checks are outside the task attempts above.

## Final 12 pairs

| Metric | Baseline | Final | Change |
|---|---:|---:|---:|
| Input tokens (including cache) | 1,245,302 | 761,023 | -38.9% |
| Cached input subset | 927,616 | 449,024 | -51.6% |
| Uncached input | 317,686 | 311,999 | -1.8% |
| Output tokens | 8,208 | 6,872 | -16.3% |
| Model requests | 115 | 77 | -33.0% |
| Tool calls | 162 | 87 | -46.3% |
| Tool result bytes | 204,953 | 156,284 | -23.7% |
| Mean seconds per attempt | 28.40 | 20.48 | -27.9% |

Input tokens and tool calls below are sums of three attempts per group; elapsed time is the per-attempt mean. Each cell shows baseline → final.

| Case | Input tokens | Tool calls | Mean seconds |
|---|---:|---:|---:|
| `pricing` | 133,381 → 128,440 | 19 → 18 | 13.54 → 12.44 |
| `failure-context` | 223,914 → 173,592 | 29 → 24 | 24.56 → 17.90 |
| `output-tail` | 678,287 → 302,552 | 56 → 25 | 45.77 → 28.13 |
| `batch-edit` | 209,720 → 156,439 | 58 → 20 | 29.74 → 23.45 |

Most input-token reduction is repeated cached context; uncached input falls only 1.8%, so a similar billing reduction is not established. Small tasks still incur fixed tool-description/schema overhead. In the two pricing pairs with equal request/tool counts, input is slightly higher in the final version; the aggregate does not establish a stable small-task speedup. Fewer tools do not guarantee proportionally fewer model requests or lower latency. Four targeted small tasks, three repeats and one model cannot establish general accuracy; caching, networking and model randomness still affect timing. Accuracy needs a separate real-suite evaluation. These are neither an MM480 rerun nor isolated ablation effects for each tool.

## Trace-driven changes

The initial `a138620` long-output attempt was correct, but input increased from baseline 214,028 to 459,684 tokens. Keyword filtering removed multiline failure context and duplicated the summary in `stdout` and `outputView.text`. The model repeatedly requested evidence and even switched to file readback. The final implementation folds only explicitly recognized passing-progress lines, preserves unknown lines, failure context and stream boundaries, compares complete serialized size including metadata, and provides explicit original-page replay through `view=raw`. `waitMs=0` also fills the retained safe page instead of unintentionally returning only 1 KiB per call.

All intermediate batch-edit attempts encountered generic match conflicts, with some falling back to individual edits. Final tool guidance requires surrounding function or other context for repeated text. Match failures identify the 1-based patch index, distinguish missing from ambiguous text, and explicitly state that the batch wrote nothing. CAS and no-partial-write semantics remain intact; independent regressions cover missing, ambiguous and stale-version failures.

The final revision also fixes the generic journal prefix/suffix budget after nested JSON escaping and completes TypeScript `applyPatches` types and the native host schema. Deterministic checks cover raw replay, cursors, complete diffs, stream boundaries, escaping budgets and atomic rollback. They validate contracts and do not substitute for model-effect measurements.

## Every planned attempt

The intermediate revision is `a138620` plus the source patch identified in the evidence JSON. The final revision is `acfdb2e`. Each round reruns the same `85f4a27` baseline for pairing; absolute times from different rounds are not directly compared.

| Round / variant | Attempts | Normal and correct | Input tokens | Tool calls | Summed seconds |
|---|---:|---:|---:|---:|---:|
| exploratory / baseline | 4 | 4 | 385,603 | 52 | 121.71 |
| exploratory / initial | 4 | 4 | 676,867 | 52 | 126.16 |
| paired / baseline | 12 | 12 | 1,245,623 | 164 | 297.66 |
| paired / tuned | 12 | 12 | 826,270 | 110 | 258.50 |
| final / baseline | 12 | 12 | 1,245,302 | 162 | 340.81 |
| final / final | 12 | 12 | 761,023 | 87 | 245.78 |

## Rerun and verify

Follow the [development guide](../../development/README.en.md) to build `85f4a27` and `acfdb2e` in separate checkouts and Cargo target directories. Each `*_BIN` directory contains that revision's `areal-server`, `areal-tui`, `areal-runtime`, `areal-runtime-fs`, and `scripts/launch.py` renamed to `launch.py`. Prepare Python 3.11+, pytest 8.4.2 and the credential environment variables required by the current Core model configuration:

```sh
python3 tests/perf/native_tool_ab.py \
  --variant "baseline=$BASELINE_BIN" --variant "final=$FINAL_BIN" \
  --model-config "$HOME/.areal-harness/config.toml" \
  --case pricing --case output-tail --case failure-context --case batch-edit \
  --output target/perf/native-tool-ab --repeat 3 --seed 163 --jobs 2 --direct
```

`--direct` optionally overrides proxies in subprocesses; `--pytest` selects the pytest executable. The runner writes `plan.json`, `results.json` and per-attempt logs/grades into a new directory. Review redaction before publication. Recompute final aggregates independently with:

```sh
python3 - <<'PYCODE'
import json
from pathlib import Path
p = Path("docs/benchmarks/reports/tool-optimization-evidence.json")
rows = json.loads(p.read_text())["rounds"][-1]["results"]
for variant in ("baseline", "final"):
    r = [x for x in rows if x["variant"] == variant]
    assert len(r) == 12 and all(x["usage_complete"] for x in r)
    print(variant, {
        "correct_and_completed": sum(x["grade"]["correct"] and x["completed"] for x in r),
        "input_tokens": sum(x["usage"]["inputTokens"] for x in r),
        "tool_calls": sum(x["tool_calls"] for x in r),
        "mean_seconds": round(sum(x["elapsed_s"] for x in r) / len(r), 2),
    })
PYCODE
```

See [methodology](../methodology.en.md) and the current [tool contract](../../guides/tools.en.md).
