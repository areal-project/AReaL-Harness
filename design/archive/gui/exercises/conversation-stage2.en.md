# Conversation stage two: interaction-family migration

Chinese: [stage two](conversation-stage2.md). The user accepted the scoped settings pilot. This stage applies I-INPUT, I-OBSERVE and I-RETURN, supported by I-READ, to the production Electron conversation. The [surface contract](../../../../clients/gui/design-system/surfaces/conversation-stage2.json) retains existing P-CONVERSATION rules.

## Decisions and ownership

| Interaction | Product default | Required invariant and owner |
| --- | --- | --- |
| Compose and send | Existing Composer draft, send and execution feedback | ConversationComposer / App submit to Core; acceptance differs from completion; no new message or execution store |
| Observe and read | Completed group names its execution contents and expand/collapse action; command header exposes textual state | TurnProgress retains manual disclosure; CommandDetails reads existing projections and accumulates output for the same processId; tool success never implies process exit |
| Inspect a child | Child entry identifies delegation and View; panel/tab use the original task, falling back to existing identity | ToolEvent / AgentConversationPane / App; command, child thread and parent final remain independent; creation receipt is not child completion |
| Open and return | Existing image viewer and child panel | App retains parent Messages; draft and sensible invoker focus survive return; reading never resubmits work |

Moving command state into the header and adding explicit disclosure text are our I-OBSERVE/I-READ choices. Historical Codex 26.1013.31256 informs task naming, separate child reading and completion grouping. No current Codex capture or literal layout parity is claimed. Color, font, density, window proportions and motion parameters were not comprehensively recalibrated.

## Repeatable validation

```sh
make gui-build
AREAL_CORE_BIN=/absolute/verified/areal node clients/gui/scripts/migration-smoke.mjs --conversation-stage2
```

Freeze the old production renderer before modification. AREAL_CONVERSATION_BASELINE=1 skips only new presentation assertions; it cannot establish new-version acceptance. Both sides use the same UI actions, deterministic local HTTP/SSE model, actual Rust Core/Runtime and isolated configuration. Content reuses the E1 synthetic fruit task, so this is not a blind test or real-provider acceptance. Commands, output reads and child threads execute for real, without injecting expected renderer state.

1. Send history, then compose and send a composite task; capture the draft and Core-accepted/model-held states separately.
2. Run one real incremental command alongside one Core child. Inspect the same command, image and child; command finishes first, child second, parent final last.
3. Leave an unsent parent draft and close the child. Check retained parent DOM identity, draft and invoker focus; record reading anchors before/after without requiring identical y coordinates across content growth.
4. Read a fixed historical paragraph during two further content batches, return to latest and observe arrival plus two following batches. After completion, reopen the same process and child, then return without extra submissions or command replay.

Each run retains eighteen semantic checkpoints, PNG/ARIA, events, state, model requests, original recording, host/source/binary identity and cleanup. Compare equivalent tasks, dark theme, default font14, CSS content1509×949 and DPR2. Timers and generated identities differ. Independent runs are never spliced into one recording; matching filenames alone do not prove equivalent state.

## Result and limits

Both actual Electron runs passed; Core binary identity remained unchanged and the runner safely stopped isolated services. An initial baseline watched the automatically created project; binding to the exact workspace corrected this test defect. Failed evidence remains available; product behavior was not changed to hide it. Raw evidence and the comparison remain local.

This demonstrates another production interaction composition in the same implementation session, not independent generalization or a complete Codex replica. The full failure/UNKNOWN matrix, new continuous-motion measurements, narrow/light/font18 conditions, real providers, native IME, packages and other operating systems remain outside this run. Earlier preview/desktop evidence retains its original scope. Visual decisions await user review; Base0.1.3 remains unfrozen. No automatic stage three follows.
