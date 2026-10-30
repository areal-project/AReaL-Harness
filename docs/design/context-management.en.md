[中文](context-management.md) | **English**

# Context management

Core owns request budgeting, compaction and durable history. The [Core contract](../api/core.en.md) defines the public projection; the [configuration guide](../guides/configuration.en.md) describes settings. Explicit context-window settings take precedence over the known-model defaults. Unknown model IDs use the global 131072-token fallback. The default HTTP output cap remains 16384 tokens.

## Problem and goal

One allocator plans complete requests, retaining the latest real user request and unresolved tool operations. Older material can be summarized or retrieved. Durable history is independent of model projection trimming. A larger window does not replace retention policy.

## Configuration consolidation

| Setting | Behavior |
|---|---|
| `model.context_window_tokens` | Sets the user working budget, capped by a service-reported window when available |
| `model.max_output_tokens` | Common setting; overridable per-model HTTP request default of 16384, strictly positive |
| `context.mode` | Keep auto / manual / disabled |
| `context.target_tokens`, `context.recent_tokens` | Automatic target/recent defaults are 0; positive legacy values remain compatibility boundary preferences with source diagnostics |
| `context.output_reserve_tokens` | Keep as an advanced minimum reserve; normal use reserves the output cap automatically |
| Legacy token / byte fields | Continue parsing with existing semantics; remove from common examples without silently ignoring explicit values |
| Internal input and evidence quotas | Remove the two independent fixed quotas and allocate from the complete request budget |
| History storage, request bytes and tool-result protection | Keep their independent responsibilities; token budgets do not replace storage or transport protection |

Do not add a retained-input quota setting. Common settings are window, output and compaction mode, preserving provider/model parameter precedence. Summary-specific reasoning effort and output settings remain advanced options rather than becoming ineffective configuration.

## Known model windows

The service-reported window and the user's working budget are retained separately. Account `context_window` is the currently reported window; optional `max_context_window` does not replace it. The working window is the smaller of the reported window and an explicit user budget. The UI shows the report source, reported capacity, and user budget separately. Accounts without a reported window use the global fallback, never the public API's model-name defaults. Custom endpoints use exact-ID defaults only when neither a report nor a user budget is available. Unknown IDs use the global fallback.

An idle conversation's context query projects the next new request. At admission, reported capacity and model capabilities refresh only when provider identity, endpoint, protocol, and credential reference match. Historical Turns, active Turns, and already accepted queue items retain their frozen snapshots. Capacity updates do not switch accounts or rebind endpoints. User budgets still use `model.context_window_tokens` in standalone TOML and `contextWindowTokens` in desktop parameters. Legacy snapshots cannot distinguish an automatically filled window from an equal explicit budget. Saved window parameters are conservatively retained as budgets, so a larger report cannot silently increase them. New snapshots retain budgets and reports separately.

The defaults were checked on 2026-10-20. Exact supported IDs are owned by `core/engine/src/model/context_windows.rs`.

