[中文](computer.md) | **English**

# Computer control

Computer control runs on the local GUI host. Core owns tool approval, execution history and UNKNOWN settlement. The authenticated desktop adapter routes requests, Electron Main owns the native helper, and Renderer presents status and permission controls. No private ZCode backend is required. The native executor in ZCode's public repository is an unavailable placeholder; this project implements the public tool contract with a macOS native producer.

## User authorization

Computer control settings have separate feature and composer-entry switches. The feature defaults to disabled. Accessibility, Screen Recording and Input Monitoring status comes from system checks. Opening settings or calling model `request_access` never requests system permissions. Only an explicit user click requests access. The system-settings action opens the relevant pane for the user to grant access. Refresh status or restart the helper after changing permissions.

Accessibility enables AX inspection and actions. Screen Recording enables screenshots. Every application mutation also requires working global physical-input monitoring so user takeover stops control. Authorized state inspection remains available without the monitor. Missing permissions produce explicit failures; model approval cannot grant OS access. Disabling the feature stops control before persisting the setting. Both the activity overlay and settings provide Stop.

## Tool and execution

`computer_v1` uses `{operation:string,parameters:object}`. Call `describe` for actual parameters and availability. Operations are `list_apps`, `list_windows`, `get_app_state`, `left_click`, `scroll`, `left_click_drag`, `type`, `set_value`, `select_text`, `key`, `perform_action`, `paste`, `request_access` and `stop_computer_control`. These retain ZCode's public method semantics without an arbitrary JavaScript or shell entry point.

Observations issue expiring `state_id`, element references and screenshot `frame_id`. Element and coordinate actions must bind the same observation, application and window. Core calls `areal/computer/prepare`, records the concrete target and arguments, and applies existing approval. Main and the helper retain one-use prepared records. Execution cannot resolve another target after approval. Helper restart, control-generation changes, expiry or cancellation invalidate a plan. Child conversations do not inherit control. On denial or cancellation before dispatch, Core uses an independent bounded cleanup request to discard that exact prepared plan and release its pending lease. Cleanup must match the original identity, arguments and plan. It cannot execute an action, stop another controller or release a lease retained by another plan.

The helper uses NSWorkspace, Accessibility, ScreenCaptureKit and CGEvent. Stop has an independent control channel and releases held inputs. Physical takeover and explicit Stop revoke observed task turns. The current model turn cannot reacquire control by observing again; a new explicit user turn can enter. Main retains this fence across helper restarts. Each Main records at most 4096 turns and explicitly refuses new control at capacity until the application restarts; old revocations are never evicted to restore authority. Ambiguous input dispatch returns UNKNOWN and Core never automatically replays it. Screenshots enter the current call and history through Core Blob/media, not local file-path text.

While idle awaiting approval, the native monitor exempts only input that the system explicitly addresses to the direct AReaL host. Input to another application still revokes the turn; during execution, every input not tagged by this helper stops control. Event actions may hand foreground control from the approval host to the exact retained application and window, with identity and geometry checks. A third-party foreground application prevents handoff; targets are never resolved again.

New GUI conversations register the tool only while the feature is enabled. Existing conversations may retain the persisted definition, but disabled admission still rejects execution. CLI/TUI and conversations without the local GUI host do not create another native-control process.

## External CUA (LCU)

On macOS, select **External CUA (LCU)** in Computer control settings. Save the absolute path to your installed `lcu`, enable control, check the connection, and create a regular chat. AReaL does not install or update LCU, bundle proprietary applications or runtimes, or request its system permissions. Missing dependencies or an unsupported Core produce an explicit failure without falling back to built-in control.

This phase registers the original `js` and `js_reset` only for manually created top-level chats. External CUA execution is not enabled for existing chats, Side Chat, child agents, or scheduled tasks. Original initialization instructions plus existing client instructions must fit the 32768-byte budget. Oversized instructions fail chat creation without truncation. Each chat has separate JavaScript state and reuses its connection across normal turns. Switching providers first stops existing control. Selecting LCU rejects old `computer_v1` calls. In-app Preview and `browser_v1` remain available, while LCU enables only its computer surface.

LCU owns JavaScript execution, application control, and internal permission policy. Core retains outer tool approval, real thread/turn/call identities, media, and history. Main displays original application consent in a native dialog and returns the selected upstream response. Closing, cancellation, and stale replies never grant access. Unsupported forms cancel. AReaL adds no approval cache.

Core waits for original `turn_ended` cleanup before settling a turn and sends Interrupt on interruption. Settings Stop queries actual active applications before calling original host Stop and turn cleanup. Window close, renderer crash, lock, and Core/Desktop disconnect revoke current control. Unconfirmed cleanup leaves control unavailable. Closing a transport does not establish that physical input has stopped. A disconnect or cancellation after dispatch remains UNKNOWN and never automatically replays JavaScript.

The open-source adapter is pinned to [LCU](https://github.com/amontlabs/lcu) commit `c31a57958b3086112949374ca6d21414a3ba22b7`. The MIT source files and their hashes are retained unchanged. Run `node clients/gui/scripts/external-cua-acceptance.mjs` to exercise the original client against an MCP subprocess fixture. This does not operate real applications or establish installed LCU, physical input, OS permissions, or package acceptance.

External LCU runs in the trusted Desktop host outside the AReaL Runtime workspace file and network sandbox. Core permission presets control outer JavaScript-tool admission; the original runtime governs the script’s internal access and application policies.

## Build and validation

`node clients/gui/scripts/build-computer-helper.mjs` builds `clients/gui/native/computer-helper/build/AReaL Computer Helper.app`. GUI builds invoke the same script and packages place the helper in Resources. Non-macOS builds explicitly skip the native artifact and report the unsupported platform.

`pnpm --dir clients/gui run test:automation` uses isolated Electron, real Core, a deterministic local model and fixture webpages. Native mode operates only the specified dedicated fixture application and requires prior user-granted OS access. A run without grants proves refusal and status paths only, not physical input, capture, package or real-provider acceptance. See the acceptance script and native acceptance entry points for exact arguments.

See the [browser reuse package](../../clients/gui/packages/browser-automation/README.md) for source and license attribution. No closed-source ZCode native producer, account data or credentials are imported.
