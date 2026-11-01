[中文](0016-shared-host.md) | **English**

# 0016: One shared Host per user; every client is a projection

Status: accepted target design, in progress. This supersedes the lifecycle ownership statements in [ADR 0008](0008-remote-host-ownership.en.md). The current GUI-owned background follows the application lifetime pipe. Closing a window and quitting the application have different guarantees; a separate process alone does not survive GUI quit.

One Rust Host per OS user owns the top of the project service supervision chain. CLI, TUI, GUI, Web, and the phone are clients; Core retains authority over Threads, Turns, Tasks, and execution receipts. A single owner avoids transitions between GUI-owned and background-owned lifecycles. Electron still owns native windows and desktop-only tools; the Host does not depend on GUI modules.

An old ownerless service cannot inherit an EOF pipe that was not passed at startup, so migration uses controlled restart. Active legacy services remain `legacyPending`. After idle drain or explicit cancellation, existing stop receipts, cleanup proofs, and released locks permit a fresh Host-owned generation. Editing registration metadata cannot claim adoption.

Project registration is independent of live-service discovery and Stores remain in place. Legacy GUI ID authorization and receipt mappings, the submission journal outside Store, and the single-writer switch belong to one migration transaction. Host supervision identity is separate from Remote Noise identity; distinct identities from legacy profiles require explicit conflict handling. Per-project stop returns partial results; UNKNOWN is queried, never replayed.

See the [Host API](../api/host.en.md) for the contract and the [implementation spec](../development/shared-host-spec.en.md) for stages and acceptance. Accepting this document does not establish runtime, device, or package acceptance.
