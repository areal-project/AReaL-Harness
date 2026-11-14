# AReaL Harness 开发指引

本文件适用于整个仓库，Claude 通过 `CLAUDE.md` 读同一份。当前用户指示优先于本文件，本文件优先于 Skills 和旧指南。这里是默认做法，不是硬性条款；某条和眼前任务冲突时说出来，经用户同意再越过。

## 所有权与沟通

- 这个代码库是你的：它为什么存在、怎么构建由你判断，你还会继续在它上面做下去。看到该删、该简化的就提出并动手，不因为“已经在那里”而保留复杂度；下面“先问”清单里的事项仍然先问。
- 开工前用一句话说明要做什么；过程中给简短进展，让用户跟得上。结束时写一段能独立成立的小结：发现了什么、做了什么、下一步是什么，只看最后一条消息的人也能了解全貌。

## 产品事实

- 产品处于前期 Beta，不支持降级。新版本可以要求一次停机导入，之后删掉兼容代码，不为旧数据、旧协议长期留两套实现。
- 分层与依赖方向是 Runtime → Core → Host → 客户端：
  - **Host**：每个系统用户一个（`core/host`），是所有客户端的唯一入口，负责登记、鉴权、跨项目查询、定时唤醒和凭据。过渡期由 Host 监督的工作台服务（Node 子进程）承接从 Electron Main 搬出的业务。
  - **项目服务**：每个项目一个（`core/service-host`），只管进程、锁、控制口和清理回执。
  - **Core**：每个项目一个（`core/app-server`、`core/engine`），是 Thread、Turn、Task 和回执的权威。
  - **Runtime**：工具执行、资源限制与清理（`runtime/`）。
  - **客户端**：GUI、网页、手机、TUI、CLI。端只是投影，不持有权威状态。GUI 与网页是同一份界面、同一套 Host 协议。
  - **Electron 外壳**：Main 与 preload，只放浏览器里没有的系统能力，全部登记在 `clients/gui/packages/workbench/client/desktop-contract/shell-capabilities.cjs`。
- 改职责或依赖时读 [架构文档](docs/design/architecture.md) 和 [ADR 0017](docs/adr/0017-one-protocol-one-ui.md)。

## 三种会伤到自己的操作

1. **按名字杀进程。** 不用 `pkill -f`、`pgrep | kill`，不杀按名称、命令行或工作树路径匹配到的 PID。只杀本次启动时记下的 PID，或按本次临时目录认领的进程。
2. **写真实安装的数据。** `~/.areal` 和 `~/Library/Application Support/AReaL Harness GUI` 是用户正在用的数据。可以读、可以复制，不对它启动服务、不读写打开、不清理。测试一律用隔离目录：`AREAL_GUI_USER_DATA`、`AREAL_CORE_HOME`、`AREAL_HARNESS_SERVICE_HOME`、`AREAL_HARNESS_HOME`。要真实数据就复制一份进隔离目录，只往里流不往回写，不用软链。
3. **把地址和凭据写进产物。** 本机 WebSocket 的地址、端口不写进构建产物。凭据和票据不进日志、URL、命令行参数或提交。

## 按任务指路

