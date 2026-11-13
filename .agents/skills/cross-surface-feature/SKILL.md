---
name: cross-surface-feature
description: 加一个用户能用的功能时，让它在 GUI、网页、手机、Agent 工具与定时任务里都成立，而不是只在测的那条路径上能用。
---

# 加跨端功能

## 放在哪一层

- 单个项目内的状态与操作放 Core；跨项目的放 Host（过渡期可放工作台服务）。
- 判断方法：这个功能在浏览器或手机里要不要用？要用就不能放进 Electron Main。
- 只有浏览器里没有的系统能力才进 Electron，并登记到 `clients/gui/packages/workbench/client/desktop-contract/shell-capabilities.cjs`，写明原因。

## 步骤

1. **协议**：在 schema 里定义请求、结果和错误码，Rust 与 TS 两侧一起改；已发布的手机端只认原方法表，新语义经 hello 协商。
2. **服务方法**：业务写成 Host/Core 的服务方法，界面、Agent 工具、定时任务都调用它，不写在界面处理函数里。
3. **界面**：一份 React 界面同时服务 GUI 与网页，走 Host 协议；不新增 IPC 业务通道。
4. **错误文案**：错误码在错误文案表里有用户能看懂的一句话，不把内部码外露。
5. **反向操作**：加了进去的路，也要有出来的路和看得见的状态。

## 过一遍每一端

交付前逐项说明是否适用：入口（对话视图、设置、命令面板、快捷键）；客户端（GUI、网页、手机）；连接方式（本机、中继、远程，多设备同时在线）；Agent 与定时任务；协议两侧；反向操作。

## 验证

- 协议与服务方法在最低一层写行为测试。
- 用户路径在网页旅程里验证（`test:web-journeys`，可在 `clients/gui/scripts/web-journeys.mjs` 加一步）。
- 用到 `shell` 能力的部分按 `mac-acceptance` 技能记入 Mac 验收。
