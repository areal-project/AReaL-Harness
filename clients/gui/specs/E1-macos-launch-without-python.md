# E1（P0）：macOS 启动链去除 `/usr/bin/python3` 硬依赖

## 1. 背景与当前问题

macOS 上，GUI 和共享服务都把系统 `/usr/bin/python3` 作为 Core、Runtime、service-host 和 launcher 的实际父进程：

- GUI：通过 Host 连接 Core，产品中不再保留 JS `spawnCore`；启动监督统一使用 [native_process.rs](../../../core/local-service/src/native_process.rs)。旧 JS 桥仅供隔离测试夹具，不再是产品路径。
- 共享服务：`core/local-service/src/native_process.rs` 在 `cfg(target_os = "macos")` 下 `Command::new("/usr/bin/python3")`，并通过内联 `BRIDGE` 脚本转交描述符、PID 握手和退出回执。
- 文档已经写明这项要求：[GUI 指南](../README.md) 和 [安装指南](../../../docs/guides/installation.md) 都要求先装 Xcode Command Line Tools。

影响：没装 Command Line Tools 的 Mac 上，`/usr/bin/python3` 只是一个桩，执行时会弹出系统安装对话框，Core 无法启动。对桌面产品来说，这是首次启动就失败。

关键缺口：**这个依赖存在的根因没有写进任何文档**。架构文档只说"以满足本地可执行文件的启动约束"。不知道根因就删掉，很可能重新触发原问题。

## 2. 目标与非目标

目标：

- 阶段 0（确定性）：缺少 Python 时给出明确的引导，而不是直接失败。
- 阶段 1（不确定性）：查清根因，写成决策记录。
- 阶段 2：用随包分发、经过签名的原生组件替代 Python 桥。GUI 和共享服务共用同一个实现。

非目标：不改变 Runtime 的沙箱（Seatbelt）、Scope 权限、进程清理语义；不改变 Linux 的启动拓扑。

## 3. 架构决策

| 决策 | 状态 | 内容 |
| --- | --- | --- |
| D1：阶段 0 先加预检 | 已定 | GUI 启动时检查 `/usr/bin/python3 -c 'print(1)'` 能否正常执行（`xcode-select -p` 只能作为辅助信号）；失败时进入引导页，提供"安装 Command Line Tools"按钮（调用 `xcode-select --install`）和重新检测；不再进入半启动状态 |
| D2：替代方案只有一个实现 | 已定 | Rust 和 GUI 两条路径都改为调用同一个随包二进制（暂名 `areal-spawn-bridge`，放在 `libexec/areal`），由它承担 BRIDGE 脚本的全部职责：描述符白名单、PID 握手、进程组/会话、信号转发、退出回执 |
| D3：替代机制的选型 | **待 spike** | 候选见第 5 节；根据根因选择，不预设 |
| D4：Python 桥保留到替代方案通过验收 | 已定 | 新旧路径用部署配置切换；新路径在干净环境验收通过前，默认仍走旧路径 |

## 4. 确定性路径（阶段 0）

1. 在 GUI 的启动恢复链（Main 初始化、加载页）加入预检；预检失败时显示结构化错误（复用 `nativeText` 的 i18n）。
2. 共享服务已有"启动前检查可用性并返回明确错误"的逻辑（`native_process.rs` 中的 PID 握手失败信息）。GUI 识别这个错误，展示同一个引导页，不显示原始 stderr。
3. 引导页遵循设计系统的 P-DECISION / Feedback 模式（见 [设计系统](../design-system/README.md)），文案经过 [界面文案](../../../design/content/interface-copy.md) 规范检查。
4. 新增 smoke：用一个不可执行的 Python 路径模拟缺失（通过测试专用的环境变量注入路径，生产构建忽略该变量），断言出现引导页，并且没有任何 Core 进程残留。

## 5. 不确定性路径（阶段 1 spike，时间盒 3 个工作日）

假设（每条都给出证伪方法）：

| 假设 | 内容 | 证伪 / 证实方法 |
| --- | --- | --- |
| H1 | Electron（hardened runtime）直接 spawn 本地构建或 ad-hoc 签名的二进制，会被 AMFI 或 launch constraint 杀掉；由平台二进制作为父进程可以绕开 | 去掉桥直接 spawn，分别在开发构建、签名+公证包两种形态下运行；采集 `log show --predicate 'subsystem == "com.apple.amfi" OR process == "kernel"' --last 5m` |
| H2 | 跟 TCC 的 responsible process 归属有关：子进程会继承 GUI 的隐私授权身份（屏幕录制、辅助功能、文件访问），需要切断 | 直接 spawn 后，观察 Runtime 访问受保护目录时系统提示里显示的应用名；用 `launchctl procinfo <pid>` 查看 responsible pid |
| H3 | 跟进程组、会话、描述符继承语义有关（Node `spawn` 无法精确控制 fd 白名单，也无法 setsid/setpgid） | 对照 BRIDGE 脚本逐项列出职责，用最小的 C/Rust 程序复现，确认哪一项是 Node 和 Rust `Command` 做不到的 |
| H4 | 跟隔离属性（quarantine）或 Gatekeeper 首次运行检查有关 | 对下载包执行 `xattr -l`，比较带和不带 `com.apple.quarantine` 时的行为 |

