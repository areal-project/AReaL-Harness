[中文](child-result-consumption.md) | **English**

# Child-result consumption and completion requests

## Problem and references

After a parent model has received a terminal child result through a coordination tool and produced a text-only answer, `generation` may still hold a null `child_results`. Automatic join produces a different summary and restarts generation. Tool reads and completion do not share delivered-result state. The redundant request can also return an empty completion and fail an otherwise finishable Turn.

Seen Standard122 trajectories identified the mechanism, without introducing task-specific behavior. The 103 samples with no later tool calls establish continuation requests, not that every continuation was useless or that all their latency can be saved.

| Implementation | Completion and delivery | Transferable boundary |
|---|---|---|
| Codex 0.163.0, official commit `83086188ae0614bd882818ff1aa23f3194962012` | `session/turn.rs` combines model follow-up and pending input, then runs stop hooks. `session/input_queue.rs` drains mail and can defer non-triggering notices. V2 `wait_agent` waits for mailbox activity | Continue for new input; waiting and result delivery share the mailbox. Legacy wait can return status as well as a completion notice, so no universal absence of duplication is claimed |
| Published DSH 0.2.0-rc.2 | `dsh-agent-loop/lib/index.js` completes without tools, unless next-step inbox or a turn-stopping hook adds input. Foreground subagents return results through tools; continuable subagents send settlement messages and separately settle ownership | Separate result consumption from lifecycle settlement; deleting waits would not preserve the contract |
| Repaired AReaL | Keeps join, tracks trusted terminal versions present in successful model-response inputs, and continues when new results require delivery | Remove duplicate consumption within the existing shared Core boundary while retaining resource gates |