| 要改的东西 | 先读 |
| --- | --- |
| 分层、模块职责、目录 | [架构文档](docs/design/architecture.md)、[ADR 0017](docs/adr/0017-one-protocol-one-ui.md) |
| 协议、Host 方法、客户端接入 | `core/protocol/`、`core/host/`、[本地服务契约](docs/api/local-service.md) |
| GUI 页面、组件、样式、文案 | [设计系统开工顺序](clients/gui/design-system/README.md#开工顺序)，例外与证据按 [完成条件](clients/gui/design-system/governance.md#完成条件) |
| GUI 启动、数据隔离、安装包 | [GUI 指南](clients/gui/README.md) |
| 对话、Composer、设置、文件/Diff 面板 | `clients/gui/renderer/src/`、`clients/gui/packages/workbench/` |
| Electron 窗口、原生预览、凭据 | `clients/gui/app/src/` |
| 手机与远程网页 | `clients/mobile/`，[iOS](docs/development/ios-development.md) / [Android](docs/development/android-development.md) 指南 |
| 工具、上下文、提示词、恢复、调度、默认预算 | [Agent 改进方法](docs/development/agent-improvement.md) |
| 测试分层、云端能验到哪一步 | [测试指南](docs/development/testing.md)、[Agent 工作环境与验证分层](docs/development/agent-environment.md) |
| 格式、静态检查、依赖安装 | [开发指南](docs/development/README.md)、`make help` |

## 任务边界

### 可以直接做

- 范围内的本地修改、构建、隔离目录下的测试和 E2E，修复本次改动造成的失败。
- `make build`、`make check*`、`make test*`、`make lint`、`make fmt`、`make gui-*`、`make baseline-diff`、`pnpm --dir clients/gui …`。

### 先问

push 到受保护分支、发布、使用真实凭据、写外部系统、破坏性 Git 操作、大范围删除、改 Core Store 格式或迁移契约、移动数据目录、改 CI 必需检查与 hooks。用户已授权的不重复索取。

### 架构约束

- 客户端要用的业务只经 Host 协议提供：跨项目的放 Host（过渡期可放工作台服务），单个项目内的放 Core。判断方法：这个功能在浏览器或手机里要不要用？要用就不能放进 Main。
- 跨层修改先明确写入与读取所有者、目标身份、代际和完成信号；调用方复用现有适配器，不各自猜测身份或结算状态。
- 新的 Electron 能力先登记进 `shell-capabilities.cjs` 并写明原因；`transitional` 只减不增。
- Main 只承载登记的原生能力和必要协议适配。`gui-health` 的行数、规模及逐文件变化作为职责审查信号，不因增长单独失败；修复过渡模块不要求先整体迁移，不用无关删除或压行抵消增长。职责、依赖边界和类型覆盖仍是硬检查。Main 新增文件用 TypeScript，构建为 CommonJS。
- Renderer 不导入 Node/Electron，不读已保存的凭据，不跑 Agent 执行循环。只有平台适配文件能碰 preload 对象。
- 恢复用权威快照，不重放不确定是否已受理的提交。停止受理不等于后台已终止。
- 只改受控源码和 `clients/gui/patches/`，不改 `node_modules`。

### 过渡代码

- 名字带 legacy、compat 的代码和过渡开关，旁边写一行“过渡：到 <版本> 删”。`make check-transitional` 检查，到期报错。
- 不写新旧实现对照测试；旧实现删掉时它的测试一起删。
- 历史数据缺证据时只在那条记录上标 UNKNOWN，不阻塞当前功能，不禁用项目、跳过测试、放宽断言或删数据来绕过。

### 每一端都要过

最常见的缺陷是改动在你测的那条路径上能用，在其他地方缺失。交付前过一遍并说明哪些项适用：

- **入口**：对话视图里能做的事，通常在设置页、命令面板和快捷键里也能做。
- **客户端**：GUI、网页、手机。新功能要么在浏览器里可用，要么在壳能力清单里标为桌面专属并写明原因。
- **连接方式**：本机、中继、远程；多设备、多项目同时在线是真实场景。
- **Agent 与调度**：用户能触发的能力，Agent 工具和定时任务通常也要能触发，所以做成服务方法，不写在界面处理函数里。
- **协议**：跨进程传的东西在 schema 里定义，Rust 和 TS 两侧一起改。
- **反向操作**：加了进去的路，也要有出来的路和看得见的状态。

### Agent 行为改动

- 遵循 [Agent 改进方法](docs/development/agent-improvement.md)：从失败证据提出可证伪的假设，在共享边界修复整类问题，不为单题加架构。
- 不按题号、Benchmark 名称、答案、隐藏评分器或私有路径选解法、注入提示或切换预算。
- 回归测试通过、局部提分或工具成功率不等于整体能力提升；泛化结论要开发集对照和隔离来源确认。不为评分放宽隔离、改隐藏断言或加隐式重试。

## 验证与汇报

- 改动是不是你造成的，用 `make baseline-diff BASE=<基准> CMD='<测试命令>'` 判断：基准上就红的不算你的，“基准通过、现在失败”的才是回归。不要为基准上的红去改别人的代码。
- 推送钩子运行快速受影响检查；慢检查与跨平台验收交 CI。按实际影响补充本地专项，完整入口见[测试指南](docs/development/testing.md)。
- 业务旅程优先在网页上验证（`test:web-journeys`）；只有壳能力清单里的 `shell` 项需要桌面，签名、钥匙串、自动更新、真实数据升级、手机配对、系统权限留到 Mac 验收。
- 测试清单按 `requires` 跳过当前环境缺能力的项。跳过不等于通过，汇报时列出来。
- 状态、持久化、权限、协议和竞态修复在最低能失败的层级提供行为证据，能复现时先证明旧代码失败。业务旅程同时断言权威执行结果和用户可见结果；故障注入先证明命中本次请求。纯视觉改动用前后截图，不测类型保证或 mock 调用镜像。
- 异步验收等权威事件、回执或状态。同类失败再次出现时先核对共享边界、观察点与夹具；没有新证据就重查假设，不延长超时或重跑碰运气。
- 新加的脚本要有入口（package.json、测试清单或 Makefile），`make check-refs` 会拦没有入口的脚本和断掉的路径。
- 汇报先说用户能得到什么，再说证据和没做到的部分。源码、安装包、真实服务和真机的证据互不替代；没执行的检查如实说明。

## 文档

- README、CONTRIBUTING、SECURITY 和 `docs/` 下的 Markdown 以 `.md`（中文）和 `.en.md`（英文）成对维护，首行互链，`python3 scripts/check-docs.py` 检查。
- 契约或用法变化时同一 PR 里改：架构 → `docs/design/architecture.md`；API → `docs/api/`；使用部署 → `docs/guides/`；开发 → `docs/development/`；能力 → `docs/features.md`。README 只做简介与导航。
- 加一段文字前先问：维护者没有它会做错什么？读代码就能回答的就不写。不写日期、对话流水或未验证的能力。架构图遵循 [图表规范](docs/design/STYLE_GUIDE.md)。

## 仓库技能

`.agents/skills/` 下按任务选用：`testing`（选测试、判断是否回归和报告未执行阶段）、`ci`（检查计划、并行调度、证据和门禁）、`remove-compat`（删过渡代码）、`cross-surface-feature`（加跨端功能）、`mac-acceptance`（交 Mac 验收）。

## 风格

- 沿用仓库格式。新注释用中文，只解释代码表达不了的约束。类型推断优先，避免 `any`。
- 提交和 PR 说明问题、做法和验证结果。
