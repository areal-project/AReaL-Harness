[中文](agent-improvement.md) | **English**

# Agent improvement goals and method

Benchmarks expose defects, test mechanisms and measure outcomes. The optimization target is reliable delivery across real task distributions. A failed task may become a regression case; a product change must explain which problem class it addresses and why it should transfer to unseen tasks.

This document governs development, prompts, tools, configuration defaults, evaluation adapters and PR reviews. Follow the [architecture](../design/architecture.en.md) for ownership and the [benchmark methodology](../benchmarks/methodology.en.md) for comparisons. Historical results do not promise current capabilities.

## Goals and comparison scope

With the same model, comparable resources, a fixed task distribution and trustworthy acceptance, improve AReaL-Harness delivery quality, time and delivery cost beyond official DeepSeek Harness (DSH), progressively approaching Codex. The long-term distribution assigns 25% each to software engineering, browsing, documents and data. Fix source-group and task weights within each domain before evaluation; adding variants of one mother task must not change domain weights.

| Dimension | Evidence |
|---|---|
| Quality and reliability | Satisfy public requirements, preserve unrelated state and deliver real artifacts; distinguish functional correctness, normal termination, valid grading and pending review |
| Efficiency | Time, requests and usage for all planned attempts, plus costs on mutually normal and correct pairs; include failures, summaries, retries, children, verification and repair |
| Generalization | Transfer to tasks excluded from tuning, independent sources and different domains; repeated same-source tasks do not add independent sources |
| Engineering constraints | Preserve permissions, isolation, cancellation, UNKNOWN, compatibility and accounting; expanded authority cannot buy a higher score |

Quality and constraints come first, followed by efficiency and resource tradeoffs. Before each experiment, fix the minimum improvement, allowed regression, sample, domain coverage, budgets and stopping rules. Without those rules or sufficient evidence, report measured gaps without claiming superiority or proximity. Report time, tokens and money separately; missing prices, usage or billing records prevent direct financial claims.

Keep two comparisons distinct: same-model evaluation isolates Harness differences; practical product evaluation can compare each product's model and tool combination. A particular Codex CLI through a shared protocol bridge represents that combination, not the entire native Codex product. Disclose differences in model identity, protocol, prompts, tools, reasoning settings and resources.

## Improvement dimensions

| Capability | Questions to investigate |
|---|---|
| Requirements and constraints | Do later corrections remain effective? Are scope and preservation clear? Are inferences mistaken for user requirements? |
| Planning and actions | Does the agent inspect real interfaces? Is decomposition needed? When does it change a failing approach? Are checks relevant? |
| Context and evidence | Are user requirements, references and current state distinguished? What is omitted, how is it recovered, and is recovery timely? |
| Tools and environment | Are schemas, paths, pagination, versions and stdin clear? Are results complete and partial effects preserved? |
| Recovery and budgets | Are transient errors, permanent denial, empty output, truncation and UNKNOWN distinct? Is recovery bounded and fully charged? |
| Delegation and scheduling | Are dependencies, shared writes, isolated delivery, parent ownership, waiting and cancellation correct? Does parallel work justify coordination cost? |
| Verification and completion | Do checks cover requirements and actual artifacts? Do receipts bind the current revision? Does the agent waste effort after completion or stop early? |
| Persistence and observability | Do restart and compaction preserve facts? Can model, tool, storage and environment losses be distinguished? |

Choose the layer from observed bottlenecks. Long model waits do not establish slow local execution; a failed task does not establish a need for more agents. More tools, instructions, parallelism, retries or budget all require a corresponding hypothesis.

## From failure to repair

1. **Freeze evidence and validity.** Preserve source and uncommitted changes, binaries, configuration, prompts, tools, model, environment, public inputs, graders and attempt identities. First exclude invalid tasks, grading errors, protocol problems and deployment drift. Keep hidden answers and grading assets outside the candidate environment.
2. **Reconstruct execution.** Align requirements, model requests, tool arguments/results, state changes, budgets and artifacts. Separate observed termination causes from inferred root causes. Inspect successful controls and counterexamples, not only the worst trace.
3. **State a falsifiable hypothesis.** Identify trigger, mechanism, contract, expected improvement and potentially harmed tasks. Explain what would refute it; prefer model-free replay or a minimal reproduction first.
4. **Repair the smallest sufficient mechanism.** Change the appropriate shared boundary while preserving Clients → Core → Runtime dependencies. Core owns tasks, history and scheduling; Runtime owns permissions, execution facts and resource lifecycle; adapters implement public integration contracts. Generality does not require a large redesign.
5. **Check contracts and counterexamples.** Necessary regressions cover the trigger class, boundaries, valid alternatives, unrelated state and recovery. Renaming, data changes and reordered inputs can expose hardcoding, but remain same-source robustness checks. Test behavior rather than merely the presence of a new field or instruction.
6. **Measure behavioral policies separately.** Compare prompts, compaction, recovery, scheduling and performance thresholds on development tasks under matched conditions. Prefer one variable. If changes must be combined, report the combined outcome first and use ablations before attributing it to one component.
7. **Confirm before promotion.** Use sources excluded from tuning to test transfer, including prior successes and other domains. Apply predefined gates to promote, limit scope, continue research or reject. Do not repeatedly scan thresholds until the same tasks pass.

A deterministic correctness or security defect can be repaired with a clear invariant, faithful reproduction and necessary regression checks without an expensive model experiment for every fix. Claim the contract repair; task-level benefits remain unverified. Documentation, formatting and changes without agent behavior effects need no invented model evaluation.

## General repair versus customization

