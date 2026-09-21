**中文** | [English](cordis.en.md)

# Cordis 组件与升级

Runtime daemon 使用 `cordis-rs` v3 装配组件；Core、Supervisor 和公开协议不依赖 Cordis 类型。实现见 [components.rs](../../runtime/daemon/src/components.rs)。

| 组件 | 所有权与关闭 |
|---|---|
| `RuntimeBundle` | 安装组件后立即登记 dispose，逆序等待清理 |
| `ExecutorPlugin` | 提供私有 ExecutorService，显式等待后端 shutdown |
| `SupervisorPlugin` | 注入 ExecutorService，先撤销 Scope 准入并 drain |
| `RuntimeHost` | 持有 Context 和 bundle FiberHandle，仅 Active 时开放 RPC |

`Context::spawn` 不自动建立执行资源的父子清理关系。Scope 关闭后依次等待 Supervisor、executor 和组件退出；dispose 完成不能替代实际资源清理确认，失败返回 `CLEANUP_FAILED`。Cordis Scope/Fiber 是组件身份，不授予 Runtime 权限。

## 升级

Cargo.toml 的公开 Git `main` 依赖由 `Cargo.lock` 固定提交；[pins.json](../../upstream/pins.json)记录同一来源。构建和检查使用 `--locked`。

```sh
make update-cordis
make verify
make verify-runtime
```

升级同时更新 lockfile 和 pins；检查上游 Plugin、注入、取消和 cleanup 语义。`make cordis-pin` 只核对，不更新依赖。回退需一起恢复对应锁定记录，保留其他工作改动。未开放动态组件加载、热更新或普通插件替换执行后端。
