[中文](cordis.md) | **English**

# Cordis components and upgrades

The Runtime daemon assembles components through `cordis-rs` v3. Core, Supervisor and public protocols do not depend on Cordis types. See [components.rs](../../runtime/daemon/src/components.rs).

| Component | Ownership and shutdown |
|---|---|
| `RuntimeBundle` | Registers disposal immediately after installation and awaits cleanup in reverse order |
| `ExecutorPlugin` | Provides private ExecutorService and explicitly awaits backend shutdown |
| `SupervisorPlugin` | Injects ExecutorService, closes Scope admission and drains first |
| `RuntimeHost` | Owns Context and the bundle FiberHandle; exposes RPC only while Active |

`Context::spawn` does not automatically establish execution-resource cleanup ownership. After closing Scope admission, shutdown awaits Supervisor, executor and component disposal. Disposal alone cannot establish resource cleanup; failures return `CLEANUP_FAILED`. Cordis Scope/Fiber identities grant no Runtime permissions.

## Upgrade

The public Git `main` dependency in Cargo.toml is pinned by `Cargo.lock`; [pins.json](../../upstream/pins.json) records the same source. Builds and checks use `--locked`.

```sh
make update-cordis
make verify
make verify-runtime
```

Upgrade lockfile and pins together; inspect upstream Plugin, injection, cancellation and cleanup semantics. `make cordis-pin` only checks consistency. Roll back corresponding pin records together while preserving unrelated changes. Dynamic component loading, hot updates and ordinary plugin replacement of execution backends are unavailable.
