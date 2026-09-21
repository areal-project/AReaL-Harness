[中文](tui.md) | **English**

# TUI structure

The TUI projects Core state and owns neither the model loop nor business history. Fullscreen and `--prompt` modes share the protocol client; `local.rs` handles trusted launch assembly.

| Module | Responsibility |
|---|---|
| `main.rs`, `client.rs` | Terminal lifecycle, WebSocket, bounded queues and reconnection |
| `app.rs`, `commands.rs` | RPC context, focus, subscription budget, Slash metadata and selectors |
| `history.rs` | Item layout caching, wide-character wrapping, stable reading anchors and viewport clipping |
| `theme.rs`, `ui.rs` | Themes, color fallback, responsive layout, task tree and Workgroups |
| `headless.rs`, `local.rs` | Single-Turn output filtering and local launcher |

Long histories lay out the viewport and necessary cache. Incoming events do not steal the scroll position while reading older content; returning to the bottom resumes following. Tool expansion and terminal resizing preserve stable Item anchors.

Session selection, child trees and Workgroups are read from Core. Subscriptions are bounded; reconnect resumes and replaces the baseline before consuming deltas rather than bridging missing events. Model switching/reset uses configuration revision checks at idle boundaries. Local appearance preferences never enter model context.

See [client usage](../guides/clients.en.md) and [testing](../development/testing.en.md).