Codex sources: [main loop](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/turn.rs), [input queue](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/session/input_queue.rs), and [V2 wait](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs). DSH sources are the actual published [agent-loop](https://www.npmjs.com/package/@deepseek-ai/dsh-agent-loop/v/0.2.0-rc.2), [subagent](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent/v/0.2.0-rc.2), and [tool-subagent](https://www.npmjs.com/package/@deepseek-ai/dsh-tool-subagent/v/0.2.0-rc.2) in the frozen artifact. These are fixed-version mechanism references, not claims that every optional feature was enabled in the benchmark.

## Repair and invariants

- Consumption belongs to one parent `generate` within Core. There are no new protocol fields, settings, global prompts, retries, or budgets.
- Match actual request tool outputs to a unique call ID in the current Turn, checking built-in `coordination` provenance, successful reads, and owned children. User text, external namesakes, ambiguous IDs, and projections missing structure cannot acknowledge consumption.
- Legacy threadId and shared executionId resolve to the child Thread/Turn. Compare terminal state, resource release, error, source Item, activity, and a bounded initial page. Normalize 2/8 KiB tool pages and 1 KiB automatic summaries to the same UTF-8 prefix; a tail page does not cover an unread beginning.
- Acknowledge after a successfully completed response, not during preflight, stream failure, or steering. Preserve consumption across compaction within the Turn, without equating supplied evidence with model understanding or task success.
- Share consumed-child progress with join while retaining necessary waits for unfinished siblings. New failures, reports, and cleanup state remain visible; omitted reports retain existing bounded summary and retrieval behavior.
- Deduplicate identical automatic child contexts against the latest matching state without deleting history or rewriting provider reasoning. Preserve A→B→A changes.

Scope is native children and shared executions through executionId. Isolated Workgroup verification/application/delivery, legacy research agents, and cross-Turn TaskRun lifetimes are unchanged. Requests without model children bypass consumption scanning. Layering is unchanged; behavior is documented in [multi-agent design](../../design/multi-agent.en.md) and the [Core API](../../api/core.en.md#agent-tools).

### Correspondence with the reference designs

The shared continuation invariant is that, after a successful completion with no new result requiring delivery, an identical result does not cause another request. Codex consumes messages through `take_mailbox` / queue draining, and DSH through its next-step inbox. AReaL retains both tool reads and automatic join, so the parent generation loop records trusted result versions across those entry points. Records advance after an accepted response and survive compaction. The call index also records Turn membership, avoiding a repeated scan of current-Turn history for each receipt.

Lifecycle policies still differ. Codex V2 can defer non-triggering child notices until the next Turn; DSH separately settles inboxes, owned children, and disposal; AReaL continues to publish its final answer after the existing join, cleanup, and delivery gates. This repair does not reproduce an entire mailbox protocol or detach unfinished children from their parent. Existing mainline deduplication for isolated execution receipts remains unchanged; this change completes consumption tracking for shared native children.

## Validation

The validation base is mainline `cc2c977ecb772c18f1ede6dbe5bca27fb89af665`. Regressions use the real Engine with deterministic model fixtures in [child_completion.rs](../../../core/engine/tests/child_completion.rs). [child_completion_http.rs](../../../core/engine/tests/child_completion_http.rs) exercises actual Chat Completions / Responses HTTP encoding and decoding; input provenance tests are in [agents.rs](../../../core/engine/src/agents.rs). The `ci` profile retains debug assertions while disabling debug symbols and incremental compilation; this is not a real-model speed measurement.

All 12 pre-fix reproductions made four parent requests instead of three: two identity interfaces × read/wait/wait_any × completed/failed children. The redundant request deliberately returns an empty completion to check that it cannot fail an otherwise finishable Turn. Recovery budgets are not increased to pass.

Additional gates cover unread results, tail-page coverage, failure after a timed-out wait, fast/slow siblings, no repeated summary after another tool round, consumption across compaction, untrusted input, and state changes. Expanded cases add interruption, empty/truncated response recovery, repeated reads, user steering, UTF-8 / JSON escaping, batches of 4/16 children, and final-round budgets, for 49 parameter scenarios. Recovery-specific cases explicitly allow one existing recovery; product retry defaults and budgets are unchanged. Assertions include request counts, input content, final-message phase, and child terminal state, not only answer text.

Substituting unrepaired mainline `generation.rs` into the same expanded suite produces 20 failures and four passes out of 24 tests. Restoring the repair passes all 24 tests in five consecutive runs. Legitimate continuation for unread or late results and final-round constraints remains intact.

| Check | Result |
|---|---|
| `cargo test --locked --profile ci -p areal-engine --test child_completion` | All 24 tests passed in five runs, with 49 parameter scenarios per run; original reproductions reduce parent requests from four to three |
| `cargo test --locked --profile ci -p areal-engine --test child_completion_http` | Four passed: two HTTP protocols × two identity interfaces, each with three actual parent requests and one child request, without duplicate parent usage |
| `cargo test --locked --profile ci -p areal-engine --lib child_consumption` | Two passed, including cross-Turn receipts, ambiguous IDs, unknown tool outcomes, version changes, and retained consumption |
| `cargo test --locked --profile ci --workspace --no-fail-fast` | Locally 1048 passed, five failed, 14 ignored; subprocess failures are explained below. This run did not include the four HTTP regressions executed separately afterward |
| `cargo build --locked --profile ci --workspace`; `cargo clippy --locked --profile ci --workspace --all-targets -- -D warnings` | Both passed |
| `AREAL_UNIFIED_BIN_DIR=target/ci node scripts/unified-execution-smoke.mjs` | Real Core/Runtime parallel isolated delivery, cancellation cleanup, ownership, and restart recovery passed |
| `cargo fmt --all -- --check`, diff whitespace, and `python3 scripts/check-docs.py` | Passed; links and language pairs checked across 189 Markdown files |

Following the [development guide](../../development/README.en.md), test subprocesses retained existing `NO_PROXY` / `no_proxy` entries and added localhost/127.0.0.1; global proxy configuration was unchanged. Five failures concern the model proxy, MCP plugin restart, cross-process OAuth refresh, and two MCP proxy checks. System logs identify an AMFI `Unrecoverable CT signature issue` for the corresponding binaries. Direct rechecks of the same SHA-256 binaries still failed; signatures and security settings were not changed, and these cases are not counted as passes. Earlier proxy timeouts and interrupted runs from the original workspace are also retained.

Fixture changes preserve strict assertions: the existing single-permit fixture now recognizes two complete terminal results delivered through tools, while still requiring both results and settled children. Unread scenarios use semaphores to prevent spawn from already returning terminal evidence, avoiding a false missing-result diagnosis. Development failures from synchronization assumptions, incomplete receipt fields, and missing dependencies are retained. An additional legacy research-agent smoke failed with `KeyError('tools')` because its fixture treated a tool-free session-naming request as a work request; it is not counted as passed, and that legacy entry point was not changed for this repair. Default-ignored capacity and additional native integration checks were not executed or counted as passes.

## Limits

Deterministic regressions establish the completion control-flow repair. One fewer fixture request does not establish a universal 25% speedup or better Standard122 speed/accuracy. Seen samples and their variants are development data. Without real-model reruns and source-isolated confirmation, no general capability gain is claimed. Failures, UNKNOWN, child usage, and output retain their original meaning.
