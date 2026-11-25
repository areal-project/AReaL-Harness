[中文](connection-recovery-report-comparison.md) | **English**

# Connection recovery reports: fixed-sample triage comparison

2026-11-22. The existing summary reduced evidence retrieval and assembly, but increased returned text volume. Reduced human intervention or human decision time remains unproven. Keep the pilot on this single journey. A compact decision summary using the same facts and evidence links is the next candidate; this experiment did not modify the report generator.

## Samples and method

Reuse exactly three completed results from `areal-connection-pilot-20261121-08`: the correct implementation, premature loading failure mutation, and stale hibernation guard mutation. No product rerun, additional mutation, or sample replacement occurred. Two independent agents with fresh context started from either raw evidence or the existing full `imported-journey.json`. Both could retrieve identical raw JSON artifacts and runner logs. Case directories were anonymized and read in reverse orders. Screenshots were excluded from both arms; this is text-evidence triage, not visual acceptance.

Freeze the answer key before evaluation and verify the existing artifact SHA-256 values. A shared reader records actual file reads, returned bytes, and timestamps. Preserve first answers without feedback or retries. Seven fields cover journey status, first failure, unreached facts, cleanup, trigger verification, full CI, and the next action. Reviewers had the same available tools and inherited model configuration. One reviewer per arm does not control individual reviewer variation.

## Observed results

| Metric | Raw evidence | Summary report |
| --- | ---: | ---: |
| Correct case decisions | 3/3 | 3/3 |
| Correct business decision fields (six per case) | 18/18 | 18/18 |
| Unsupported claims of full CI passing | 0 | 0 |
| Distinct files read | 22 | 14 |
| Raw artifact reads beyond initial entry and shared context | 16 | 8 |
| All file reads, including repeats | 24 | 14 |
| Returned evidence text bytes | 14,272 | 27,064 |
| Read calls | 7 | 6 |
| Agent first-read-to-submit seconds | 164.251 | 105.795 |
| Cases where the agent requested human judgment | 0 | 0 |
| Answer corrections or retries | 0 | 0 |

The summary arm read eight fewer distinct files and half as many follow-up artifacts. However, identity metadata, artifact digests, and repeated observations made its returned text approximately 1.90 times larger. Returned bytes are not cognitive effort. Agent wall time includes scheduling, tools, and ordering effects; it cannot establish human time savings. Zero escalations in both arms does not establish reduced intervention.

## Preserved protocol and scoring issues

Before either first answer, both arms received one common clarification listing the six `requiredFacts`, so the raw arm would not have to guess the acceptance plan. The raw reader had already started, resulting in two additional context reads. All measurements remain intact. Distinct-file and follow-up-artifact counts exclude these duplicate effects; elapsed time and returned bytes have not been adjusted afterward.

The unchanged mechanical score is **18/21 in both arms**. The frozen key used `false` for `fullCiPassed`, but neither packet supplied the full CI envelope. Both readers returned `null` and explicitly said the evidence was insufficient. The protocol already allowed null for missing evidence, making these six differences valid uncertainty rather than false acceptance. The report preserves exact-match scores and separately records the adjudicated business and scope judgments. Neither the answer key nor first answers were rewritten. The parent clarified this scoring issue once and corrected no business decisions.

## Decision and limits

- Supported benefit: the same evidence is easier to assemble, with fewer files to retrieve.
- Unsupported benefits: reduced human intervention, reduced human time, or improved unknown-defect detection. `humanMinutes=null`; `canConfirmHumanTimeReduction=false`.
- Do not expand journey coverage. If improving the report next, shorten its decision summary while preserving correctness on these same three cases. More tests are not a substitute for cost measurement.
- This is one two-agent comparison, without paired human timing or statistical significance. The raw arm retained the runner's structured first failure; it was not artificially reduced to unstructured logs.

The [structured result](connection-recovery-report-comparison.json) retains the protocol, first answers, actual access logs, source digests, strict scoring, and adjudication. All 30 source-evidence citation occurrences matched retained source files. The local replay bundle is `target/connection-report-comparison-20261122/`; `python3 target/connection-report-comparison-20261122/score.py` recomputes the original strict score. This temporary bundle is not committed. Product acceptance still rests on the original three executed samples; this comparison adds no product acceptance claim.
