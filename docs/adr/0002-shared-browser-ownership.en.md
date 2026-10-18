[中文](0002-shared-browser-ownership.md) | **English**

# Provide the Shared Browser through the existing desktop ToolHost

**Status: proposed; not implemented**

Core already owns history while Main owns native pages. Route Core dynamic-tool callbacks through the independent desktop adapter to the existing live page. Core does not depend on Electron and Main runs no agent loop. This preserves one history writer and existing transport, at the cost of Browser availability when GUI resources disappear even though Core survives.

## Considered options

Moving the browser into Runtime couples its OS execution protocol to native UI. A separate agent-browser or Ego Lite application splits the current user page. Either can become a separate provider only for a later explicit requirement.

## Consequences

Record execution as client-backed. Adapter liveness does not prove Main/page availability. Separate tool-host ownership from observation subscriptions. GUI exit must preserve unrelated Core work.

Related: [spec](../design/browser.en.md), [contract](../api/browser.en.md).