| Model IDs | Window | Official source |
|---|---:|---|
| `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-astra`, `gpt-6-luna` | 1,050,000 | [OpenAI models](https://developers.openai.com/api/docs/models), [Sol comparison](https://developers.openai.com/api/docs/models/compare?model=gpt-6-sol&model=gpt-6.1-sol) |
| `gpt-5.6-sol`, `gpt-5.6` | 1,050,000 | [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol) |
| Claude IDs listed in the Core table | 1,000,000 | [Claude context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows) |
| `deepseek-flash`, `deepseek-v4-pro` and documented V4 Flash aliases | 1,000,000 | [DeepSeek models](https://api-docs.deepseek.com/quick_start/pricing/) |
| `glm-5` | 200,000 | [GLM-5](https://docs.z.ai/guides/llm/glm-5) |

Gemini was reviewed but is not assigned a default. Gemini 3 and 2.5 have separate input and output budgets. Gemini 4 shares one window. Treating an input-only limit as a shared window would change its meaning. See [Gemini token limits](https://ai.google.dev/gemini-api/docs/tokens).

## Unified planning for complete requests

For window W, reserve R is the larger of the request output cap and explicit reserve floor. Available input is W − R. An unknown model using the fallback and default HTTP output cap has 114688 tokens for the entire input. Planning and sending share message construction and accounting, including live instructions, tool schemas, media and protocol envelopes. Preserve full provider input-usage calibration and conservative headroom for media estimates. Compaction also obeys the same raw conservative estimate used by final preflight: smaller historical usage cannot bypass the hard window gate, while larger actual usage can still trigger earlier compaction.

Allocate in this order, retaining original roles and chronology:

1. Fixed instructions, the current Turn's latest real user request with attachments, unresolved calls and required paired results are mandatory. Automatic Goal continuation is not a new human request.
2. Include complete tool rounds and user corrections from newest to oldest as space permits. The initial question has no permanent priority.
3. Represent older material with one bounded checkpoint containing a summary, retrievable original references and execution receipts. Originals, evidence and summary share the remaining budget; prefer references for completed tool results.
4. Never trim the latest request to satisfy the old soft quota. If mandatory content cannot fit, return `LLM_CONTEXT_WINDOW_EXCEEDED` instead of answering an older task.

When the selected boundary's fixed instructions, recent complete rounds, latest request and valid summary already reach the soft token target, older text-only user revisions may still use the hard-window headroom within the existing byte allocation. This prevents the soft target from freezing revision capacity at zero. Historical attachments and optional execution evidence do not use this headroom. Chronology, hard preflight and newest-first selection under real capacity pressure remain unchanged. Summary guidance must not assume every older original is replayed separately; preserve unrevoked constraints and exact user-specified values.

Initially retain the 60%-of-available-input compaction target as internal policy to provide headroom. When that target is unreachable but the hard window can still be met, record why and avoid repeated compaction without progress. Replan after model switches. Manual/disabled modes retain their explicit compaction and overflow boundaries.

The context window limits each request; the Goal token budget limits cumulative consumption across the objective. Compaction reduces history in later requests without reversing previously metered input or output, and summary requests also consume the Goal budget. Cached input is a subset of input tokens and remains part of cumulative token usage; provider cache-price discounts do not reduce this token budget. The 60% value is the post-compaction target, not a trigger at 60% utilization.

## Compaction commits and failure

Solve assembles the full request without persisting its new controls, then reserves the estimated difference between the request and its history projection for compaction planning. Unsent controls cannot become the tail item, so completed tool rounds remain eligible for whole-round compaction. Rebuild after compaction or steer changes history; under the commit lock, revalidate the original history boundary and pass hard preflight before appending controls. Recovery hints survive until acceptance, and rebuilding consumes no additional solve round. Summary calls retain existing accounting, cancellation and retry limits. Controls and reasoning context from sent requests remain unchanged.

Compaction builds, validates and atomically commits a candidate. Before replacing the previous checkpoint, the candidate must cover a valid settled prefix, preserve the latest request and tool pairing, reduce context size and pass complete solve-request preflight. Summaries remain historical evidence with lower priority than new user instructions.

Summary request failures such as HTTP 400 preserve the previous checkpoint and originals, without committing a degraded summary that loses meaning. Only received but malformed summaries use the existing bounded validation repair. Do not repeat identical permanently invalid HTTP requests as validation retries. Transient network recovery retains cancellation, watchdog and Goal accounting constraints.

Continue only if the previous projection can fit the current request; otherwise report both summary failure and insufficient window. Check history boundaries and new steer before committing; replan if they changed. Store still writes immutable archive segments before snapshot references, without replaying execution effects.

## Module responsibilities

| Module | Responsibility |
|---|---|
| `core/engine/src/context.rs`, `history.rs` | One allocator and chronological projections, original retrieval, complete round boundaries and validated candidates |
| `core/engine/src/generation.rs` | Build actual live context, share accounting, preflight and rebuild after compaction or steer |
| `core/engine/src/desktop/context.rs` | Recorded-instruction/current-tool budget diagnostics and manual compaction |
| `core/config`, `core/server` | Defaults, explicit parameter precedence and legacy configuration compatibility |
| `core/protocol`, desktop schema | Public failure notification and budget projection; Clients consume Core diagnostics |

Preserve Clients → Core → Runtime ownership. GUI displays Core budgets and outcomes without trimming authoritative history itself. Read old checkpoints compatibly and generate the new projection at the next successful compaction; do not bulk-rewrite user sessions.

## Acceptance

Use local model fixtures for multi-image corrections, an oversized latest input, superseded initial requests, repeated compaction and restart, old checkpoints, smaller-window model switches, explicit output overrides, reduced Goal output allowances, complete tool pairing, summary HTTP 400/empty/oversized content, cancellation and steer during compaction. Assert actual HTTP input, checkpoint commits and durable originals separately. Provider tokenizer accuracy and service compatibility require separate integration verification.
