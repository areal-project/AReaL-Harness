[中文](context-continuity.md) | **English**

# Context continuity and persistence validation

## Problem and changes

Later task revisions must not depend entirely on a lossy summary. The old projection preserved only the first user message verbatim. This change replays every real user input in chronological order from durable history, excluding the initial automatic-continuation item identified by Turn origin while retaining subsequent steering. A summary cannot revise user requirements. No second inferred task contract is introduced. Parents must explicitly send relevant revisions to existing children rather than silently expand their assignments.

Compaction projects candidate history before paying for a summary. It checks the recent-history boundary and deepest complete prefix, avoiding repeated projection for every round. Valid summaries fit the actual net saving up to 16 KiB; 8,000 bytes is generation guidance only. Internal controls and retries use system messages, and degraded evidence does not nest previous DEGRADED summaries. Steering during summarization is included in both sides of the commit-time size comparison.

Optional target tokens and summary-only reasoning/output settings are documented in [configuration](../../guides/configuration.en.md). Solve defaults remain unchanged. Events report generated/allowed summary lengths, degradation reason and projected user count. Cancellation allows one second to drain trailing usage from an open stream without executing output tools; missing usage stays UNKNOWN and cannot authorize replay or a budget reset.

## Reference implementations and choices

| Pinned source | Observation | Applied choice and boundary |
|---|---|---|
| [Codex compact.rs, b741e480](https://github.com/openai/codex/blob/b741e480e203f037ca726bc2a76d99a8e8668e66/codex-rs/core/src/compact.rs) | Separately collects real user messages, excludes summaries and rebuilds compacted history; local compaction uses a user-message token budget and truncation metadata | Recover requirements from original history. Harness does not silently truncate user messages, so very large user input can still prevent reduction; this is not unlimited context |
| [OpenCode compaction.ts, 907b3bc5](https://github.com/anomalyco/opencode/blob/907b3bc518fa48e90e8ec24dd327d13eee71c36c/packages/opencode/src/session/compaction.ts) | Keeps a budgeted recent tail, filters completed compaction controls, can replay a user message on overflow, labels synthetic continuation, and protects recent tool output before pruning | Distinguish origins and retain complete recent groups. Do not dynamically rewrite previously sent tool output, which could break this PR's append-only prefix and Responses reasoning association |
| [OpenAI Compaction](https://developers.openai.com/api/docs/guides/compaction) | Documents server-side compaction | The current gateway does not declare this contract. No default switch to opaque remote compaction without compatibility evidence |

Persistence keeps the existing atomic snapshot protocol rather than migrating to an incremental journal. Encode once for capacity checking and writing, removing redundant deep copies and unbuffered incremental JSON writes. Durable intent before execution, file fsync, rename, directory fsync and UNKNOWN recovery remain intact. Timing separates intent, invocation, projection and commit; persistence logs encoding, IO admission, write and sync.

Model configuration archives also retain their original JSON bytes and verify the digest of those bytes. Adding optional fields must not invalidate historical revision IDs when defaults are filled during decoding. Unset summary fields and disabled WebSockets are omitted from new fingerprints. Four archive layouts are tested across two reloads (legacy, explicit false, explicit null summary options, and configured summary options), including rejection of tampering.

## Validation

Run `node scripts/context-live-smoke.mjs /absolute/model.toml`. The script uses an isolated workspace and real reads, writes and commands. It submits five repair checks, changes one in a separate user message, forces three manual compactions alongside automatic ones, restarts Core, and completes a Goal. Independent assertions check every JSON field, a random nonce, an input sum, byte preservation of an accepted artifact and a successful real command. The repair contract is not written to a workspace sidecar to bypass conversation history.

The runs use gpt-6-sol with low solve effort and low/4096 summaries on the final candidate. Test-only byte window 20,000, recent 4,096 and target 16,000 deliberately force compaction; they are not production recommendations. This is not a Golden game-batch rerun or evidence of game acceptance.

Deterministic regression covers valid 8,027-byte summaries, repeated lossy/invalid summaries, revision ordering, Chinese input, steering inside automatic continuation, long steering during compaction, restart, impossible reduction, oversized recent regions, target headroom, summary overrides and Goal caps, trailing usage and UNKNOWN. Native Harness smoke covers actual read/patch/command operations, hooks, forced process death, recovery and no replay.

See [JSON evidence](context-continuity-results.json). All attempts are retained: initial missing credentials and a fixture credential returning 401 did not complete a model task. The first Responses task completed but the grader incorrectly excluded a successful verify_command; its original artifacts were regraded and the original failure retained. The final script accepts both successful real run_command and verify_command execution.

Final complete runs (all output checks passed; zero unknown usage):

| Protocol | Turns | Compactions | Tools | Requests | Input tokens | Cached tokens | Cache rate | Seconds |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| chat-completions | 7 | 6 | 19 | 27 | 206935 | 119552 | 57.77% | 165.9 |
| responses | 7 | 7 | 18 | 28 | 212487 | 107264 | 50.48% | 220.2 |

## Performance and limits

On the development machine's `/data` filesystem, three debug-profile runs of a 9,399,322-byte thread snapshot took 4,495.5 / 4,537.5 / 4,408.5 ms with the old path and 857.2 / 843.0 / 847.2 ms with the new path. Median time fell about 81.2%, or 5.3×, with identical file bytes each time. This includes encoding, cloning and file write/fsync, but excludes admission, rename and directory fsync. It is not an end-to-end speedup or proof of every production read_file delay's cause.

Reproduce with `TMPDIR=/data/your-test-directory cargo test --locked -p areal-engine --lib persistence_encoding_benchmark -- --ignored --nocapture`. CI does not assert wall-clock timing. See [timing diagnostics](../../development/testing.en.md#live-context-continuity).

Frequent compaction rebuilds cache prefixes. These cache rates include cold starts and summaries and are not comparable to the earlier steady-state A/B without compaction. No 99% claim is made. Existing Chat/Responses regression still checks append-only prefixes within uncompacted windows.

## Deployment and external ownership

This updates the PR without restarting Golden authors, changing authorized budgets or clearing UNKNOWN. Migrate binaries at a settled boundary while preserving the Goal, workspace and ledger. Previously omitted user revisions can reenter projection from retained original history; game facts still require independent verification.

Studio's 512-line diagnostic tail, thread-only cancellation attribution, 30-minute review wrapper and archive scanner belong to another repository and are not changed here. Consumers should correlate the full ledger with exact request owners/times, adopt valid bound terminal reports, and use bounded continuation of the same unfinished review session. Browser launchers need isolated short temporary paths and real relative-mouse/focus checks; this PR does not widen Runtime filesystem permissions. Other production candidate features, including safe-cancellation exemptions and unlimited rounds, must not be assumed merged by this Core fix.
