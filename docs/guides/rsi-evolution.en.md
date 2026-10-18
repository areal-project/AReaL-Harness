[中文](rsi-evolution.md) | **English**

# RSI Goal: feedback branches and version trees

Use `/rsi-goal --html QUERY` for a standalone HTML artifact. Without `--html`, Markdown remains the default. The initial baseline, structured, and critic-and-revise versions use independent native Runtimes and write scopes. Artifacts are capped at 1 MiB and are never automatically applied to the project.

## Feedback loop

1. Wait for settlement, then read an artifact and inspect its Harness in the GUI.
2. Open the feedback and branching form, write feedback, and record the evaluation. GUI qualitative feedback uses `human-feedback-v1`; external browsers can submit a fixed rubric with checks and evidence references through the API.
3. Change the complete Harness, state a hypothesis, and branch. Each child reruns from the original frozen input. It does not inherit the parent's artifact.
4. Inspect the version tree, receipts, and failed branches, then explicitly select a winner. The previous winner remains incumbent during exploration; selection can retain or replace it.

All rounds reuse the initial model configuration and workspace snapshot, with cumulative token and active-time budgets. Each branch creates 1–3 versions, up to 12 versions and lineage depth 3. There is no unbounded automatic loop. Exhausted budgets or incomplete accounting reject further exploration. Model/tool changes and other tasks require a new goal.

Native candidates and worker sessions both consume the initial `EffectiveConfig`, including the provider endpoint/protocol snapshot, thread sampling and reasoning overrides, Profile, and client options. Later rounds do not resolve defaults again from the current catalog. Core passes this snapshot through an internal trusted channel; it is not an agent-editable task field. Isolated workers still force headless mode, clear interactive preapprovals, and inherit current deployment approval/deny boundaries. Credentials remain references and missing credentials fail execution. Skill references pin versions, but resource bodies follow the current-directory read semantics in the Skill guide; this does not freeze external resource contents.

Nodes retain parentCandidateId, round, full harness, hypothesis, feedback, and evaluations. Core snapshots are authoritative. The `rsi/<goalId>/input.json` and `configuration.json` files retain frozen material; candidate requests include inputDigest. Restart restores completed trees and never redispatches interrupted candidates. Legacy snapshots remain readable; legacy goals without frozen material cannot branch.

## Clients and API

The GUI supports reading, qualitative evaluations, single-child branches, trees, and selection. The TUI accepts `/rsi-evaluate JSON_FILE` and `/rsi-evolve JSON_FILE`; files contain business fields only, while the current goal supplies thread, goal, requestId, and revision. Use the API for batch branches and external evaluations. See [Core API](../api/core.en.md).

`areal/goal/evaluateCandidate` accepts candidateId and evaluation. An evaluation contains rubricId, evaluator, taskId, artifactSha256, boolean checks, nullable score (0–100), feedback, and evidence string references. Core checks the hash against the native artifact. Scores and references are caller-supplied; Core does not verify external evidence contents or treat scores as trusted Runtime verification.

`areal/goal/evolve` accepts parentCandidateId, feedback, and variants. Each variant contains label, hypothesis, and complete harness. Harnesses must change; the parent must have a completed artifact and recorded evaluation. Both mutations accept requestId, threadId, goalId, and expectedRevision, with durable deduplication and optimistic concurrency. Reuse the original request for unknown outcomes; do not automatically replace a stale revision.

## Real webpage validation

After building and explicitly configuring a real model:

```bash
node scripts/rsi-web-live.mjs /absolute/model.toml /absolute/evidence
node scripts/rsi-web-live.mjs /absolute/model.toml /absolute/evidence /absolute/plan.json
```

The script reads credentials through environment references and incurs real model usage. It uses isolated state, workspace, and user home with real Core/native Runtime execution. Playwright Chromium checks desktop/mobile overflow, filtering, saves, booking, Escape focus, persisted theme, script errors, and offline assets. Outputs include screenshots, receipts, artifacts, tree projections, and the binary hash. Example plan.json:

```json
{"parentCandidateId":"candidate-3","feedback":"browser feedback","variants":[{"label":"responsive-v1","hypothesis":"fluid widths prevent overflow","harness":"Build semantic HTML with fluid layout; inspect mobile width and keyboard focus before delivery."}]}
```

The `.private/` directory contains authentication state and private logs and must not be published. Public evidence consists only of HTML, screenshots, rubric.json, *-browser.json, run.json, exploration.json, and binary.json. Functional pass rates do not measure aesthetics or establish cross-task Harness generalization. Independent held-out tasks and repeated samples are needed for that claim.

Failed nodes can branch from their Core execution error plus explicit feedback, without fabricating artifact evaluations. `areal/goal/evolve` optionally accepts tokenBudget to explicitly extend the cumulative cap; the new limit must exceed the previous cap and never resets consumed usage. The GUI exposes this field too. Unknown accounting still blocks further execution.

The webpage demo driver runs the browser rubric outside Core and explicitly calls selection based on functional pass rates. This is not a built-in Core scoring or winner policy. `scripts/rsi-exploration-report.mjs OUTPUT` exports the public Core projection as an offline interactive version tree.
