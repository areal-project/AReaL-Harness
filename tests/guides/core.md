# Core、Host 与桌面后台

适用：`core/`（Host、Core、Runtime、协议）、`services/workbench/`（桌面后台与领域）、`schemas/`。

## 准备

- `make build`：产出 `target/debug/areal`、`areal-runtime` 等。冒烟和后台都依赖它。
- `node clients/gui/scripts/build-snapshots.mjs`：生成 `services/workbench/src/generated/host-library-store.cjs`。缺它时后台起不来，Host 只报 "workbench ready timed out"。
- `pnpm --dir clients/gui install --frozen-lockfile`：后台测试解析 `@areal/workbench-service` 需要。

## 由小到大

1. 单元测试，改什么跑什么：
   - `cargo test -p areal-host --lib <名字片段>`
   - `cargo test -p areal-app-server --test <名字>`、`make test-core`、`make test-protocol`
   - `node --test services/workbench/test/<文件>.test.cjs`
2. 协议生成物：`python3 scripts/generate-host-protocol.py --check`。改了 Host 方法或 schema 必跑。
3. 契约：`pnpm --dir clients/gui test:host-protocol-conformance`、`test:host-client`。
4. 真实进程冒烟（隔离 home，确定性模型）：
   - `node scripts/shared-host-smoke.mjs`、`shared-host-schedule-smoke.mjs`
   - `pnpm --dir clients/gui test:workbench-backend`：Host 拉起桌面后台、资料库写回执、崩溃重启、Main detach、Host stop。
   - `pnpm --dir clients/gui test:host-seed-copy`；需要真实数据形状时用 `seed-host-copy.mjs` 从 `~/.areal` 只读复制到临时目录。
5. 收尾：`cargo fmt -p <crate> -- --check`、`make check-changed`（显式 `CI_BASE`）。

## 写测试

- Bug 先写一条在旧代码上失败的测试，再修。放进已有测试文件里最接近的用例。
- 等事件、回执或子进程退出，不用 sleep 和超时轮询。
- 进程类问题（EOF、超时、重启退避）在 `core/host/src/workbench.rs` 这类监督代码旁写测试，不放到冒烟里才发现。

## Linux 容器的限制（留给 Mac 本机）

- 以 root 运行时 `chmod 0o500` 拦不住写，Host 的写失败注入测试会失败。
- Linux Core 不支持权限模式，`test:workbench-backend` 在"新建聊天"处停下。
- 需要锁定 `AREAL_CORE_BIN` 的用例、经 Relay 的一致性（要 Node ≥ 24.2）、`make verify-native`。

跑不了的记进 `/mnt/project-files/one-protocol/codex-本机待跑.md`，写清命令和原因。
