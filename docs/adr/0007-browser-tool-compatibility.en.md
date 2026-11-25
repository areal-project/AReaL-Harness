[中文](0007-browser-tool-compatibility.md) | **English**

# Preserve Threads with explicit append-only tool attachment and observer subscriptions

**Status: accepted; fixed Browser v1 bundle attachment and observer subscriptions are implemented.**

Attaching the browser to an existing Thread preserves its tool definitions, while thread/resume also concerns host binding. Use bounded idle-time attachment for the trusted Browser v1 bundle and atomic observation without ToolHost rebinding. When the user sends a new message to an idle older chat, the GUI appends the fixed bundle subject to capability negotiation. This neither reads a page nor resumes old requests. Only an actual Browser call approved by Core claims the page. Attachment never replaces existing tools. Keep the dispatcher envelope fixed; capabilities and strict secondary schemas govern supported operations. The [business tool update API](../api/core.en.md#dynamic-tools) cannot replace the dispatcher either.

## Considered options

New-Thread-only support is cheapest but loses existing context. A global built-in browser registry broadens Core responsibilities, and replacing tool tables invalidates recorded execution. Choose bounded attachment, not a general runtime tool editor.

## Consequences

This is an explicit Core protocol/persistence change requiring capability negotiation, requestId deduplication, idle checks, conflicts, recovery and old-client tests. Only a deployment-registered bundle may be attached, never model-provided tools. Preserve previous definitions and history. Observer attachment grants projection only, not tool-host execution.

Related: [spec](../design/browser.en.md), [contract](../api/browser.en.md).