要求：

- 先完整读一遍 BRIDGE 脚本（Rust 和 GUI 两份），列出职责清单。职责清单是替代方案的验收输入。
- 查 git 历史（`git log -S '/usr/bin/python3'`），找到引入时的提交说明。
- 每个假设记录：实验步骤、环境（macOS 版本、签名状态、构建形态）、原始日志、结论（证实 / 证伪 / 不确定）。

候选替代机制（由 spike 结论决定）：

| 候选 | 适用的根因 | 代价 |
| --- | --- | --- |
| A：同 Team ID 签名的 Rust 小二进制，用 `posix_spawn` 加属性控制 | H1 / H3 | 需要进签名、公证流程；H2 场景需要 responsibility disclaim，而这是未公开 API，风险需要评估 |
| B：由 `SMAppService` / launchd agent 托管服务进程 | H2（让服务不再是 GUI 的子进程） | 生命周期模型变化大，需要和 Host 代际、单写者锁对齐 |
| C：保留 Python，但改为随包分发的独立解释器 | 仅当根因要求"非 Electron 签名身份的父进程" | 包体积增加，许可证和安全更新成本高 |

停止条件：时间盒用完还没有证实任何一个假设，就提交证据报告并停下，交由人决定是否延长；不能在没有根因的情况下直接实施候选方案。

产出：`docs/adr/` 下新增一篇中英配对的决策记录，写明根因、证据、选定方案和被否决的方案。

## 6. 实施切片

1. PR-1（阶段 0）：预检、引导页、smoke。
2. PR-2（阶段 1）：spike 证据和 ADR，只有文档，不改生产代码。
3. PR-3（阶段 2）：`areal-spawn-bridge` 二进制和单测，复刻 BRIDGE 的职责清单；先接入 Rust `native_process.rs`，通过部署配置切换。
4. PR-4：GUI `core-process.cjs` 接入同一个二进制；更新安装指南、GUI 指南、开发指南、架构文档，删掉"需要 Command Line Tools"的产品运行要求（开发构建仍然需要）。
5. PR-5：新路径成为默认，旧 Python 路径保留一个版本周期后删除。

## 7. 验收标准

确定性：

- [ ] 阶段 0：模拟缺少 Python 时，引导页出现，没有残留进程，smoke 通过。
- [ ] 阶段 2：BRIDGE 职责清单里的每一项都有对应的自动化测试（描述符白名单、PID 握手、信号转发、退出码和信号回执、桥退出时清理直接子进程）。
- [ ] 阶段 2：现有的 `test:core-process`、`test:lifecycle`、`test:desktop-exit` 和 Rust `core/local-service` 测试全部通过。
- [ ] 产品代码路径中不再出现 `/usr/bin/python3`：`grep -rn '/usr/bin/python3' clients/gui/app core/local-service/src core/service-host/src` 只剩测试和开发脚本。

不确定性（需要人工在真实环境验证）：

- [ ] 在干净的 macOS VM（未装 Command Line Tools，新用户账户）上安装签名包：首次启动到可以输入的过程中，没有任何系统安装对话框。
- [ ] 用 `sudo eslogger exec`（macOS 13+）抓取启动期间的进程执行事件，确认没有执行 `/usr/bin/python3`。
- [ ] 隐私授权（屏幕录制、辅助功能）的归属身份与旧路径一致，或按 ADR 的预期变化。

## 8. 防复发约束

| 层 | 条目 |
| --- | --- |
| L1 规则 | `AGENTS.md`：产品运行时不得依赖宿主上未随包分发的解释器或工具；需要时必须写 ADR，并在启动预检中声明 |
| L2 Skill | `.agents/skills/spike/SKILL.md`：通用 spike 模板（假设 → 证伪方法 → 时间盒 → 证据 → ADR），本任务是第一个使用者 |
| L3 Lint | 在 `clients/gui/app/src` 中禁止出现 `/usr/bin/python`、`/usr/bin/env python` 字面量（`no-restricted-syntax`，匹配字符串字面量） |
| L4 CI | 新增"宿主依赖清单"检查：扫描 Rust 和 GUI 产品代码里对绝对系统路径的 `spawn` / `Command::new`，与 `docs/guides/installation.md` 中声明的依赖清单比对，未声明的依赖使检查失败 |
| L5 棘轮 | `health-baseline.json` 增加 `hostInterpreterSpawns`（方向：down，目标 0） |

## 9. 风险与回滚

- 替代二进制的行为和 BRIDGE 有细微差异，导致进程泄漏或退出码丢失：用职责清单测试覆盖，并通过部署配置随时切回旧路径。
- 签名和公证流程变化：PR-3 起在 release workflow 里加入新二进制的签名校验步骤。