| Situation | Assessment |
|---|---|
| A task exposes lost user corrections after repeated compaction; original user inputs are preserved | General correctness repair with same-class and recovery regressions |
| A guide loses important middle content; preserve file content, identity and pagination through the receipt protocol | Valid mechanism hypothesis; still test budget, stale evidence and actual use |
| Adapt inputs/execution by public MIME, tool schema, environment capability or explicit Profile | Legitimate capability adaptation; record configuration, boundaries and cost without expanding authority |
| Change strategy/budget by task ID, suite name, fixed business content, answers or private paths | Prohibited in general product logic; public experimental strata require explicit settings and separate reporting |
| Hardcode a task's action sequence, target values or answer format, or use hidden Reward to guide actions | Prohibited answer contamination or evaluation bypass |
| Turn one failure into an unconditional global instruction or hard threshold | Risk of overgeneralization; establish applicability, valid counterexamples and compatibility first |
| Repair an invalid grader and regrade every Harness's original artifact with the same revision | Valid independent grading amendment; retain original scores, rationale and version, without accommodating one Harness's output |

Generality permits task information. Models should choose actions from user requests and public environments; Core can schedule by read/write intent, dependencies and resources; domain tools can implement stable public protocols. Test identity and answers must not create shortcuts.

A change should explain why it remains useful after removing IDs, renaming files, changing business values or switching to another system with the same contract. How are valid counterexamples handled? Does it operate through production Engine/Runtime and other entry points? Is its benefit worth its maintenance? “This task needs it” is insufficient for promotion.

## Data and experiment boundaries

- The **development set** supports diagnosis and tuning; the **confirmation set** tests transfer after freezing the solution; the **regression set** protects contracts and successes. Inspected tasks and threshold-tuning cases become development data. Same-source variants cannot become source-separated confirmation tasks.
- Once confirmation results guide a later repair, those tasks become seen development material. Report the original bounded confirmation as planned; use new sources for the next independent confirmation. Without unseen sources, generalization remains unknown.
- Separate build, input and grading repairs from agent policy experiments. Shared tools apply the same contracts to all three Harnesses. Protocol bridges do not decide actions, change requirements or feed back hidden scores.
- Fix cumulative external budget, per-request model window, transfer bytes, output caps and concurrency separately. Charge main, auxiliary, title, summary, recovery and child requests to the root ledger. Unlimited product defaults cannot stand in for bounded evaluation results.
- Freeze adapters, added prompts, automatic continuation, completion markers and defaults. Read-only format conversion belongs in adapters; added planning, action selection and completion feedback are measured agent policies and require disclosure and separate comparison.
- Preserve correctness, normal termination, valid grading and independent review separately. Do not select the fastest success, discard budget stops, score pending review as zero, or equate smaller requests and estimated token savings with success rates or monetary cost.

Policy comparisons need both independent task/source coverage and repeated attempts; rerunning one parent task cannot establish generalization. Formal comparisons use at least 5 repetitions per task per arm. Follow [methodology](../benchmarks/methodology.en.md#repetitions-coverage-and-evidence-size) for development/confirmation workload floors, intervals and stopping rules. Preregister scale and gates, retain experimental status when evidence is insufficient, and never equate minimum counts with statistical sufficiency.

## Defaults and review gates

Keep new performance or heuristic policies as explicit, disableable experimental candidates until matched development comparisons and source-separated confirmation support their scope. Global prompts, retry counts, compaction/retention thresholds and scheduling policies follow the same rule. Overfitting extends beyond hardcoded answers. Review correctness repairs against contracts and identify unverified performance claims.

Stored originals do not guarantee timely recovery; fewer input bytes do not guarantee lower total consumption; concurrency primitives do not establish end-to-end speed; recovery does not authorize replaying effects. Negative results stop promotion and require mechanism analysis. New unit tests cannot erase an observed task regression. A new mechanism inherits neither positive nor negative effects measured on an old version.

Use the [PR template](../../.github/PULL_REQUEST_TEMPLATE.md) to give a concise, reviewable account:

1. Problem class, concrete evidence, observed termination and mechanism hypothesis, beyond task IDs.
2. Shared repair boundary, applicability, counterexamples and changes to prompts, tools, default budgets or adapters.
3. Mechanism checks, development comparisons, source-separated confirmation and omissions; distinguish implementation, contracts and effects.
4. Benefits, regressions, costs and limits across all attempts, and whether default promotion is supported.

Do not merge as a general improvement when transfer cannot be explained or the change depends on task identity, hidden answers, weakened grading or a unilateral budget advantage. Behavioral candidates without transfer evidence may remain isolated research; do not describe them as established overall capabilities.

## MCP schema projection experiment

`ToolPolicy.lazyMcpSchemas` defaults to false. When enabled and a Turn can access more than 16 MCP tools, the model first receives a bounded summary directory and `mcp_tool_search`. Searches return at most 8 entries, queries are limited to 512 bytes, and the directory is limited to 16 KiB. Matching schemas appear on the next model request. A call in the same batch cannot use a schema that was not offered. Each Turn starts with an empty loaded set. Search and directory entries use the same frozen registry and Profile permission filter.

The host still performs full MCP `tools/list`, schema compilation and invocation validation. Existing discovery, connection and execution budgets remain in force. This experiment changes model context only. The deterministic stdio fixture checks search, same-batch rejection and Turn isolation. It does not establish real-model success rates or lower total consumption. Promotion requires the controlled comparisons and source-isolated confirmation described in this document.

If the Profile does not allow the search tool, Core retains eager schema projection without expanding permissions.
