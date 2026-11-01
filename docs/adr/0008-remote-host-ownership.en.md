[中文](0008-remote-host-ownership.md) | **English**

# 0008: Reuse desktop background ownership

> Ownership statements are superseded by [ADR 0016](0016-shared-host.en.md). The original decision remains below for context. Survival after GUI quit is a target design that requires shared Host acceptance.

The desktop already has a window-independent adapter and per-project Core/Runtime services. Place Remote Gateway in that adapter; keep authoritative sessions and execution in Core, with no new agent daemon or authoritative browser/Relay Session store.

This reuses discovery, credential custody, submission recovery and tool hosting instead of allowing competing task owners. P0 consequently requires the desktop adapter to remain running and does not promise availability before OS login or after shutdown.

Keep ADR 0001's module ownership. Supersede only its initial migration scope excluding mobile control after GUI exit: normal GUI exit may retain background Remote after this feature is implemented; OS exit and explicit service stop remain outside that promise.
