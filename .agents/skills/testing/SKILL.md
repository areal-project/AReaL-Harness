---
name: testing
description: 为 AReaL Harness 的改动选择并运行合适的测试（Core/Host、CLI、TUI、网页、Electron、手机），判断失败是不是本次改动造成的，并如实汇报没跑的部分。
---

# 测试

先判断改动落在哪一层，只读对应的指南。命令、前置条件和平台限制都写在 `tests/guides/`，这里不重复。

## 选指南

| 改动落在 | 读 |
| --- | --- |
| `core/`（Host、Core、Runtime、协议）、`services/workbench/`、`schemas/` | `tests/guides/core.md` |
| `clients/cli/` | `tests/guides/cli.md` |
| `clients/tui/` | `tests/guides/tui.md` |
| `clients/gui/renderer/`、`clients/gui/packages/`、网页 | `tests/guides/web.md` |
| `clients/gui/app/`（Electron Main 与 preload） | `tests/guides/gui.md` |
| `clients/mobile/` | `tests/guides/mobile.md` |

跨层改动每层各读一份。界面逻辑在网页上测完；只有 `shell-capabilities.cjs` 里标为 `shell` 的系统能力才需要启动桌面。

## 怎么跑

1. 环境不全先跑 `make agent-setup`；`target/agent-env.json` 列出本机具备的能力，测试清单按 `requires` 跳过缺的项。
2. 从最低能复现的一层验证，再覆盖必要的真实边界。
3. 可复现的 bug 先证明旧代码因目标行为失败，再修；同类失败先核对共享边界、观察点与夹具。
4. 等本次请求的权威事件、回执或退出；夹具入口见 [测试指南](../../../docs/development/testing.md)，保留权威结果与 UI 断言。
5. 业务旅程跑 `pnpm --dir clients/gui run test:web-journeys`；Linux 无显示时用 `xvfb-run`。
6. 推送运行仓库快检；完整验收入口见上述指南。

长验收按阶段记录 `firstFailure`、`reached`、`unreached` 和 `cleanup`。前置条件失败只能报告为前置阻断，不能算目标业务失败；未执行阶段不能算通过。跨层状态必须同时核对正确的 Core/Host 身份、Renderer 投影和用户可见结果，不能用旧 Main 快照或空的 `pending` 列表代替权威事件。

## 失败是不是你的

```bash
make baseline-diff BASE=<基准分支> CMD='<同一条测试命令>'
```

只有“基准通过、现在失败”才是你的回归。基准上就红的列进汇报，不要顺手去改别人的代码。

## 必守

- 不对 `~/.areal` 或真实应用数据启动服务；测试用隔离目录，要真实数据就复制一份进去。
- 只结束自己启动时记下 PID 的进程。
- 凭据、配对票据、本机地址不进日志、命令行参数、构建产物或提交。

## 汇报

分三类：跑过且通过的（附命令）；跑过但失败的（附关键输出，并说明基线对照结论）；没跑的（附原因，需要 Mac 的按 `mac-acceptance` 技能记下）。
