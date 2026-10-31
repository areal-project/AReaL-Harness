[中文](execution-trace.md) | **English**

# Inspect execution traces

Open the invocation trace panel on the right of a conversation to inspect saved execution records for that conversation and its delegated subagents. Each turn shows queue and execution timing, current activity, retries and exceptions, and long model or tool calls. Select an entry to locate its details.

## Understand timing

Queue waiting and actual execution are measured separately. Model requests retain each attempt's complete duration, wait for first content and subsequent generation, including failed attempts and retry waits. Tool duration may include approval and processing. Waiting for a subagent may overlap its execution; these values do not add up to turn elapsed time.

Expand subagent entries organized by delegation to inspect internal turns, model calls and tools. Core reads shared, nested and isolated-worker traces. Input or wait operations across turns reference the same execution. Task-owned agents and legacy agents with only a parent-conversation relationship appear in the conversation's subagent area when no creation turn is recorded; copying the whole conversation retains these agents.

Running activities show elapsed time and the latest record time. Unconfirmed state, unknown outcome and missing timing are distinct. Recovered records without an end time do not keep counting to the present.

## Search, filter and read original results

Search covers saved text, summaries and call metadata across the conversation and its subagents, including collapsed entries and earlier history not yet loaded. Results retain conversation, turn and activity ownership; selecting one expands and locates it. The panel identifies reads still in progress and unavailable sources.

“Exceptions encountered” includes records that eventually succeed after retries. “Final failure” is a separate filter. Duration filtering defaults to 10 seconds, with 30-second, 60-second and custom thresholds, plus descending-duration ordering. Running activities use elapsed time.

Large tool results may be abbreviated. Expand a result and select “View original result” to search its saved original separately. Missing originals and read failures show their reason. Ordinary conversation search covers saved text and summaries; original result attachments are read on demand.

## Copying and retention

Copy a turn including its subagents, the entire conversation, or filtered results. JSON includes timing, state, errors, model metadata and relationship identities. Partial reads retain explicit coverage information in the copy.

Everyday diagnostic records are retained with Core conversation history independently of optional trajectory capture and upload settings. Old records missing new fields display “Not recorded”. Trace details contain recorded content and call metadata; complete model request payloads remain separate diagnostic material.

Durable state writes use format version 16 and continue reading versions 1–15. Rollback to an older Core requires a pre-upgrade backup; see [local service compatibility](../api/local-service.en.md).
