[中文](user-feedback.md) | **English**

# Response feedback and the data flywheel

The GUI provides thumbs up and down under settled main conversation replies. Controls appear only when persistent trajectory export is enabled, the owned control snapshot matches, and the receiver exposes a working feedback capability. Older receivers keep the controls hidden. Users can disable them in Settings → Data flywheel → Response feedback; this private GUI preference is separate from trajectory export.

## Usage

Voting creates a local draft without publishing it. A reason is optional. The nonmodal panel stays anchored to the rated reply, with a subtle entry animation. Scrolling the reply out of view hides the panel; returning restores it. Explicit close or successful submission dismisses it. The main conversation remains usable.

Submit directly, or enter a reason and choose Agent polish. Polishing uses the existing Side capability to create an independent Thread anchored after the rated Turn, with workspace access `none`. Its first input contains the frozen Core conversation and the original user opinion. The model separates user opinion, observed evidence, and hypotheses. Follow-up opinions continue in that Side; users can revise the final analysis directly. Stop affects only polishing. Submission waits until generation settles.

Generation shares the existing model concurrency limits. An independent context does not grant extra model capacity. The Side does not bring messages back to the main conversation or advance its Turns. Main conversation content generated after draft preparation stays outside this submission.

## Context and persistence

The trusted GUI backend reads `thread/read` and freezes the prefix through the rated reply. Fork inherited history is fully paged and reassembled. Limits are 1000 Turns and 16 MiB; exceeding either fails explicitly without truncation. `areal.feedback-context/v1` retains Thread, Turn and Item identities and the complete public history projection. Media and tool content remain as the data or references held by Core; the projection cannot recover uncaptured files, attachment binaries, or original network bytes.

Submission includes `up/down`, the original reason, user-approved analysis, frozen source prefix, and every polishing Turn. Arena stores separate feedback metadata and context objects, referencing readable immutable OTLP revisions; sources not uploaded yet remain unavailable references. Feedback does not overwrite original trajectories, execution status, Reward, or independent quality judgments. Votes alone do not establish good/bad or qualify a Benchmark.

A draft binds the receiver destination digest, authenticated account and spool installation identity, checked again before submission. The CLI reads installation identity from the actual trajectory spool. The Renderer cannot select endpoints, accounts, installation IDs, or context. Credentials stay in protected export configuration. HTTP redirects are disabled. Generic OTLP collectors without this extension continue receiving normal trajectories.

Drafts use private files; localStorage holds only a UUID. The complete request is persisted before submission. Timeouts or uncertain receipts retry the same UUID and exact body, excluding later edits or main Turns. An uncertain first polishing submission is recovered by its request receipt. Receiver, account or spool installation changes prevent misdelivery. Closing an unsubmitted draft does not submit formal feedback. Once Agent polishing starts, it is a real independent Agent task whose ordinary telemetry follows the already enabled flywheel settings; the panel explains this before polishing. Only explicit submission creates the feedback record and special tags.

## Management and validation

`feedback` is a trusted App command, not a new Core inference RPC. Operations are `status/preference/prepare/read/draft/refine/submit/close`; history and Side reuse the [desktop API](../api/desktop.en.md). UTF-8 limits are 32768 bytes for `reason`, 65536 for `analysis`, and 16384 for a follow-up.

`areal trajectory feedback-status --config /absolute/config.toml` reads capability status and returns `enabled/connected/destination/account/installation`. `areal trajectory feedback-submit` reads a frozen JSON request from stdin, bounded at 16 MiB + 128 KiB. The receiver must expose same-origin `/external-feedback/capabilities` and `/external-feedback` with `arena.user-feedback/v1`. Failure does not affect the Agent reply.

Validation:

```bash
cargo test -p areal-server trajectory::feedback --lib
cargo build -p areal-cli
cd clients/gui
pnpm typecheck
pnpm build
pnpm test:feedback
```

Interaction tests use the real Renderer build with an isolated desktop fixture and cover the UI boundary. Platform SQL, API and Web must be deployed together before installed clients can show the feature. Local acceptance does not establish production deployment, classification accuracy, or overall Harness improvement.
