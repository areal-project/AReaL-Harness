# Native acceptance boundaries

These cases precede implementation. The fixture is a local AppKit window whose values and received input are written to a caller-selected JSON evidence file. It does not use other applications or network services. The action driver requires an explicit `--actions` switch and existing macOS grants. Its passive mode never requests access.

| Failure | Observable expectation |
| --- | --- |
| Accessibility or capture permission denied | The helper reports its own grant status. AX or capture requests return `permission_denied` and `not_sent`. |
| Disabled host | All model requests fail before helper admission. Settings status remains readable and Stop remains available. |
| Wrong Core, generation, project, thread or call | A prepared plan cannot execute and observations cannot cross their owning session. |
| Changed arguments, reused or expired plan | No action is dispatched. |
| Changed AX value, removed element, moved window or old raster | No action is dispatched. A new observation is required. |
| Background target with event strategy | Only the helper's direct parent may hand the foreground to the retained, validated window after approval. Any third-party foreground fails without injected input. AX operations may succeed without activation. |
| Human approval input while idle | An untagged event whose annotated recipient is the helper's direct parent preserves the pending plan and epoch. The exact plan then activates its pinned window and sends the approved event. Unknown or external recipients still revoke the owner. |
| Host input during a mutation | An untagged host-recipient event revokes the action and releases held input, just like external input. A dispatched activation or event reports `possibly_sent` on failure. |
| Activation changes the focused control | The retained focused AX identity and element signatures are revalidated after handoff. No key or text reaches a replacement control; the dispatched activation reports `possibly_sent`. |
| Missing physical input monitor | Every mutation, including AX writes, fails with `takeover_unavailable`; observations remain available and status is not ready. A native fixture injects an unavailable monitor before any app lookup or input. |
| Physical user input | Active action is cancelled, held keys and buttons are released, and existing plans and observations are revoked. The same trusted turn cannot observe or prepare again. |
| Competing project during action or pending approval | The global lease rejects the competing project rather than interleaving input. |
| Stop, disable, cancellation or stdin closure during key hold or drag | The independent control lane releases held input immediately. A dispatched action reports `possibly_sent`. |
| Helper exit after execution submission | The host reports `possibly_sent` for a mutation and never retries. |
| Stop, disable, cancellation, host window loss, or helper restart | Previously admitted turns remain fenced with `human_control`; only status and Stop remain available. A new trusted turn can enter. |
| Physical takeover races a new observation | The private admission epoch prevents the stale request from entering native work before Main receives the takeover event. |
| Turn fence reaches 4096 owners | New owners fail closed with `owner_capacity`; no revoked owner is evicted or silently readmitted. |
| Unsupported strategy, clipboard format or AX action | Honest error, with no fallback that changes the approved operation. |
| Unicode selection | UTF-16 offsets select the expected range. |
| Screenshot coordinates | The raster's exact dimensions map to the captured window bounds, with pid, window and geometry revalidated. |

The full acceptance driver observes fixture truth for AX press, value, selection, focused Unicode typing, keyboard repeat and hold, clipboard text/Markdown/HTML, scrolling, drag, right/middle/multiple clicks and modifiers. Screenshot pixels and state travel through the real helper transport. GUI/Core Blob delivery and packaged permission identity belong to the integration acceptance run.
