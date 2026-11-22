[中文](recovery-verification-map.md) | **English**

# Recovery verification feature map

This table defines obligations, not a claim that every entry point has passed. Commands and evidence contracts are in the [testing guide](../development/testing.en.md). Planning remains owned by the [journey manifest](../../clients/gui/scripts/journey-manifest.json).

| User goal and entry point | Authoritative outcome | Visible outcome | Executable evidence | Scope and gap |
|---|---|---|---|---|
| First Web connection and project selection | Current connection receives the original successful shell baseline | Loading without a false failure alert | Fixed loading journey; every exploration also delays a real baseline | Does not establish packaged startup |
| Edit, disconnect and recover | New connectionId belongs to the original Host; restoration uses the current owner | No manual reconnect; project, Thread, model and draft preserved | `edit → reconnect`; step observations, screenshots and wire events | Socket replacement within one Host, not Host process replacement |
| Continue after idle reclamation | Original `ifIdle` completes without explicit-stop intent; on-demand recovery follows | No failure prompt; a later submission succeeds | `idle-reconnect → submit`; stop receipt, successor socket, Core Turn and UI | Direct production reclamation path, not the actual fifteen-minute timer |
| Submit with Enter after recovery | Original request admitted; exactly one Turn completes | Corresponding completion visible; original draft settles | `submit`; send command, Core identity and visible completion | Deterministic local model, not real-provider quality |
| Continue after losing a send response | Exact accepted response dropped; original commandId queried without another send | Original Thread selected; draft settles; editing remains possible | `unknown-submit`; fault hit, durable receipt, no duplicate Turn after later events | Requires a Thread; UNKNOWN during initial creation belongs to other journeys |
| Reconnect after explicit stop | Stop intent remains; no new execution generation | Reconnection does not silently resume execution | Terminal `stop-reconnect`; production control request, receipt and three-second observation | Control request injects state; does not prove native-menu/dialog clicks. Finite observation is not an eternal guarantee |

## Exploration and replay

Each attempt starts from an isolated empty project. A validated bounded plan drives real UI and Host/Core observations. In addition to the action order, evidence records actual requests, responses and shell events. Trace content is synthetic; credentials and pairing tickets are excluded.

Passing requires every action to execute, step evidence to import, authoritative and visible submission outcomes, and completed cleanup. Failure preserves the first assertion, current action, original plan, executed prefix and unexecuted suffix. Reduction reruns legal candidates in fresh fixtures; a different error or startup failure cannot count as a smaller reproduction.

## Expansion boundary

After the recovery sample passes, reuse its planning, evidence and reduction mechanisms for ordinary submissions, UNKNOWN and explicit-stop combinations. History/restarts, model configuration, Relay/mobile, permissions and scheduling need their own prerequisites and authoritative outcomes. Extract shared operations when another actual consumer needs them instead of copying the entire runner.

Human benefit still requires a fixed consecutive sample and measured judgment time. Action counts, green cases and report field counts do not establish efficiency gains.
