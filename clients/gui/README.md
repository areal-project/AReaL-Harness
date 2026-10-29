**中文** | [English](README.en.md)

# AReaL Harness GUI

完整桌面客户端：React renderer、Electron 原生适配器与公开依赖。与 CLI/TUI/Web 同属 Clients 层；Core 持有会话、历史、模型循环和定时任务，Runtime 执行工具。iOS Remote 客户端位于 `clients/mobile`，复用本 workspace 的协议与会话组件，见 [iOS 开发指南](../../docs/development/ios-development.md)。

工程检查沿用现有 Vite+ 入口。`pnpm --dir clients/gui health` 检查生产源码尺寸、采用率及存量债务；`verify:tests` 校验根包测试清单，`test:unit` 运行 Renderer 与 UI 包的纯行为测试。`node clients/gui/scripts/run-portable-tests.mjs` 按清单选择当前平台上不需要 Core 或原生界面的测试。Linux CI 的配置不表示本机已经完成 Linux 验收。

测试注册、领域选择、平台前提和重复资格命令见[测试指南](../../docs/development/testing.md#gui-测试清单与平台资格)。新测试必须登记；临时目录使用 `scripts/support/temp.mjs`。`test-manifest.mjs --ci-matrix --base=<commit>` 从清单选择现有 macOS smoke；未知或共享路径保留全量。Linux 五条核心旅程各 10 次、macOS E2E 各 5 次通过 `repeat-tests.mjs` 运行并保留首跑结果。Linux 通过率至少 95% 且无阻塞才有资格提交人工审阅；未执行的 CI、blocked 环境和单元检查不能代替桌面验收。

生产构建生成 `renderer/dist/bundle-analysis.json`，记录实际 chunk 的模块、静态依赖与哈希。`verify:bundle` 检查 HTML 入口的完整静态闭包、总 JS 及延迟 chunk 预算。`bundle-budget.json` 初始保留 5% 字节余量；`node clients/gui/scripts/bundle-budget.mjs --write` 只允许收紧预算。健康基线更新也只允许改善，CI 会检查相对基准提交的放宽。检查器和基线的限制见 [spec 源码核查](specs/implementation-decisions.md)。

使用情况设置在打开时按需加载，加载期间使用现有设置页的等待文案；它不属于桌面首屏静态依赖。

Web/PWA Remote v2 的实施边界见[架构](../../docs/design/remote-control.md)、[API](../../docs/api/remote-control.md)、[连接与部署](../../docs/guides/remote-control.md)及[验收计划](../../docs/development/remote-control-testing.md)。源码已实现默认关闭的入口、浏览器申请与桌面确认、显式项目授权及设备撤销，以及工作概览、会话详情、创建与发送、精确轮次停止、审批和问题回复、任务暂停及结果审查。Direct 与独立 Relay 共用 Host 授权和加密协议；容器部署脚手架见 [Relay 部署](../../services/remote-relay/deploy/README.md)。源码实现不代表真实手机、生产浏览器 TLS、公网网络、系统钥匙串或安装包验收通过，各层仍需独立证据。

新增、修改或评审页面前，Agent 从[设计规则 v1](design-system/README.md)进入[证据驱动设计流程](design-system/structured-flow.md#执行顺序与每步完成条件)：固定合同与参考，视频提名候选，关键帧/日志核查，筛选差异，再复用现有所有者实现、验收并更新规范；Token、交互合同和预览见[客户端设计系统](design-system/README.md)。

GUI 工程化与设计系统的 P0/P1 整改任务拆分为可交接的 [整改 Spec 包](specs/README.md)，每份写明当前问题、架构决策、验收标准与防复发约束；Spec 描述整改目标，不代表已实现行为。

真实Electron对话专项从仓库根运行 `node clients/gui/scripts/migration-smoke.mjs --conversation-journey`；先构建并核对Core/Runtime及renderer。覆盖命令、子代理、图片、阅读/收敛、暂停UNKNOWN核查与GUI历史恢复；外部模型为本地确定性SSE。证据与注入边界见[真实Electron专项](design-system/exercises/conversation-flow.md#真实-electron-专项-e1)。
生产UI包接入专项为 `node clients/gui/scripts/migration-smoke.mjs --conversation-production`：覆盖顶部任务卡片、Sources三项/全部、子代理列表与真实历史返回、工具图片/活动人工展开、窄桌面、暂停、Core返回UNKNOWN时的核查及Renderer历史重载不重放。沿相同隔离Electron/Core/Runtime与本地模型；它不代替完整专项末尾的活动任务退出后后台完成合同，也不代表安装包或真实供应商验收。

连续动效专项沿用同一入口的 `--conversation-motion`，保留原始 CDP 帧、RAF/输入/阅读观测并验证展开反向、资源进退和减少动态效果；边界与复验要求见[E2 专项](design-system/exercises/conversation-flow.md#真实-electron-连续动效专项-e2)。

宿主与新内容专项使用 `--conversation-host`，验证真实窗口尺寸/125%缩放、子代理与设置焦点返回、草稿和快捷键；原生中文输入法通过独立操作步骤取证。见[E3专项](design-system/exercises/conversation-flow.md#真实-electron-宿主与新内容专项-e3)，[E4补充](design-system/exercises/conversation-flow.md#原生宿主补充-e4)通过 `AREAL_E4_NATIVE=1 AREAL_E4_OPERATOR=0` 复验同应用窗口往返、独立原生网页交互/隐藏与焦点返回。人工阶段需省略 `AREAL_E4_OPERATOR=0` 并保留实际操作证据；未触发的候选浮窗不计通过。

现有对话目录入口为 `design-system.html?conversation`，复用生产消息、输入区与可返回的资源面板；`pnpm --dir clients/gui test:design --conversation-demo` 专项检查该样板。迁移与旧新版同状态对照边界见[对话目录迁移](design-system/exercises/conversation-flow.md#现有对话目录迁移样板)。

## 开发

从仓库根执行，需 Node.js 22.19+（22 LTS）、24.11+（24 LTS）或 26+、pnpm 11.7.0 及仓库 Rust 工具链；建议构建和验收均使用与 CI 一致的 Node.js 24.22.1 LTS：

```sh
make build
make gui-install
make gui
```

`make gui-build` 构建 renderer 前先执行 `pnpm install --frozen-lockfile`；`make gui` 和 `make gui-package` 复用这一步，自动同步切换分支或版本更新后的依赖与安装记录。锁文件不匹配时停止，不自动更新锁文件。`pnpm --dir clients/gui typecheck` 检查 Renderer、共享桌面契约及全部自有 Electron Main 源码。Main 的 CJS/JS 文件逐文件启用 `@ts-check`，避免把导入的第三方源码纳入同一审计范围。`pnpm --dir clients/gui run verify` 检查公开文件边界。`pnpm --dir clients/gui contracts:check` 只读核对桌面管理契约生成物；生成器复用 `schemas/areal-core-v1.json` 和实际路由，对源码与 schema 的已知差异在生成器中注明生产者。完整命令校验器在首次命令调用时按需加载，加载和请求校验成功后才提交。初始界面复用轻量传输错误与页面消息合同。独立运行 Node 测试前，先执行 `pnpm --dir clients/gui build:desktop` 构建浏览器自动化、浏览器数据与交互内容包的入口；CI 同样在测试前执行此步骤。此模块单独锁定 pnpm 依赖，不改变仓库 SDK 的 npm 工具链。依赖来自公开 npm registry；Electron 和 Core 工具首次安装需网络。

Vite+ 1.4.0 提供本地检查和任务编排，不需要安装全局 `vp`。`pnpm --dir clients/gui check` 对相对 `HEAD` 的最终工作区改动与未跟踪文件运行 Oxlint 和 Oxfmt，并将 lint 告警视为失败。它检查整个改动文件，不是只检查改动行。提交后请设置 `AREAL_CHECK_BASE=<基线提交>` 检查分支改动；CI 必须提供 `AREAL_CHECK_BASE` 或已有的 `AREAL_DESIGN_BASE`，缺失或不可用时失败。手动运行 GitHub `GUI checks` 时，可通过 `comparison_base` 指定已存在的祖先提交作为集成比较起点；未指定时沿用上一提交。此命令不暂存、stash 或改写文件。`pnpm --dir clients/gui check --fix` 显式修复选中文件。

`pnpm --dir clients/gui check:all` 检查所有自有源码，供存量问题盘点。当前存量未批量格式化，全量检查可能失败。直接检查指定文件使用 `pnpm --dir clients/gui exec vp check <文件路径>`；`lint` 和 `fmt` 分别运行 Oxlint 和 Oxfmt。生成目录、构建产物及第三方静态资源不参与检查，Markdown、锁文件与依赖补丁不参与格式化。GUI 类型检查和 UI 声明构建使用 TypeScript 7.0.2 原生 `tsc`。Renderer 与 UI 的 AST、`transpileModule` 和生成脚本通过 `typescript` 别名使用 `@typescript/typescript6@6.0.2` 兼容包；当前锁文件将其 API 和 `tsc6` 固定到 TypeScript 6.0.3，与原生 `tsc` 并存。仓库 SDK 的独立 npm 项目保留其原有编译器。

`pnpm-workspace.yaml` 为[受支持的 Vite+ 别名](https://viteplus.dev/guide/migrate)记录精确的 peer 元数据兼容例外。core 1.4.0 仅放行 React 插件 5.2.0、Tailwind Vite 插件 4.2.2、Vitest 5.0.5 及其 mocker 5.0.5；实际 core 导出的 Vite 版本为 8.3.5。Typography 0.5.19 另行接受 Tailwind 4.2.2，因为其发布的 peer 范围包含不符合 semver 的 `insiders` 标签。这些条目不改写包版本，也不关闭其他 peer 检查。更新任一相关版本前，重新验证对应构建、HMR、排版样式输出及测试运行器。

`build`、`build:desktop`、`design:build`、`verify`、`verify:design` 和 `typecheck` 由根 `vite.config.mts` 的 Vite+ 任务编排。UI、浏览器自动化、浏览器数据与 Gen UI 构建显式跟踪源码、构建配置和锁文件，Gen UI 同时跟踪资源及其摘要清单；缓存命中时恢复各包的 `dist`。renderer 的生产和设计构建每次执行，分别写入 `renderer/dist` 与 `dist/design-system`。它们消费 GUI 工作区外的共享 CSS 和设计站图片；当前任务缓存不能可靠跟踪或显式声明这些路径，因此不缓存 renderer。Swift 原生 helper 依赖本机 Xcode、SDK 和签名环境，每次构建。Git 基线审计和测试也每次执行，缓存成功日志不代表新一轮验收。GUI CI 保存本地任务缓存。需要排除缓存影响时，从 `clients/gui` 运行 `pnpm exec vp run --no-cache verify-suite`。需要清空缓存时运行 `pnpm exec vp cache clean`。

Renderer 的 `dev`、`build`、`design:dev` 和 `design:build` 使用本地 `vp dev/build`，配置从 `vite-plus` 导入。workspace 将 `vite@*` 固定到匹配版本的 `@voidzero-dev/vite-plus-core`，让插件共享 Vite 实例；浏览器类型引用使用 `vite-plus/client`。普通与设计开发模式共用已知 workspace CommonJS 依赖的预打包列表。Electron 继续加载构建后的 `renderer/dist`，开发服务器仅用于浏览器，不自动接入桌面窗口。桌面包构建器、`node --test`、签名与公证流程保持原有入口。

`make gui-install` 按锁文件安装依赖后，显式运行 Electron 官方安装器下载固定版本的原生运行时。

`AREAL_CORE_BIN` 可指定可信 Core 的绝对路径；开发默认使用仓库 `target/debug/areal`。默认使用独立的 `AReaL Harness GUI Dev/<工作树摘要>` 数据目录；安装版使用 `AReaL Harness GUI`。不导入或替换旧桌面安装与数据。`AREAL_GUI_USER_DATA`、`AREAL_CORE_HOME`、`AREAL_HARNESS_SERVICE_HOME` 可显式设置隔离目录。模型配置默认与 CLI 共用 `~/.areal/config.toml`，由 Core 统一解析、校验和保存；`AREAL_HARNESS_HOME` 可修改 Core 配置 home，`AREAL_CORE_CONFIG` 可显式选择其他文件。首次读取不创建配置，首次保存由 Core 创建默认文件；旧 GUI 隔离目录中的配置不会自动合并。

启动 GUI 前可显式设置 `AREAL_CORE_SANDBOX_PROFILE=native`，或在 `areal service ensure/restart` 使用 `--sandbox-profile native`，请求原生 Runtime 沙箱。默认仍为 `full-access`。此选择纳入部署兼容性；切换时需先停止活动任务并显式重启服务。只有 Core 验证原生隔离能力后，旧版只读 Side 对话才提供只读访问当前工作区文件的选项。原生隔离不可用时启动失败，不降级为 full-access。

配置文件按 `AREAL_CORE_CONFIG`、`AREAL_HARNESS_CONFIG`、Core 配置 home 下的 `config.toml` 顺序选择。配置 home 优先使用 `AREAL_HARNESS_HOME`，否则使用 `AREAL_CORE_USER_HOME` 指定的用户目录（省略时为当前用户 home）下的 `.areal`。显式文件的相对路径在 GUI 启动目录解析；实际配置路径和配置 home 均参与新后台的部署身份。普通重开比较当前部署与后台身份；相同部署静默复用，配置路径或配置 home 变化保留原后台，显示显式更新入口。尚未创建的默认文件首次保存不改变后台身份。同一 GUI 后台的不同项目沿用这份配置，设置页不随项目切换选择另一份上传配置。

macOS 开发和安装版均需要可执行的 `/usr/bin/python3`，供 Runtime 及可信工具助手启动中转；可通过 `xcode-select --install` 安装 Xcode Command Line Tools。该解释器不随应用打包；共享服务在启动前检查可用性并返回明确错误。

GUI 先尝试重连已有后台。启动新后台前，预检确认所选开发工具包含 Python，再有界执行系统解释器。开发工具缺失或选择失效时不执行可能弹出安装器的 Python 桩。依赖失败显示安装引导和重新检测入口，尚未启动 Core 或后台。只有点击安装按钮才会请求 `xcode-select --install`。安装包预检核对现有 Core manifest 的 `prerequisites`，开发版沿用当前启动桥固定的系统 Python 路径。此预检不替代干净 macOS VM 和签名安装包验收。

macOS GUI 后台自动读取系统静态 HTTP、HTTPS 和 SOCKS 代理，供 Core、模型连接测试与订阅请求使用；显式环境变量优先。绕过规则、重启生效和限制见[代理配置](../../docs/guides/configuration.md#proxies)。`pnpm --dir clients/gui run test:proxy` 验证实际 HTTP 转发、HTTPS CONNECT、SOCKS5 远端 DNS、后台 TCP 转接和本机直连。设置 `AREAL_TEST_MODEL_PROXY_BIN` 为已编译的 `core/engine/tests/model_proxy.rs` 测试可执行文件，可同时验证真实 Core 的 HTTP/HTTPS 流式回复。

## Composer

发送普通消息后，输入内容立即移到对话区，并显示“正在启动聊天”或“正在发送消息”。提交期间保留恢复草稿并阻止重复发送；Core 历史到达后接替本地消息预览。未受理或结果未知时，内容恢复到 Composer，沿原回执核查流程处理，未知请求不自动重发。 现有会话通过 Enter 发送时复用同一编辑器，提交预览不重建输入框；受理完成后可继续在原光标行输入。

顶部“任务资源”弹窗使用紧凑分区：Changes 单行展示工作区未暂存增删统计，进入改动面板可核对文件与范围；Subagents 分行展示头像与运行、完成或待确认状态；Sources 默认展开，保留添加、折叠及查看全部。定时任务和后台进程沿用原入口。

下一步 Prompt 预测以较小的常规字体显示，不展示 Tab 提示；Tab 仍只把预测放入草稿，不自动发送。轮次文件改动卡片将文件数与总行数分成两行，弱化目录、突出文件名。关闭右侧最后一个标签页（包括“关闭所有标签页”）后自动收起面板，保留主会话草稿；关闭确认未通过时保持原状。

侧栏“项目”标题旁的 `+` 可直接打开已有项目目录，无需先新建聊天。取消目录选择保留当前项目、聊天、面板和草稿；重复打开同一目录不会新增项目副本。

权限审批和 Ask User 共用固定在对话底部的交互卡片。审批默认显示拒绝与允许一次，Core 允许记住授权时才提供任务／项目范围菜单；原有授权条件和状态核对保持不变。问题支持选项、自由回答和逐题填写；“跳过”或关闭仅暂时收起，保留草稿和待回答入口，不提交空答案或停止任务。提问期间输入框保持紧凑，审批期间保留并隐藏普通输入草稿；回答回显来自 Core 已保存的工具历史。`pnpm --dir clients/gui run test:interactions` 使用隔离的真实 Electron/Core/Runtime 和确定性本地模型验证审批、回答及历史恢复，不替代真实供应商或安装包验收。

在构建 GUI 后，`AREAL_CORE_BIN=/absolute/path/to/areal node clients/gui/scripts/interaction-smoke.mjs --manual` 打开独立的真实窗口供你操作。输入普通中文要求，本地确定性模型将本轮请求整理为独立 Markdown 文件。标准 profile 在隔离实例强制审批 `fs_create`，批准后 Runtime 真写入，拒绝则不创建文件；最终回答依据真实工具结果。脚本不自动发送或审批，关闭窗口或按 Ctrl+C 清理本实例。证据目录中的 manifest 标明手动可操作，不表示自动验收通过。

`--task-slice` 仅自动验证任务输入、过程、批准与拒绝以及真实文件副作用，跳过问题、浏览器和 Web 专项。它保存全窗口截图、源码与 Core 身份，并检查明暗主题、宽窄窗口及独立的 14/18 字号条件。偏好通过既有 localStorage 初态注入后重载，不证明设置 UI。原 `--focus-only` 继续验证 GUI 与本地 Web 的键盘审批。以上模式复用相同隔离启动和退出清理，均不替代真实供应商或安装包验收。

未保存主题偏好的新 GUI 配置默认使用深色；已有的主题选择继续保留，设置中仍可选择浅色或跟随系统。界面基础字号与聊天内容（输入、用户消息、回答）默认均为 14px，代码默认 12px；界面与内容字号仍可独立调整。已保存的字号（包括 12px）保持不变，不自动迁移。默认值参考 Codex 桌面版，依据与范围见[字号核对](../../design/archive/content/codex-typography-review.md)。

`--appearance-slice` 从真实任务进入外观设置，通过控件修改主题、界面字号和内容字号，核对即时效果、偏好持久化及返回原任务后的草稿与阅读段落。它沿用同一隔离 Electron/Core 启动与清理。本外观专项的阅读证据限于同一 GUI 进程。字号重排后按段落恢复当前仍可用的正文，既有证据不证明同一字符、Renderer 重载或应用重启后的阅读位置，也不证明自动重新获取已释放的分页历史或完整内容。同窗口重载恢复另见 [Messages 阅读合同](renderer/src/Messages.md#同窗口-renderer-恢复阅读)。`--manual --reading-sample` 在批准写入后的回复中追加阅读样例，供手动修改外观并返回比较；样例不代表写入文件的正文。

模型设置采用供应商目录与详情两栏布局，左侧仅显示供应商名称，已启用与未启用分组以间距和分隔线区分，凭据及可用状态保留在右侧详情。详情按协议、名称、Base URL、认证与 API Key、模型排列。连接填写完整后自动获取模型，使用尚未保存的地址与密钥；可勾选添加或手动输入模型 ID，发现失败不会清空草稿。模型行保留启用开关及“更多”菜单，编辑模型使用居中弹窗，修改先保留在供应商草稿中。API Key 已配置时默认在输入框内显示固定掩码；点击眼睛按需查看已保存的明文，再次点击、切换供应商或离开页面后清除。查看不会产生修改，保存只提交新输入的替换值，留空保留现有凭据。保存允许任务继续运行，也允许暂不添加模型；文件保存后，空闲项目自动应用，页面分别显示已保存、等待生效与应用失败。现有任务保留原模型和凭据，Composer 目录在应用确认后更新。ChatGPT 订阅模型目录只读，账号管理与模型在同页。新会话沿用主会话最后一次受理的模型与思考强度，跨项目和重启保留；未发送修改、历史导航、Side 和后台执行不更新偏好。“会话配置”和模型行菜单提供备用默认模型，供没有记录或完整目录已确认上次模型不存在时使用；已有会话保持不变。保存操作期间设置导航暂时禁用，等待后台生效不阻止继续编辑。手机访问配置通过“私人网络／公网／组织网络”切换，只展示当前方式的字段；详情、Relay 与恢复操作按需展开。Serve 方案确认、公网双重确认、组织来源确认及设备指纹、项目范围和权限批准均保留。共享配置接口见[配置指南](../../docs/guides/configuration.md#gui-与-cli-共享模型目录)。

测试连接在收到有效的成功终态和文本后完成，并释放响应流，不再等待网关关闭连接。未完成、失败或空文本回复仍视为测试失败。

新草稿和已有聊天的 `+` 与 `/` 共用功能/Skills 分组目录和搜索；方向键选择，Enter 确认，Esc 关闭。Core 返回可用 Skills 后立即显示可选项，来源标签异步补全；来源读取阻塞或失败不影响选择，旧 Profile 或 Core 连接的来源响应不能覆盖当前目录。打开 `+` 菜单刷新目录，再次点击关闭不刷新。Skill 附加到当前消息，发送前由 Core 读取正文；失败保留草稿和标签。已选可用模型的入口先显示强度，再进入真实模型目录；未选模型或所选模型不可用时直接显示目录。可选强度与可用状态取自 Core。无显式强度时使用服务默认；已知非法的历史或配置值提示后回退到受支持的配置默认、中档、首个可选值或服务默认；显示与提交使用同一具体值。已有会话保留不兼容强度，尝试发送时用既有弹出错误提示引导重新选择并在提交前拦截，打开菜单不修改配置，通过滑块或未指定时的档位选择后才保存。配置保存等待回执时草稿仍可编辑、强度滑块保留焦点，发送与再次配置等待结算；回执之后迟到的处理中投影不会禁用编辑，结果未知时仍需恢复核对。强度名称仅在悬停、聚焦或选择时提示，顶部保留当前值。`none` 显示“无”，不支持推理的模型不显示强度。模型目录只显示已启用且可用的模型；缺少凭据的诊断保留在模型设置中。历史模型身份仍保留在入口，不自动切换。Composer 提供模型、强度与显式服务默认选择；统一从“设置 > 模型设置”配置模型。没有可选模型时显示单行“暂无可用模型”，完整引导保留在提示中。`pnpm --dir clients/gui run test:model-selection` 使用隔离 Electron/Core 验证目录、设置入口、凭据保存与应用后的模型执行；远端供应商支持须单独验证。

保存模型或思考强度期间可继续编辑草稿，键盘调节强度不会打断滑块焦点。结果未确认或存在其他未结算操作时仍禁止提交。

中文输入法组词期间只更新编辑器候选文字，确认或取消后同步最终草稿；候选确认的 Enter 不发送消息。输入光标沿用当前主题的正文颜色，换行与空行沿用编辑器字号和行高。

已发送的长消息默认显示约 8 行预览，通过“展开全文 / 收起”完整阅读；是否折叠随面板宽度和字号重新判断。复制保留完整原文，附件独立展示。主聊天、Side 与 Remote 共用同一消息组件。后续长文本界面遵循[设计系统的渐进展示原则](packages/ui/src/conversation/collapsible-text/collapsible-text.md#gui-接线)。

流式回复的新文字逐字淡入，中文与英文共用同一呈现方式；完成后的历史直接显示。等待状态使用随主题变化的连续文字高光。设置中的“减少动态效果”同时关闭这两类动效；可在[设计系统预览](design-system/README.md#预览与检查)中切换明暗、字号和动效检查。

新一次发送或调整方向会清除上一操作的界面错误提示；本次失败仍显示原因并保留草稿，受理结果未知的消息不会自动重发。

已配置的 ChatGPT 订阅消息在受理和首次回复前不刷新模型目录。启动、登录完成和模型设置刷新负责更新目录；目录请求失败后，请在模型设置中刷新再重试消息。认证仍由实际模型传输检查。`pnpm --dir clients/gui run test:subscription-send` 使用隔离 Electron/Core 与合成订阅服务验证发送和目录恢复，不替代真实供应商验收。

图片显示缩略图。主聊天与新草稿可从文件选择器、剪贴板文件或拖放附加非空 UTF-8 文本和源码，包括 Markdown、JSON、YAML、CSV 与日志。Core 根据原始字节校验内容，将文本 MIME 规范为 `text/plain`；历史保留原文件名与可下载字节，Chat Completions 和 Responses 收到带文件名的完整文本。无 MIME 的文本同样支持。二进制、无效 UTF-8、控制字符和伪造媒体类型被拒绝。单件上传上限仍为 16 MiB；每次提交的正文与文本附件合计上限为 1 MiB，包含文件名标签，不截断，拒绝时保留草稿。图片与 PDF 沿用原模型支持范围。

UTF-8 文本卡片可通过“在文本框中显示”追加到正文，展开上限为 1 MiB。超过 200 字符或至少 5 行的粘贴折叠为文本卡片；直接发送或保存排队消息仍按正文处理。真实文件保持文件历史，队列编辑可保留原文件并附加新文件。删除文件或技能不影响正文。目标模式消费正文及折叠文本，其余附件继续保留。

`+ → 工作区文件与文件夹` 打开现有文件树。搜索或定位当前工作区中的文件夹，右键“添加到对话”，或将树中条目拖入主聊天或新草稿。引用使用工作区相对路径，Agent 可通过 Runtime 工具按需读取当前内容，不递归上传或保存目录快照。跨工作区、越界路径、工作区外的符号链接和已失效条目不能插入。核对引用期间暂停发送；切换聊天后的旧结果不能修改当前草稿。外部文件夹拖放与 Side 附件暂不支持。

主聊天、Side 聊天和项目新草稿输入 `@` 可搜索当前项目工作区的文件，同时保留会话和插件候选。裸 `@` 不展示文件；在 Composer 中继续输入关键词后才搜索工作区，文件结果排在会话和插件等候选之后，搜索词保留在输入框中，菜单不另设搜索框。支持文件名或相对路径搜索，忽略目录和现有搜索服务排除的构建及依赖目录。每次最多展示 100 个文件；结果不完整时提示缩小搜索范围。方向键选择，Enter 或 Tab 插入，Escape 关闭；选择文件只插入引用，不发送消息。候选列表在输入框上方显示文件名和父目录。选中的文件在 Composer 和已发送的消息正文中显示为 Skills 式的行内图标与文件名标识；悬停显示所属项目或 Worktree 实际根目录下的完整绝对路径。发送、排队和恢复草稿使用规范工作区相对引用，不上传文件内容。实际上传文件沿用附件卡片。展示合同见 [R-COMPOSERSURFACE-007](packages/ui/src/conversation/composer-surface/composer-surface.md#工作区文件引用)。

`pnpm --dir clients/gui run test:composer` 使用隔离 Electron/Core/Runtime 验证输入路径。`pnpm --dir clients/gui test:composer-files` 运行文本文件、文件搜索引用、目录引用、队列与两种模型协议的专项；文件选择器使用 fixture，不代表物理系统选择器验收。`AREAL_COMPOSER_SKILLS_REGRESSION=1` 对真实 Core Profile 目录的可选来源读取设置屏障，验证来源延迟、失败、旧 Profile 响应及关闭菜单不刷新。

点击 Composer 图片缩略图可放大预览，再通过图片下方的“标注”进入右侧编辑。在图片上点选位置并填写说明，可确认多条点位标注；编辑器与内置浏览器批注共用紧凑输入和展开输入交互。“完成”返回原草稿，不发送消息。发送时只提交原图及其标注清单，坐标相对完整图片以百分比展示，缩放不改变坐标。已发送图片支持只读回看点位和说明。未发送图片及标注随当前窗口草稿保留，不跨窗口重启保存。 `pnpm --dir clients/gui run test:image-annotations` 使用隔离 Electron/Core 与本地模型验证草稿首发、重复图片、上传拒绝、队列编辑和历史回看，不替代真实供应商、物理输入或安装包验收。

右侧 Panel 的网页、终端和文件共用顶层标签栏；每个网页标签绑定一个原生 Page，可通过 `+ → 浏览器` 或 `⌘T`（Windows/Linux 为 `Ctrl+T`）继续新建。切换标签保留各页的网址、历史与控制状态；关闭网页标签释放该页，隐藏 Panel 不关闭网页。页面列表由 Main 的权威快照同步，Agent 新建或弹出的页面也显示为独立标签；browser use 仍按 `pageId` 和原有审批／人工接管规则执行。此布局不提升原有每 Workspace 4 页、每窗口 8 个原生页面的资源上限。

内置浏览器工具栏的“批注”位于导航按钮和地址栏之间。点击后冻结经过隐私检查的原生页面截图，可点选元素或框选区域；就地填写说明并确认，加入当前聊天 Composer 的标注附件。可连续确认多条，展开附件逐条编辑或删除，发送时经既有 Core 媒体通道提交选区裁图和说明。正文保持独立；未确认标注、空白说明或结果待核对的提交不能发送。上传失败保留草稿，不自动重试。已发送消息从 Core 历史关联原图片与说明；未发送图片和标注随当前窗口附件草稿存活，不跨窗口重启保存。`pnpm --dir clients/gui run test:browser-annotations` 使用隔离 Electron/Core 与本地模型验证同页、多条、跨聊天隔离、上传拒绝和历史回取，不替代真人输入或安装包验收。

浏览器可读取当前已提交文档，不必等待图片等子资源全部加载完成。批注截图失败会在工具栏附近提示，保留原网页以便继续浏览或重试。`pnpm --dir clients/gui run test:browser-loading` 使用隔离 Electron/Core、本地搜索页和确定性模型，验证单轮打开、搜索、读取仍在加载的结果，以及批注失败后的页面保留；不代表 Google 网络或真实模型验收。

Browser 工具在每次新用户请求中先 `describe`，再重新观察，拒绝跨轮次使用旧 Ref/快照。导航后的 `documentReady` 等待不依赖元素观察，可跨越同一已授权 Origin 的文档加载；页面变化导致的在途观察失效返回 `plan_stale`，人工接管返回 `human_control`。`node clients/gui/scripts/browser-google-smoke.mjs` 从仓库根运行隔离的真实 Electron/Core 与 Google 页面，使用确定性本地模型验证打开、搜索 `AI Agent`、读取结果及旧 Ref/撤权拒绝，并保留 GUI/原生截图与历史；不替代真实供应商或安装包验收。 Google 触发验证码时不算结果读取通过；本地回归可设置 `AREAL_BROWSER_LOCAL_SEARCH=1`，证据明确标为合成搜索页面。

全局应用入口位于现有插件/应用面板，不在新聊天按钮上方平铺。会话应用在新聊天和已有聊天的 Composer 中通过 `/` 或 `+` 菜单的“应用”分组查找、筛选并打开；文件应用仍从文件面板打开。选择应用沿用原会话归属与页面打开链路，不发送草稿。

MCP 应用页面在窗口内保留。切换标签、隐藏面板、会话或项目导航，以及打开设置或定时任务均保留同一 iframe、未保存内容与在途调用。显式关闭、会话归档或来源撤销释放页面。每窗口最多 8 个活页面，正在打开的页面计入额度；超出时明确拒绝新增。后台消息保持原会话归属，不能打开新会话或修改当前输入草稿。`pnpm --dir clients/gui run test:mcp-app-lifecycle` 使用隔离 Electron/Core 与本地 MCP 夹具验证这些行为，不替代安装包或真实供应商验收。

支持的成功 MCP 工具记录提供“打开交互结果”。打开读取保存的原输入和结果，不重复执行原工具；重复打开聚焦同一页面并保留编辑。显式关闭后可重新打开，旧请求不会复活已关闭页面。旧来源证据不足、包或原连接失效、页面加载失败时，原结果继续可读。读取历史不会自动打开页面。`AREAL_MCP_RESULT_MODE=1 pnpm --dir clients/gui run test:mcp-app-lifecycle` 使用普通模型调用与独立 MCP 计数器验证该路径。

## 生成式交互回答

主会话和 Side Chat 可在助手完成回复后显示生成的交互页面。模型通过 Core 的 `gen_ui_publish` 发布最多 48 KiB 的 HTML 片段，再用 `::visualize` 引用受保护的制品。普通文件路径、用户消息和代码示例不能打开执行页面。页面与 MCP Apps 共用沙箱和每窗口 8 页额度，没有 Node、任意文件、工具或网络访问权。

页面保存的状态分为 `modelContent` 和 `privateContent`，每项最多 16 KiB，会话最多保留 100 项。同一 Desktop 配置下重新打开页面可恢复已保存状态。下一次主会话或 Side 发送只附加有界 `modelContent`，`privateContent` 不进入模型请求。调整参数和保存本身不发送消息。页面提出后续问题时先等待保存，再由宿主提供可编辑的确认入口，通过原会话发送。未知受理沿用原收据核对，不自动重发。不提供跨设备状态同步。

`pnpm --dir clients/gui run test:gen-ui` 运行该功能的专项检查。接口和限额见[桌面 API](../../docs/api/desktop.md#生成式交互回答)。

## Worktree 新会话

项目中的其他待核对操作不会锁住新会话草稿的编辑与引用恢复。带有效请求 ID 的其他会话创建不会阻止新草稿发送。当前草稿自身创建结果未知、正在发送或评论草稿读取失败时仍保留保护；其他类型的未决操作继续阻止发送。

普通新会话默认使用当前目录和分支。只有在本次创建时通过 Composer 上方右侧的齿轮启用 Worktree，才创建独立目录，并可搜索起始分支和选择项目环境。首条 Prompt 在目录创建、空线程绑定与所选 setup 成功后才发送。创建过程中可请求取消，确认取消后可明确改用原目录；定时任务目录仍须满足其专用预约。设置中的 Worktrees 提供 General 根目录与保留策略、按项目目录管理，以及环境名称、Default/macOS/Linux setup/cleanup 和 Actions。默认根目录为 `~/.areal/worktrees`，设置只影响未来创建。删除保留分支与历史，活动、脏或未知状态会阻止删除；自动清理默认关闭。创建、恢复、执行隔离与现有任务准入边界见 [Worktree 指南](../../docs/guides/worktrees.md)。

## 插件详情

“项目操作正在处理中”表示原请求仍在等待响应；“结果待核对”表示原请求是否完成尚未确认。带有效请求 ID 的无关会话创建保留提示，不阻止 Skills 管理或切换项目；插件自身及其他未决操作仍保留修改保护。非插件请求显示原方法与请求 ID，“核对项目操作”按原请求找到执行工作区并读取结果，明确显示仍未确认的情况。原会话已加载时也可打开。核对不会重发请求或删除未知记录。

插件详情优先展示当前安装包的状态和下一步操作。安装前先解析并核对来源及内容摘要；认证、当前快照的 MCP 信任与连接分别确认，安装或启用插件不会授权钩子。连接结果未知时只核对原提交，不重复连接；断开操作同时撤销当前快照的 MCP 信任。

“来源与安装详情”原位展开，完整路径、配置和诊断在技术详情中查看。空 Skills、无定义且无诊断的钩子及无应用入口的区块不展示；读取失败仍显示原因。`node clients/gui/scripts/plugin-detail-ui-smoke.mjs` 从仓库根运行生产 Renderer 的状态与视觉验收（管理接口使用确定性夹具）；`plugin-p0-smoke.mjs` 和 `plugin-p1-auth-smoke.mjs` 分别覆盖隔离 Electron/Core 安装与回执恢复、本地 API 凭据认证，不代表真实 OAuth 或安装包验收。

## Fork 与侧边聊天

侧边聊天创建期间不显示待确认提示。结果确实未知时使用顶部短时通知，主输入区不常驻操作横幅；通知关闭后，侧栏启动页的“核对首问结果”仍按原请求读取回执，确认后打开原侧边聊天，不重复创建。审查、终端、浏览器和文件的正常打开以面板切换反馈，加载和故障状态归所属面板。

每轮完成回复下方的“分支”直接在窗口中央打开紧凑浮层，仅提供“在当前工作区中创建”，继承当前轮及之前的历史和当前轮的模型配置；点击外部或按 Esc 关闭。创建独立聊天，不提供之前/之后菜单或三个点入口；文件保持当前状态，不提供新工作树选项。未知创建结果先核对受理状态，不重发。

主输入框的 `/side` 与 `/btw`、侧栏启动页和 `+` 菜单可创建独立辅助对话标签。裸命令创建空会话，带纯文字参数时立即在新会话发送首问；附件或结构化上下文仍走主会话发送路径。每个辅助对话复用完整 `Composer` 和 `Messages`，支持附件、模型、权限、工具与多轮输入，保留独立草稿和提交状态。来源历史在创建时冻结并仅供模型参考，界面从空白开始；来源正在生成时不复制未完成的助手和工具增量。主、辅会话共享可移除、去重的多段引用。Esc 只停止键盘事件所属对话，侧栏关闭后主会话可接收对话外 Esc。关闭标签会停止并清理该辅助对话；隐藏面板和切换任务保留标签，重启不恢复新标签和草稿。旧的只读 Side 保留原权限、证据与恢复入口。完整契约见[桌面 API](../../docs/api/desktop.md#side-chat)。

## 子任务与交付

普通输入区描述目标，Core 管理子任务的执行、检查与交付。通过会话中的子智能体记录或“任务资源”入口阅读子对话；执行、检查与交付状态分别由 Core 契约验证。

旧委派和 Workgroup 的历史与只读权限由 Core 保留兼容契约，生产 GUI 回归通过当前子代理和 Side Chat 入口验收。

## 对话资源

主对话和项目新对话输入框的 **+** 与 **@** 可搜索并引用当前项目的普通会话。默认展示最近 20 条，搜索覆盖已加载的可用会话；当前会话、已归档会话、Side、子智能体与定时任务不在候选中。引用以标题标签保存稳定的会话身份，支持删除和草稿恢复。发送只携带引用，模型需要历史时通过 `read_conversation_context` 按页读取本次用户输入明确引用的同工作区会话。`AREAL_COMPOSER_REFERENCES_REGRESSION=1 pnpm --dir clients/gui run test:composer` 使用隔离 Electron/Core 和确定性本地模型验证选择、恢复、按需读取与未选会话拒绝。

对话右上角的“任务操作”菜单仅保留带路线图标的“查看调用轨迹”。“任务操作 → 查看调用轨迹”面板顶部的“复制轨迹”将当前已加载会话的全部轮次复制为格式化 JSON，包含会话和轮次标识、状态、模型、用量、消息、工具调用与结果及错误。搜索和折叠不影响复制内容；复制成功或失败会显示反馈。内容来自已保存的执行记录，不包含逐次模型请求的完整 I/O，也不会自动上传；分享前请检查消息和工具输出中的敏感信息。

对话按 Core 的消息阶段区分过程与最终回答。耗时标题下方与正文保留一个统一的对话块间距，直接显示最终回复时也采用同一留白。耗时显示在过程顶部，可展开或折叠整段过程；已完成过程默认折叠，最终回答和交付内容始终可见。工具分组默认折叠，展开后在固定高度内上下滚动；手动展开的分组和工具详情在过程消息更新时保持展开。过程正文完整显示，随对话一起滚动；单条命令和文件比较仍可查看详情。执行状态独立显示在本轮内容尾部，不作为工具分组的折叠按钮。展开或收起过程与工具详情时保留阅读位置；点击“滚动到底部”可恢复跟随新内容。执行中活动文字从左向右亮色扫过，完成后停止；减少动态效果时保持静态。成功返回的图片有独立预览入口；子智能体显示已读取的真实名称与状态，未读取时明确显示状态待确认。本轮文件变更默认展示前五条文件及 Core 验证的增删行，更多文件可以展开与收起；点击文件或审查入口沿用现有路径。回复中受会话授权的 Core 图片引用直接展示缩略图，普通链接可直接打开，独立的本地网页链接展示网页预览卡片。没有阶段的旧历史继续保留原有过程折叠。右上角不再显示终端快捷按钮，终端仍可从面板和快捷键打开。

对话顶部的“任务资源”在顶部图标下方的紧凑浮层展示当前工作区变更、Core 直接子智能体、受管后台进程及用户附件和已验证的文件读取来源；Git 工作区保留变更数量为 0 的审查入口；其他没有资源的分组不显示。变更和进程入口复用现有审查、进程面板。

信息流中的子智能体创建记录和资源列表都可打开右侧子对话，使用同一消息与工具组件读取真实历史。头像按 Core Thread ID 在本地固定生成，不请求外部图片服务。子对话标签支持切换与关闭，关闭阅读视图不停止子任务；重新打开从 Core 恢复。主对话和输入草稿保持原来的所有者。执行、检查与交付状态仍由 Core 的委派查询返回，分别核对；GUI 通过当前子代理资源入口阅读历史。

“定时任务”可以在普通主会话中创建和修改。Agent 使用 Core 的 `scheduled_task_list/create/update/control/receipt` 工具保存安排，界面离开或重载不影响保存。工具成功结果包含真实 Task 和回执时，对话才显示任务卡。任务卡保留当时的成功事实，并从 Core 重新读取当前状态。删除后仍保留历史卡片；Core 不可达时显示“状态暂不可用”，不推断删除或重发请求。

右上角“任务资源”列出来源为本会话的全部活动安排。空列表保留“添加”，将创建意图追加到现有 Composer 草稿并聚焦，不自动发送。每个安排显示规则、时区、下次时间、项目和最近运行异常。暂停、开启、立即运行、停止本次和删除直接调用已有桌面命令，不依赖模型。暂停仅影响未来触发。开启恢复计划。立即运行保持原计划。删除是持久软删除，撤销未来触发并请求停止未结束的运行。执行或 worker 尚未结算时仍显示“删除中”，结算后从活动列表移除。历史和原请求回执保留，墓碑仍计入 Core 的任务容量。

项目菜单提供重命名、在默认应用中打开、在文件管理器中显示、置顶和排序操作；定时任务从左侧定时中心进入。项目和会话菜单中的“上移／下移”随界面语言切换。Tasks 分组下的会话名称与项目内会话使用相同缩进。

左侧定时中心汇总全部已登记项目和独立任务，保留名称搜索，不按项目或任务状态隐藏安排。任务中心、来源侧栏和后台通知共用每个执行 owner 的轻量目录缓存与更新流；列表不携带完整运行历史、消息或 worker 明细，详情按需读取。普通列表操作只读取已发布摘要或已连接 Core 的实时目录，不启动冷 Core。已发布记录保留“上次记录”与状态未确认标记，读取时间不等于发布时间。来源失败保留上次可信行，损坏、旧格式或身份错误不表示没有任务。实时更新覆盖新增、修改、删除和关注项；断连、缺号或换代后重新建立基线，首次基线不重发历史通知。

全局“新建任务”立即打开无项目的普通 Composer 草稿并带入创建意图，发送前不分配工作目录或创建会话。草稿可编辑、离开和重载；首次发送沿普通创建路径准备环境，保留输入和附件。模型目录在分配目录前只读获取，继续使用最近受理的模型与强度规则，发送前再校验目标 Core 的确切模型与强度。项目入口保留所选项目，当前会话“添加”只追加意图并聚焦。目录、模型和创建结果不触发迟到导航。

普通项目会话创建的安排保留当前项目和工作目录，需要文件隔离时可在普通新会话中选择 Worktree。`sourceThreadId` 仅标记来源关系，执行锚点与每次 Run 的会话保持独立。来源会话仍在侧栏可见，删除来源会话不自动取消安排。安排保存完整说明和必要引用，后台不随来源会话持续增长读取新内容。每次 Run 跟随当前默认模型与环境配置；共用工作目录不代表文件隔离。执行要求 Core 和对应桌面 Host 在线，退出应用后不再触发。

若独立会话创建结果待确认，“检查操作状态”只核对原请求。核对后仍未确认时，可选择“保留原记录，返回任务列表”；确认后保留原记录、目录和可能已创建的会话，不重发或发送草稿。之后再次点击“新建任务”会启动另一笔创建。无关的历史会话创建记录集中在“设置 → 后台服务 → 待核对的会话创建”，按项目和原 requestId 核对；插件页只展示影响插件操作的待核对记录。这些记录不锁住新会话的工作区设置。缺少回执仍表示结果未知，不能推断为从未受理。新版创建请求另保存认证身份、日志覆盖、Core 启动代际及时间；仅在 Core 对已退役原代际返回匹配的明确未受理证明后，先保存结果再清理 pending，草稿仍保留。旧记录和受理后未结算的请求继续 UNKNOWN，均不自动重发。打开历史对话时，加载提示按项目连接状态区分“正在连接项目”和“正在读取对话”；提示不代表耗时瓶颈已定位。

App 运行期间，共享 Desktop 后端独立发现启用安排，并连接其执行 owner，无需用户先打开项目。Core 仍决定到期、漏执行与重叠受理。显式停止项目会持久抑制自动激活，只有明确重新连接或启动才能解除；普通列表读取、自动会话恢复和窗口切换不解除。退出 App 后不再调度，未结束执行仍按既有取消与清理契约结算。仅关闭窗口沿用当前后台生命周期。再次启动后按保存的漏执行策略处理，不自动重放 UNKNOWN 操作，也不自动恢复已中断 Run。

旧版专用配置会话及其历史仍可读取，使用原有 proposal 与确认回执流程。新入口不创建这类标记会话。时间规则继续由 Core 计算，支持单次、间隔及按天、周、月安排。日历规则保留 IANA 时区；不存在的日期和夏令时跳空会跳过，重复当地时间只执行较早一次。每个安排显式保存漏执行策略；已受理 Run 保留原规则和说明。未知提交核对原 requestId，不自动重发。相关用户路径由 `pnpm --dir clients/gui run test:thread-schedules` 在隔离 Electron/Core 和确定性本地模型中验证，不替代真实供应商、物理输入或安装包验收。

`pnpm --dir clients/gui run test:schedule-reliability` 默认使用隔离 Electron/Core、5 个逻辑项目、每项目 10 个定时 Task 和合成历史前置，检查完整目录、被动读取、摘要边界、新增删除和周期性全量读取，并记录原始时间样本及源码、产物身份。暖缓存完整列表的 p95 门槛为 300ms，清空 Desktop 目录缓存后的完整加载门槛为 1 秒；首行和修改耗时另列。设置 `AREAL_SCHEDULE_PROJECTS=20 AREAL_SCHEDULE_TASKS=200 AREAL_SCHEDULE_SCHEDULED=5` 可运行原大规模验收，不能以小规模结果替代。`test:schedule-reliability-lifecycle` 使用本地确定性模型检查未打开项目的到期受理、显式停止、退出和重开后的漏执行处理。测试使用 `scripts/support/temp.mjs` 分配目录；需要较短本机 socket 路径时在调用环境设置 `TMPDIR=/tmp`。它们不替代真实供应商、签名安装包或其他平台验收。

`pnpm --dir clients/gui run test:task-catalog-cold` 使用 30 个无安排的独立聊天和 3 个安排 owner，记录点击到可读任务行的时间并检查冷 Core 没有被列表启动。`pnpm --dir clients/gui run test:task-catalog-startup` 使用隔离 Electron/Core，在认证握手后延迟供应商初始化，验证目录先显示、完整启动前管理入口仍禁用，以及启动完成后的恢复。

已保存的定时任务在任务资源浮层提供“立即运行”。暂停计划和已自然完成的一次性计划也能执行一次，原计划保持不变。有未结束 Run 时按钮禁用。普通来源会话的任务从详情中的运行历史查看执行记录；旧版配置会话还保留“查看当前运行”入口。历史显示“手动触发”，报告和未读沿用既有任务流程。受理响应丢失时只核对原请求收据，不重新提交。

`pnpm --dir clients/gui run test:thread-schedules` 使用隔离 Electron/Core/Runtime 和确定性本地模型，覆盖普通来源会话创建、离开页面后保存、任务卡重载、直接暂停与开启、立即运行、运行中软删除、全局目录以及跨来源拒绝。脚本另以原始 Core RPC 检查旧 revision 冲突、原请求去重，以及丢弃已受理响应后只读原回执的恢复。这些协议故障检查单独记录，不代表 GUI 已覆盖丢响应或进程崩溃恢复。

`pnpm --dir clients/gui run test:task-conversation` 的默认场景保留旧版 TaskDraft 历史管理验收。`AREAL_TASK_SCHEDULE_REGRESSION=1` 和 `AREAL_TASK_CALENDAR_REGRESSION=1` 仍可分别配合该命令运行。旧 `AREAL_TASK_CREATION_REGRESSION`、`AREAL_TASK_LOADING_REGRESSION`、`AREAL_TASK_DAILY_START_REGRESSION`、`AREAL_TASK_INLINE_REGRESSION` 和 `AREAL_TASK_MANUAL_REGRESSION` 依赖已移除的新建入口，仍待迁移。脚本明确拒绝这些模式，不能将它们报告为通过或跳过，也不能沿用其旧验收覆盖声明。

旧版专用任务配置会话保留原有准备草稿、组词交接和模型继承行为。普通会话新入口使用现有 Composer 与普通会话创建命令，创建结果未知时核对原请求，不重新创建 owner 或会话。

普通计划创建在没有 Worktree 记录时，可通过同一请求已确认完成的会话创建收据打开原会话。工作树仍在绑定或 setup 时继续等待原操作，不把会话创建收据当作工作树就绪。

## 生命周期

`AREAL_REOPEN_FORCE_GUI=1` 配合 `test:service-reopen` 强制结束隔离 Main，验证 owner 管道回收原引擎，随后新应用会话从原历史恢复。新代际不重放中断输入。`test:desktop-exit` 分别验证 Main、Desktop 强退和测试 runner 失败、SIGTERM、SIGKILL 的清理。浏览器与动态 ToolHost 的真实强退 UNKNOWN 仍需专项验收，既有宿主丢失与 generation 失效契约保持不变。

关闭窗口只隐藏界面，GUI 仍持有单实例锁；再次启动或从 Dock 激活会唤回原窗口。应用菜单、菜单栏和后台设置的“退出 AReaL Harness”（⌘Q / Ctrl+Q）共用安全退出。应用拥有 Desktop、每项目 Host、Core、Runtime 和监督桥，窗口不拥有引擎。每次普通退出都会显示原生确认，提供“取消”和“退出”，空闲时也需确认。有活动任务、已启用的定时安排或手机入口时，确认框简要提示退出影响。只有原引擎物理清理和 Desktop 退出已确认后才退出 Main。部分停止、结果未知或清理未完成保留恢复入口，不自动重复停止。退出后安排不再触发，手机入口断开；安排定义、历史与草稿保留。CLI 与其他 GUI profile 保持独立。

普通退出先通过未保存修改检查，再显示原生确认。只有确认退出后，才显示带持续动画的进度弹窗，直到窗口真正退出。弹窗显示停止后台与完成退出，不显示百分比或预计时间；等待期间关闭窗口不会隐藏弹窗。取消原生确认或退出失败后恢复界面，原请求与未知结果仍由现有恢复入口核查。原生浏览器视图在确认退出后暂时隐藏，退出失败后恢复原页面。取消确认保留界面与原生页面的正常操作。`AREAL_CORE_BIN=/absolute/fixed-slot/areal pnpm --dir clients/gui run test:quit-progress` 使用隔离 Electron/Core 验证发送、暂停、退出反馈、取消、失败恢复、重复退出与实际进程清理；原生确认由 fixture 应答，不证明物理快捷键或安装包通过。

`AREAL_CORE_BIN=/absolute/fixed-slot/areal pnpm --dir clients/gui run test:desktop-exit` 在隔离 Electron/Core/Runtime 中核对窗口重开、普通退出的取消与确认、隐藏项目引擎清理、独立 CLI 和其他 GUI profile、Main/Desktop 强退及 runner 清理。目录选择和原生确认由 fixture 应答。指定 `AREAL_GUI_EXECUTABLE` 可使用私有安装包，runner 强退夹具仍限源码入口；这不替代物理快捷键或 Finder 安装验收。

`AREAL_CORE_BIN=/absolute/path/to/private/.local/dev-bin/<slot>/areal node clients/gui/scripts/application-owner-smoke.mjs` 从仓库根验证真实 Host 尚未发布描述时丢失启动响应、原代际恢复、项目投影移除、同/异 profile 旧 owner 的只读边界及原回执清理。测试专用 CLI guard 仅管理隔离 registry 的原实例，runner 结束后通过公共 CLI 回收独立持久服务。

设置存在未保存修改时，退出先复用“保存并继续／放弃修改并继续／继续编辑”确认。取消退出保留草稿、后台连接和正常操作；保存失败保留确认框与错误，成功保存或放弃修改后才清理资源并退出。`AREAL_CORE_BIN=/absolute/fixed-slot/areal pnpm --dir clients/gui run test:quit-draft` 使用隔离 Electron/Core 验证取消后编辑与保存、停止并退出的取消、保存失败恢复，以及保存或放弃后的配置内容和 GUI 进程退出；通过应用菜单回调触发退出，不代表物理快捷键或安装包验收。

普通会话运行时的主要停止操作显示为“暂停执行”。暂停结算后，完整草稿为空时显示播放图标和“继续执行”；文本、附件、Skill、MCP 或评论草稿存在时显示普通发送。发送将输入作为新的用户消息追加到原会话。继续使用已保存历史和当前工作区，不复活旧模型调用或进程。重开 GUI、Core 或电脑后仅恢复历史，必须手动继续。排队输入保留并按现有顺序优先执行；正常回复完成后等待下一次用户输入，不自动创建 Goal。

暂停正在执行或等待输出的本地命令时，Core 先请求 Runtime 关闭本轮 scope，再保留原进程的终态、输出和停止原因。已确认终止的命令允许手动继续，继续不会重放原命令。远端 MCP、钩子或 Runtime 的结果仍无法确认时，UNKNOWN 继续要求先核查原操作。

最后一条真实用户消息提供铅笔。内联编辑的取消不提交；发送按新消息追加，保留原回复、执行记录、附件与 MCP 引用，也保留主输入框的未发送草稿和资源。提交结果未知时先核对原 requestId，不重复发送。`pnpm --dir clients/gui run test:conversation-continue` 使用隔离的真实 Electron、Core 和本地 SSE 模型验证这些路径，输出源码、二进制、请求、历史和截图证据。恢复与 UNKNOWN 的故障记录只在隔离服务停止后注入，不代替物理重启、真实供应商或安装包验收。

内联编辑使用与消息列等宽的面板和可见的取消、发送按钮，Escape 也可取消。截图、评论和文本卡片在同一行底部对齐，窄窗自动换行；粘贴文本显示首个非空行预览。该验收同时记录浅深主题、键盘焦点、文本展开与资源保留。评论样本使用权威审查版本播种本地草稿，不证明评论采集路径。测试专用环境变量 `AREAL_COMPOSER_RENDERER_DIR` 可指定独立构建的 renderer 目录，默认仍为 `renderer/dist`；证据记录所选目录及文件哈希。

主聊天、Side 与子对话按 Core 的稳定消息 ID 展示历史。上下文压缩及正常完成、停止或失败不会移除较早的用户消息、追加指令、附件或 Agent 回复；流式 Turn 事件按条目合并，重新打开和断线恢复按页读取 Core 权威历史。最新一轮自动补齐，不需要点击“加载更早的消息”；同一连接的快照刷新会保留已显示的本轮内容，直到权威分页完成。较早轮次仍按需加载，超大的单条内容保留显式加载入口。分页历史的顶部控件区保留稳定高度，恢复提示、加载按钮和历史加载完毕之间的切换不推动正文。[历史合并契约](../../docs/api/core.md#传输与会话)区分事件更新与权威快照。`verify` 包含历史投影回归；构建 renderer 后运行 `pnpm --dir clients/gui run test:history`，使用 Chrome、真实桌面 backend/Core/Runtime 和确定性本地模型验证同轮压缩、steer、停止、失败、切换聊天及重载后的气泡内容。该检查使用 preload 传输夹具，不替代 Electron IPC 或安装包验收。

Composer 的圆环打开上下文分类与组成占比，面板在整组输入区域上方靠右对齐，外框尺寸在分类展开、收起与滚动时保持固定；空间不足时按可用高度约束，分类列表在内部滚动。面板随 Core 快照自动刷新，不提供刷新或压缩按钮。容量与分类由 Core 提供。Token 总量和可用的平均速率位于回复的分支操作左侧，点击可切换本会话与本轮明细。生成中没有可靠的增量 Token 时只显示状态，不用字符数换算 tok/s；完成后按对应请求的供应商输出用量和生成时长结算，可能包含推理输出。缓存读取属于输入子集，部分或旧记录未确认的消费不会显示为已完整计量；分支会话总量排除来源祖先。切换模型后，若指令估算不能复用，圆环暂不显示占比但仍展示新模型容量。

自定义模型编辑器并排设置上下文工作预算和最大输出，不显示温度。新模型默认开启工具，视觉与推理由用户选择。允许强度来自能力声明或已核实的连接规则；省略列表表示未知，空列表不提供档位。新模型不预选强度。订阅账号使用真实账号目录。“服务默认”保存显式 `default`，覆盖继承值并省略出站强度；无显式强度时使用服务默认。兼容性见[配置指南](../../docs/guides/configuration.md)。隐藏的温度参数不因打开或保存编辑器而清除。上下文面板分别标出账号或供应商报告容量、用户预算与实际工作窗口；旧会话的新请求采用当前报告，历史和已受理队列不变。

构建 Core 与 renderer 后，设置 `AREAL_CORE_BIN` 指向隔离构建的真实 CLI，运行 `pnpm --dir clients/gui run test:context-usage`。该专项用本地确定性 SSE 与真实 Electron/Core/Runtime，检查未发送的模型容量切换、Skills/CLI 来源、用量与速率覆盖、压缩后自动刷新、运行状态、布局、分支及重开不重发；隔离目录、进程/产物身份、截图和结果保存在脚本打印的 `/private/tmp/acu-*`。它不证明真实供应商、安装包或跨平台行为。

设置中的“数据飞轮”页通过 `areal trajectory status/retry/set-enabled` 读取当前配置、上传进程、积压与最近上传记录，页面可见且连接正常时每 2.5 秒刷新，也可手动刷新和重试。记录分别显示 Turn、模型、Harness 版本、模型调用耗时、Agent 执行耗时与事件/创建/上传时间，汇总范围仅为最近 100 条记录；模型调用耗时包含网络与内部重试。会话可见时另以 15 秒间隔检查，在设置入口标记读取失败或导出异常，恢复后清除。轮询共享一个在途请求，隐藏、离开或断线后停止相应轮询并忽略过期响应，上传信息不进入聊天内容。状态读取不启动 Core 或上传器，也不解密 GUI 凭据；手动重试可能启动上传器，继承 Core 启动的凭据环境。编辑本页显示的配置文件中的 `[trajectory]`，通过 `areal trajectory sync-config` 应用本地上传控制；本页提供启停开关，就绪开启浅绿，关闭或待处理浅橙；只修改 enabled，保留其它配置。已有 Core 的采集参数在空闲后自动安全应用，不取消任务；其它配置变化或失败交由后台服务安全应用，本页不编辑地址或凭据。边界与耗时语义见[配置指南](../../docs/guides/configuration.md#持久轨迹导出)。

`pnpm --dir clients/gui run test:trajectory` 验证命令边界、凭据环境、状态投影，以及轮询时序、单一在途请求、可见性和过期结果隔离。`test:trajectory-config` 使用已构建 CLI，在隔离目录验证配置身份及跨项目一致性，不启动 Core 或上传器。构建 renderer 后，`test:trajectory-ui` 使用本机 Chrome 和隔离桌面服务 fixture 验证真实设置交互、自动刷新、耗时及异常恢复；`AREAL_GUI_TEST_BROWSER` 可指定浏览器。上述检查不替代 Electron/Core 集成验收。 `test:trajectory-native` 使用真实桌面后端、Core、Runtime 和本地模型/接收器，验证关闭启动、运行中启用、空闲安全重启、停用保留与失败副本自动补传，不替代正式远端或 Electron IPC 验收。

macOS 桌面适配器通过系统 `/usr/bin/python3` 保留可信 Core 命令的父进程，与 Runtime 的原生启动方式一致。命令参数、环境和标准输入输出保持原样；超时、取消和强杀作用于真实 Core 子进程，适配器或桥退出时清理其仍运行的直接子进程。该路径不重放写入，也不终止 Core 已建立的持久服务。`pnpm --dir clients/gui run test:core-process` 验证信号退出、超时升级、取消、输出上限及进程清理。

遇到 `Core disconnected` 时，在设置的“后台服务”页或应用菜单点击“导出诊断包…”，选择保存位置。后台离线或主界面渲染进程退出后，应用菜单仍可导出。界面到 Desktop 的连接和 Desktop 到工作区 Core 的连接分别记录；前者已连接不代表后者可用。

诊断包只包含固定结构的进程身份、连接错误码与关闭码、Electron 进程退出原因、未捕获异常类别、固定枚举的退出阶段与耗时，以及启动时和每 60 秒一次的内存与定时器延迟样本。项目与 Core 代际使用本次运行内的别名。不会包含对话、凭据、环境变量、命令参数、原始日志、异常消息或堆栈。记录分别保存在 GUI profile 的 `diagnostics/main` 和 GUI Core home 的 `diagnostics/desktop`；每个角色保留最多 8 次运行，每次最多 4 个 256 KiB 事件文件。导出最多读取 16 MiB，报告记录器健康、合并重复事件和文件缺失等遗漏。旧运行缺少退出记录只标为 `termination-unconfirmed`，不推断崩溃原因；观察到的 Core PID 也不证明进程仍存活。写入失败不会改变任务执行或未知提交状态。

Electron Crashpad 在两个主进程中只保存本地转储，禁用上传。默认诊断包仅列转储是否可用和有界计数，不附内存内容；它不捕获 Rust Core 或 Runtime 的原生崩溃。转储目录为各诊断角色目录旁的 `main-crashes` 或 `desktop-crashes`，其磁盘占用不受事件文件上限约束。macOS 源码验收使用仓库 `.local/dev-bin/` 下已部署的固定 Core，运行 `AREAL_CORE_BIN="$PWD/.local/dev-bin/areal" pnpm --dir clients/gui run test:diagnostics` 验证有界存储、隐私筛选、WebSocket 超限以及隔离 Electron 的离线导出与强制退出恢复。

启动日志中的 `[startup]` JSON 记录窗口展示、后台连接、项目 Core 启动、供应商同步、模型目录和历史恢复的阶段耗时。GUI Main 输出到开发控制台，后台输出到 Core home 下原有的 `service.log`。每条记录包含进程、尝试和项目关联信息，使用单调时钟计算耗时，不包含凭据、请求内容或配置正文。阶段开始后没有完成记录表示该阶段尚未结束，不能视为启动成功。并行阶段的耗时不能直接相加。

Renderer 的 `[composer-skills]` JSON 将 Skills 读取分为 `core` 与可选来源 `labels` 两个阶段。同一请求使用 `requestId` 关联项目、Core 实例与连接代际、Profile 或 Thread 配置，并记录阶段耗时 `elapsedMs` 和结果 `outcome`。`core` 就绪表示权威目录已提交界面状态更新；`labels` 完成表示来源标签读取已结束，失败或过期不影响 Core 目录。记录不包含凭据或消息正文；这些耗时不代表实际绘制完成或整个 Composer 启动耗时。

订阅状态从 Desktop 的共享公开快照读取。首次快照先读取活动账号的本地授权事实，设置页据此分组，不以模型数量判断登录。`chatgpt.status` 立即返回上次状态并在后台刷新；刷新图标表示进度，结果通过快照推送。成功目录以 `subscription-catalog.json` 缓存公开模型元数据，并绑定当前账号与注册身份。退出、切换和重新授权使不匹配缓存失效，文件不含令牌。缓存只供展示，不能授权发送。

Composer 保留所选及最后受理模型，目录确认中不显示不可用警报，也不因 `available=false` 禁用发送。仅已确认失效的模型在标签中标记。首次订阅提交在写操作之前等待必要的目录与项目配置准备，之后由 Core 校验；明确拒绝显示原因并保留草稿。依赖写入或提交结果未知时沿用原请求核查。项目共享同一次账号检查，同项目同步串行，不同项目并行。本地转发端口与传输令牌仍先准备，再启动 Core。`provider-status.test.cjs` 与 `provider-recovery.test.mjs` 覆盖缓存、纯读取、并行和代际隔离；`AREAL_CORE_BIN=/absolute/path/to/areal node clients/gui/scripts/subscription-send-smoke.mjs --startup` 覆盖隔离 Electron/Core 的目录等待与恢复，不代替真实供应商或安装包验收。

新会话显式选择 ChatGPT 订阅模型时，创建会等待该模型在目标 Core 完成同步与就绪校验。新 Worktree 的独立 Core 也遵循此规则；普通模型不等待订阅同步，已就绪模型不重复查询账号。

从 `clients/gui` 运行 `AREAL_CORE_BIN=/absolute/path/to/areal node scripts/subscription-send-smoke.mjs --worktree`，验证订阅同步延迟期间的普通模型首发，以及同步完成后的订阅模型 Worktree 首发。测试使用隔离 Electron/Core、真实 Git Worktree 和合成订阅服务，检查创建与首发各发生一次；不代替真实供应商或安装包验收。

经验证的本机 HTTP 服务探测不加载未使用的 TLS 根证书；远端 HTTPS 的证书验证保持原样。

订阅网络适配器的构造和关闭不读取系统证书；首次实际请求才创建 TLS/代理传输，仍合并默认与系统信任根并验证证书和主机名。未联网的模型元数据读取或测试不会因提前访问 macOS Keychain 而退出。需要系统信任根的真实请求仍受执行环境授权约束。

项目连接在配置回执与凭据检查完成后读取本地模型目录；订阅模型由后台同步单独发布。Core 在单次目录查询内复用 HTTP 客户端，逐模型校验凭据、端点和参数。后续查询与执行模型的构造独立创建客户端；该工厂仅保留本次查询的客户端，不缓存目录、模型或凭据。

`make build` 的开发 profile 单独优化 `sha2` 依赖，减少服务启动时校验大型调试二进制的开销。Core 和 Runtime 仍逐次校验完整文件内容，不以路径或修改时间缓存代替内容指纹。业务代码保留开发构建的调试行为，release profile 不变。

`AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui run test:startup` 使用隔离的真实 Electron、Core 和 Runtime，默认执行五次保留合成历史的进程冷启动，验证模型可用性、历史恢复、无重复提交和退出清理。设置 `AREAL_STARTUP_BASELINE_BIN` 可交替比较两个独立构建；`AREAL_STARTUP_ROUNDS` 控制轮数。脚本保留逐轮日志、截图和 manifest，不清除系统缓存，不使用真实供应商或用户凭据。

`AREAL_CORE_BIN=/absolute/path/to/areal AREAL_PERFORMANCE_BASELINE_GUI=/absolute/path/to/baseline/clients/gui pnpm --dir clients/gui measure:gui` 为固定基线与当前源码各构建隔离测量产物，交替执行五轮。报告包含真实 React Profiler 的 200 段流式 Turn、浏览器大型 DOM/多 iframe 并发读取、Main 事件循环延迟、Renderer 键盘事件到下一帧、首次重内容和清理证据。正式 `dist` 保持原样。执行前停止其他构建和桌面验证，按 manifest 的通过、清理和源/二进制哈希解释数据；有界本地夹具不能证明真实供应商、物理输入或安装包表现。启动的十轮前后对比另设 `AREAL_STARTUP_BASELINE_GUI` 与 `AREAL_STARTUP_ROUNDS=10`，报告进程冷启动的 p50/p90、Main RSS/heap 和 Renderer heap，不清除系统页缓存。


`AREAL_STARTUP_MODEL_COUNT` 设置合成配置中的可执行模型数，默认为 9；目录另含默认别名和两个缺凭据模型。`AREAL_STARTUP_CATALOG_READS` 可在完整恢复后采样认证的只读模型目录请求，默认为 0。这些请求单独计时，不计入启动耗时，并验证不会调用模型供应商。

首次启动先显示已应用主题的图标与加载提示，再恢复后台和原会话。初始恢复完成前不挂载首页、侧栏、输入框或面板；恢复成功后一次性显示完整工作台。失败时在加载页提供现有恢复与重试入口。等待超过 15 秒时显示进一步操作，但不据此判定后台失败或重放操作。关闭窗口后，迟到的恢复不会重新打开窗口。启动对比可设置 `AREAL_STARTUP_BASELINE_GUI=/absolute/path/to/clients/gui`，交替使用两个已构建的 GUI 和同一 Core；`AREAL_STARTUP_CHECK_HIDE=1` 另验收恢复期间关闭及主动重开。报告分别保留原生首次显示和完整历史恢复时间。

通知遵循“看到后能做什么”的原则：只有需要用户决策或采取行动时才弹出，并提供必要的处理入口。后台连接、更新和已受理处理中保持安静；Worktree 保存与删除成功直接更新界面。字段校验和局部读取失败在原位置显示，历史失败提供重新加载入口；旧历史视图的迟到请求不再生成全局错误，新视图成功后清除旧错误。UNKNOWN 继续绑定原请求核对，关闭通知不会重发操作。

Renderer 仅通过窄 preload IPC 访问桌面适配器。独立适配器使用 `areal service ensure/restart/stop --json` 连接 Core，不直接管理持久 Core 服务的 PID。关闭窗口保留应用与任务；退出应用先结算所有 GUI 引擎和终端，安排停止触发、手机入口断开。再次启动读取 Core 权威历史，不重放提交。

用户可显式停止后台服务。空闲停止不取消工作；有活动轮次、目标、任务或待发输入时，只显示一次取消确认，确认范围绑定原 Desktop 和各 Core 代际。取消保留待发输入、安排、历史与草稿，暂停当前执行并等待资源结算。历史 UNKNOWN 保留原会话核查要求，但不代替活资源结算。结果分为已完成、已拒绝、仍在结算、部分完成或受理未确认；检查只读取原请求，既不重发停止，也不确认工具 UNKNOWN。旧后台未声明持久生命周期能力时保留兼容观察，不通过另一层 Core 连接代为取消。若已知旧 Desktop 留下部分停止记录，可在顶部或设置的“检查与恢复”入口检查原工作空间，再显式选择“恢复后台…”。检查读取原 Host 身份、准入与资源结算；已退出目标还需 Host 清理标记和实例／历史锁释放，不能仅凭 PID 或 socket 消失判断完成。仍未知、正在清理、忙碌或已换代时显示原因并保留记录。确认后只对核对为空闲的原代际发起新的安全停止；本次停止响应未知时只检查，不重发。全部原 Host 确认清理后才退出旧界面后台并启动当前版本；旧界面后台未响应退出时另行确认是否结束该管理进程，不向 Core/Runtime 发信号。模型配置、工作空间、历史与工具 UNKNOWN 保留，旧停止记录存档；恢复中断可重新检查并继续。`pnpm --dir clients/gui run test:legacy-recovery` 使用隔离历史 Desktop、当前 GUI/Core 与本地模型验证恢复；设置 `AREAL_RECOVERY_SCENARIO=exited` 覆盖停止已完成但响应未知的路径。

macOS 安装包将 Desktop 放在独立应用身份的 `AReaL Harness Service.app` 中，与前台共享包资源、配置、凭据名称和数据目录。Main 独占 Desktop 生命期管道写端，Desktop 独占每个 GUI Host 的写端；关闭窗口不关闭这些管道。Main 或 Desktop 消失会使下游收到 EOF 并清理引擎。`AREAL_GUI_EXECUTABLE` 配合 `node --test clients/gui/scripts/macos-service.test.mjs` 核对包内入口、owner 和管道关闭后的退出。

同一应用会话重开窗口或恢复连接时，只复用相同 owner 的后台。新应用发现旧版独立后台或其他应用会话时只提供观察与显式安全迁移，不自动认领、取消或替换。GUI 管理始终使用已选安装的绝对 CLI 路径，`ensure --no-auto-restart` 校验 owner，显式更新继续绑定原 Desktop、Core 代际及 requestId。完整 owned registry 包含已隐藏、断连项目和启动中实例。已完成目标不重复停止；受理未知只核查原请求。工作区从 Core 权威快照恢复，不重放输入。

运行中的 Desktop 后台通过 `service.commandContract` 声明当前桌面命令契约。未声明的旧后台仍可观察原任务、读取历史和管理兼容队列；生命周期写入另需 version 2 能力，但新版消息提交、评价、插件 Apps/表单、新增默认模型操作及轨迹开关会在 Main 发送前拒绝。输入和评价草稿保持原样，界面提供更新后台入口，停止确认成功后重新连接；不会探测性写入或自动重发。Core 的能力声明不能替代 Desktop 转发层的声明。

`AREAL_CORE_BIN=/absolute/path/to/private/.local/dev-bin/<slot>/areal pnpm --dir clients/gui run test:service-reopen` 验证 Renderer reload、强制崩溃后的显式刷新，以及两次窗口关闭与重开。Renderer 恢复后从权威快照重新挂接，保留 Main、Desktop、Host、Core 的进程身份、owner、代际和同一模型连接。脚本分别追加新的流片段，在生产 App 中检查历史、活动状态、草稿及新增回复，并完成原 Turn。随后用独立活动 Turn 验证应用退出与重启，要求新 owner 和代际、历史与草稿保留，且不重发中断输入。命名请求与用户执行请求分别计数；Runtime PID 按实际出现记录，不要求启动工具。`AREAL_REOPEN_FORCE_GUI=1` 将应用退出替换为 Main SIGKILL。源码 runner 的生命期连接在测试被杀后结束 Main，再由产品 owner 管道回收服务。可选 `AREAL_REOPEN_REPLACEMENT_BIN=/absolute/verified/areal` 用另一份真实 Mach-O 替换私有路径，验证同次应用窗口重开不隐式换代，随后恢复原字节和时间。未指定时验证文件时间变化不触发换代。

同窗口 Renderer 阅读恢复已有隔离真实 Electron/Core 验证，运行与边界见 [E-RECOVERY](design-system/base-evidence.md#e-recovery)。构建匹配的 Core 与 renderer 后，从仓库根运行 `AREAL_CORE_BIN=/absolute/path/to/private/.local/dev-bin/<slot>/areal node clients/gui/scripts/service-reopen-smoke.mjs --reading-slice`。Core 固定路径必须是该 checkout 内的私有普通副本。此模式核对重载、Renderer 崩溃后显式重载的已加载段落与偏移、阅读历史时的新输出、键盘返回最新以及再次重载后的跟随。原任务、草稿、执行身份与模型请求计数同时检查，不重放原提交。脚本使用隔离的源码 Electron/Core 与确定性本地模型，不证明完整应用重启后的阅读恢复、未加载历史获取、展开状态、真实供应商、其他平台或安装包验收。详细边界见 [Messages 阅读合同](renderer/src/Messages.md#同窗口-renderer-恢复阅读)。 加上 `--manual` 后，脚本先完成自动检查，再保留阅读样例与草稿供操作。看到 `Manual ready` 后可在同一窗口刷新、返回最新并比较；关闭该窗口会清理脚本自有服务。

Core 观察连接意外关闭时，项目连接所有者以 500ms 起步、最长 30s 的退避重试，通过 `service status --instance` 发现兼容的运行中实例，并用原子 `areal/thread/observe` 恢复 Thread/Task 快照、订阅和通知基线。观察恢复不重绑工具宿主；用户显式认领原生页时，才读取权威状态并在 Thread 空闲时尝试 `thread/resume` 绑定，仍受 Core 宿主冲突检查约束。恢复不重新提交任务、不同步 Provider/MCP 配置，也不执行配置 revision 屏障。旧连接的消息与异步结果失去投影写入资格。显式停止、适配器关闭、停止中的 Core 或部署指纹不兼容会阻止自动恢复；重新连接需显式操作。

GUI Main 与桌面后台的观察连接断开，或首次启动等待超时但后台稍后就绪时，也以 500ms 起步、最长 30s 的退避重新发现并认证兼容的后台，仅恢复快照与通知连接。此恢复不启动或重启后台/Core、不执行不兼容服务的退出流程、不重放结果未知的命令。明确停止和 GUI 关闭阻止自动连接；持久操作引用允许只读接回原后台核对，不能授权启动替代实例；版本不兼容等不可恢复错误保留显式重连入口。`pnpm --dir clients/gui run test:service-connection` 覆盖真实 WebSocket 的延迟就绪、未知命令、身份变化和停止边界。

并发启动或重新连接请求共享同一次后台初始化，包括异步读取持久控制记录的阶段。连接结果或失败返回给全部等待者；失败后可再次显式连接，关闭中的应用不再启动后台。该合并不重放业务命令，也不撤销已保存的停止意图。

桌面命令名、作用域、入口参数外形与错误字段由 `@areal/workbench/desktop-contract` 共享；会话配置具有具体参数类型，其他命令仍依赖运行时作用域校验。Main 保留 IPC 来源验证。嵌套配置和执行规则归 Core；字符串或数字 `code`、`submissionUnknown`、`requestId` 穿过适配器和 Main，供界面核对未知结果。

`pnpm --dir clients/gui run test:mcp-platform` 通过生产 React 组件和注入的 `PlatformServices` 替身，验证 MCP 图标加载、缺少桌面能力时的行为，以及普通重渲染不会重建订阅。脚本使用已安装的 Chrome，或由 `AREAL_GUI_TEST_BROWSER` 指定的 Chromium 可执行文件，并保存截图、源码指纹和报告。该检查不覆盖 Electron IPC、Core 执行或安装包。

原生预览由 Main 按项目/Thread 归属管理，每窗口最多 8 个原生页面、每 Workspace 最多 4 个逻辑页面。空闲 LRU 驱逐排除执行中、控制交接中、可见人工页、准备计划和文件交接页；没有候选时拒绝新页。隐藏面板保留页面；归档任务、隐藏项目和窗口退出释放对应 WebContents，迟到的 show 请求不能复活已失效归属。驱逐保留同一 Page shell 的 URL/标题并报告状态损失，重开提升 pageGeneration；导航历史和页面内存不保证恢复，未知操作不会自动重放。所有项目和聊天共用当前 GUI userData 中的持久 Profile，关闭最后一页不删除登录态；页面控制权和审批仍按聊天隔离。浏览器设置提供显式 Chrome Cookie/localStorage 导入、清缓存和确认后的全部数据清理。上限约束原生页面数量，不是整个 Electron 进程内存配额。预览不暴露 preload、Node 或产品 bridge。

`preview-residency.cjs` 根据现有页面记录和 Map 顺序，纯计算 pinned 状态及容量决策。`CorePreview` 继续负责归属校验、原生视图、挂起和释放，不维护第二份 LRU 状态。`test:architecture` 在三个有效会话中验证 4 页拒绝、8 个原生页上限、可见页保护、同一逻辑页的驱逐与崩溃恢复，以及归档和隐藏项目后的资源释放。

适配器保留已有凭据加密、订阅转发和手机配对职责，不运行另一套 Agent 循环。订阅转发的本地能力令牌和固定 loopback 端口在私有目录的 0600 文件中持久化；上游账号/API 凭据继续使用系统安全存储。适配器退出会中断当时的转发 HTTP 响应；稳定地址允许后续请求恢复，不保证崩溃中的流继续。GUI 正常退出保留适配器。

全新配置尚无手机配对记录时，远程入口保持关闭，启动不检查系统安全存储；首次启用时才检查并使用它。已有加密配对仍须成功解密，不因钥匙串错误清空、覆盖或自动启用入口。

服务注册默认位于 `~/.areal/gui/<GUI 数据目录摘要>`，避免 macOS Unix socket 路径过长；GUI 通过 `AREAL_HARNESS_SERVICE_HOME` 隔离注册，不改变 Core 的默认配置位置。CLI 如需连接相同实例，应显式使用 GUI 的 `AREAL_HARNESS_SERVICE_HOME` 与实例描述；共享配置不代表共享运行数据。认证描述不交给 Renderer。契约见[共享本地服务](../../docs/api/local-service.md)。

## 候选构建与安装包验收

统一入口（从仓库根执行，自动构建 release Core、安装依赖、构建 GUI 和归档）：

```sh
pnpm --dir clients/gui run dist --platform mac --arch arm64 --formats dmg,zip --signing none
pnpm --dir clients/gui run dist --platform mac --arch arm64 --formats dmg --signing adhoc
pnpm --dir clients/gui run dist --platform mac --arch arm64 --formats dmg,zip --signing developer-id --identity "$CSC_NAME" --keychain-profile "$APPLE_KEYCHAIN_PROFILE"
```

`--formats` 可选 `dmg`、`zip` 或 `dmg,zip`；`--output` 指定全新目录，默认生成独立时间戳目录，拒绝覆盖。`none` 不新增签名，保留输入已有签名，不保证应用签名有效或可启动；DMG 仅对字节完全一致的双份 Framework 去重。`adhoc` 是本地签名，不做公证。`developer-id` 复用现有签名、公证及安装包验收，要求两种格式；最终产物位于输出的 `signed/`，Apple 尚在处理时退出 2，使用 `pnpm --dir clients/gui run sign:mac --resume --output /absolute/output/signed` 恢复，不能重新提交未知状态的请求。此命令不发布。

仅需签名、公证和归档时，Developer ID 命令可加 `--skip-tests`；恢复同一公证时也可用 `sign:mac --resume --skip-tests --output ...`。它跳过签名后的桌面 smoke 与模型专项，回执标记为 `skipped-by-request`；签名、Apple 公证、stapling、Gatekeeper、Core 完整性及 DMG 体积检查仍执行。签名前的历史输入预检保留。此模式不能宣称功能验收通过，正式发布整理仍要求测试通过。

当前支持矩阵只有 **macOS arm64 原生构建**；Linux、Windows、x64 和跨平台构建显式报错，待各平台打包及服务所有者实现后接入同一入口。ZIP 不受 DMG 体积预算限制。DMG 在本地导出及正式发布整理时统一检查 **≤250 MiB（262,144,000 字节）**，超出即失败；不得绕过专用导出器临时创建交付镜像。可单独检查现有产物：`node clients/gui/scripts/dmg-size.mjs /absolute/package.dmg`。GUI CI 保留 DMG 暂存测试，不执行完整 release DMG 打包；安装包由本地构建、验收并上传。候选构建成功不等于安装或 GUI 功能验收通过。

工作区只排除 `app-builder-lib@26.15.3` 的 Squirrel.Windows 后端，依据是该打包入口的 macOS arm64 支持边界。macOS 自动更新继续使用 `electron-updater` 与 Electron 的 `autoUpdater`。

```sh
make release
AREAL_CORE_PROFILE=release AREAL_GUI_PACKAGE_DIR=/absolute/new-package make gui-package
pnpm --dir clients/gui run sign:mac --app "/absolute/new-package/package/mac-arm64/AReaL Harness GUI.app" \
  --output /absolute/new-signed-directory --identity "Developer ID Application: Name (TEAMID)" \
  --keychain-profile areal-harness
```

`gui-package` 只构建 macOS arm64 候选应用，默认使用已构建的 debug Core；安装包使用上面的 release Core。候选输出包含 `.app`、ad-hoc ZIP 和 DMG、依赖清单与 Core 完整性清单，不能作为安装包验收完成结果。`sign:mac` 在独立副本中完成 Developer ID 签名、app/DMG Apple 公证、stapling、Gatekeeper 和通用桌面及模型专项验收；通过后交付其最终 ZIP/DMG。使用全新输出目录，并将包内 Core revision 与最终修复提交绑定。候选包不配置自动更新，签名和公证不执行发布。正式发布与更新频道见[发行流程](../../docs/development/releasing.md#gui-发布)。

构建候选包时，可用 `AREAL_GUI_CORE_BUNDLE=/absolute/core-bundle` 复用已冻结的 Core bundle；打包仍校验内嵌组件哈希，正式发布只接受 `release` Core。该设置仅影响打包输入。

本地 ad-hoc 打包先显式签名 Frameworks 内主应用和后台服务的动态库及 Node 扩展，再封装签名外层应用；不沿资源符号链接修改 Core。单独通过 `codesign --verify --deep --strict` 不能证明 Chromium 受限子进程能够加载动态库，仍需真实启动并验证 Renderer、GPU、网络及后台服务。此流程不替代 Developer ID、公证或安装验收，也不关闭沙箱。

`make gui-smoke` 使用真实 Electron/Core/Runtime 和确定性本地 HTTP 模型，原生沙箱保持启用；项目选择对话框注入临时工作区，测试目录隔离。本地模型请求直连 loopback，测试保留并合并已有 `NO_PROXY` / `no_proxy` 条目。截图及 `manifest.json` 留在命令打印的临时目录，清单记录运行前后的 Core 二进制校验和及失败原因。安装包测试可设置 `AREAL_GUI_EXECUTABLE=/absolute/App.app/Contents/MacOS/AReaL\ Harness\ GUI`，此时不使用外部 Core 路径。实际账号登录、付费模型、其他操作系统和签名安装分发须单独验收。

更新恢复与菜单停止共用生命周期观察和停止流程。普通停止仍保护包含 pending 输入的暂停 Queue；明确取消会保留输入与安排，并将 cancel 意图传到最终公共服务宿主。确认后项目范围或 Core generation 变化会要求重新确认；多项目部分退出或未知结果不会显示成恢复正常。`pnpm --dir clients/gui run test:lifecycle` 验证真实 Core 的 Queue 保留、安全退出，以及隔离 Electron 的菜单取消、不同配置路径下接回原后台和更新恢复；普通重开不弹恢复对话框，明确停止的原生确认由 fixture 应答，不进行更新下载或安装。

单轮暂停后，Composer 等待 Main 确认原操作结算才恢复发送和继续执行，不能仅凭 Core 已显示 `interrupted` 开放提交。期间可编辑草稿，结算不会自动发送。未知回执仍通过原请求核查，不重复暂停或重发输入。`test:stop-turn` 使用真实 Core 与回执屏障验证这个顺序、草稿保留和结算后的一次显式发送。

缺少 `cancelStop` 的旧后台只在明确 busy 拒绝后使用兼容取消。取消前，可信 Main 将原启用安排的工作区、任务、时间与运行身份写入私有 `legacy-schedule-recovery.json`；旧 Core 自行暂停或安全停止前临时暂停安排后，新后台先确认旧进程退出，再核对任务修订号，仅恢复安排，不恢复已暂停 Run。未知提交不自动重发，任务变化或恢复失败保留记录并提示人工核对。专项 `test:lifecycle:legacy` 需要 `AREAL_CORE_BIN` 和 `AREAL_LEGACY_CORE_BIN` 分别指向已核对的新旧 Core；使用归档旧 adapter 源码、当前 renderer/依赖与隔离数据，不安装或发布版本。可用 `AREAL_LEGACY_PAUSE_UNKNOWN=1` 注入暂停回执丢失。

Core 构建完成后再启动使用该二进制的桌面 smoke，验收期间不重新链接它。模型专项等待保存完成及 Core 的模型选择状态，再进行下一步操作；GUI CI 运行该专项并上传其日志、截图和 manifest。Core 模型配置子进程失败时，后台服务日志保留操作、退出码、signal 和超时分类，不记录密钥或完整环境。

`pnpm --dir clients/gui run test:side-chat-parity` 验证当前默认的可执行侧边聊天 P1–P6：工具与权限、来源上下文隔离、临时标签生命周期、选区引用、Composer 与斜杠命令、Esc 停止归属。CI 将其作为独立 smoke 场景，使用同一提交归档中的 Core/Runtime；本地运行通过绝对路径 `AREAL_CORE_BIN` 指定已冻结的产物。

`pnpm --dir clients/gui run test:conversation-derivation` 验证 Fork、主聊选区及当前可执行 Side Chat 入口，核对显式发送、来源身份与配置隔离。`test:side-chat-parity` 覆盖当前 Side 的权限、历史、多标签、引用、Composer 和停止归属。旧只读旁路的授权、历史恢复与 UNKNOWN 契约由 Core 的 `side_access`、`side_history_recovery` 保留；`side_workspace_read` 在 macOS native 与 Linux 受控容器显式运行，验证真实沙箱下的只读文件访问。生产 GUI 回归不再寻找已移除的历史旁路菜单。

`pnpm --dir clients/gui run test:connection` 验证真实 Core 断线恢复、并发操作、旧连接消息隔离及显式关闭；`pnpm --dir clients/gui run test:architecture` 通过真实 Electron IPC 验证契约拒绝、错误码透传及原生预览的驱逐、崩溃重建和归属释放。两者使用隔离目录并输出证据，不替代安装包验收。

第三方归属见 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES.md)。运行时图标沿用源仓库版本；不迁入采集档案、开发 Skills/AGENTS 或来源 Git 历史。

## Cloud 后端配置

Cloud 使用 AReaL 原生 app-server WebSocket 接口。设置中填写固定 Arena 服务地址，例如 `https://host/openapi/v1/app-server/`，以及自己的 token；不填写 workspace。只填写主机时补全标准路径。保存和打开配置页只读写本机加密配置，不连接远端、不分配沙箱。旧 Arena 配置的 workspace 后缀会从服务地址投影中移除，已有会话保留原 endpoint。

项目新聊天选择 Cloud 时只编辑本地草稿，不分配工作区；首次发送时生成并持久保存会话 UUID，以该 ID 作为 workspace 连接 `/openapi/v1/app-server/<session-id>/`，连接成功后指示变绿。不同 Cloud 会话使用独立沙箱和 UPFS 子路径；同一会话的 query 使用原生 `turn/start` 直接发往既有沙箱。冷启动最多等待三分钟。token 通过系统安全存储加密，改变目标服务地址需提供新 token。

会话保存 Session ID、endpoint 和原生 thread 身份。打开已断开的会话不唤醒沙箱，下一条消息会重新连接、读取权威历史，再提交新 query，不重放旧 query。若断线前显示运行中，点击“恢复连接”读取权威状态后再继续；恢复只接回原会话，不重发提交结果未知的消息。Arena 默认在连续空闲 15 分钟后安全排空并销毁沙箱；时长和默认 Harness 由服务端“Agent 与 Harness 演进”配置。运行中的推理、工具、队列、Goal 或未确认资源不回收。原 Session 和 UPFS 保留，后续消息启动新沙箱代际并挂回同一子路径。回收要求运行包支持 Core 的空闲判定与 writer 隔离；旧运行包不会被盲目销毁。关闭 GUI 只断开客户端。

Cloud 支持文本及图片、音频、文件附件；可选择文件、粘贴图片或拖拽，支持纯附件发送和历史附件预览／下载。字节通过认证的原生 Blob 接口写入远端 Core，保持 Arena 工作区路径与 Thread 授权，不上传本地项目、模型、Skill 或浏览器。每条消息最多 16 个附件，每个 1 B–16 MiB；具体 MIME 和模型输入能力由远端 Core 校验。传输成功不代表模型支持该类型；不支持会明确报错，不会悄悄改为文本。草稿文件及已接受上传回执可在当前 GUI 进程内跨会话切换保留，重载页面或重启后需重新选择未发送文件；已发送附件从远端历史恢复。上传或 Turn 提交结果未知时禁止自动重发。旧版本保存了 Arena sessionId 的会话保留在本机，但本入口不会自动转换或创建替代会话；请用原客户端继续访问旧会话。CLI/TUI 的原生连接命令见[客户端指南](../../docs/guides/clients.md#统一远端-app-server)。

Cloud 对话的已读标记保存在本地导航元数据中，不要求云端支持桌面整理命令。

`pnpm --dir clients/gui run test:cloud-lifecycle` 使用构建后的真实 Renderer 和 Cloud 适配器，以及本地 WebSocket 协议替身，验证保存和打开新聊天不连接、首次发送后会话 workspace 隔离、连接指示与销毁后的同会话恢复，并输出截图和请求记录；不替代真实 ARCA、UPFS 或模型验收。
交互设计从[用户交互模式](design-system/interactions.md)进入，页面是既有模式的组合；[设置页阶段一](design-system/exercises/settings-stage1.md)使用真实隔离Electron验证，第二阶段在审查后选择。

真实对话的发送、命令、子代理及面板返回迁移和同状态验证见[对话阶段二](design-system/exercises/conversation-stage2.md)。

## 界面语言与文案开发

设置 → 常规 → 语言支持简体中文和 English，切换立即生效并在重启后保留。已有安装默认简体中文。语言归 Renderer 现有 application preferences 所有，不进入 Core 模型配置或会话身份。

本次复用固定版本 React Intl 12.1.5，其 BSD-3-Clause 许可保留在 licenses/react-intl-LICENSE。它兼容现有 formatMessage 调用，并提供 ICU、复数、数字与日期格式化。2026-10-21 调研过 react-i18next 17.1.0 与 Lingui 6.10.0；它们均为 MIT 许可，但前者需要迁移既有 Intl 调用，后者增加宏与词库编译工作流。本次只维护语言偏好与产品词条，不自研消息引擎。依据见 [React Intl](https://formatjs.github.io/docs/react-intl/)、[react-i18next](https://react.i18next.com/latest/usetranslation-hook) 和 [Lingui](https://lingui.dev/tutorials/react/) 官方文档。

后续界面文案修改须在同一改动中完成以下工作。

- 在 renderer/src/i18n/messages/ 的同一语义 ID 下提供 zh-CN 和 en，调用 useI18n() 的 t(id, values)。按钮、提示、占位、空态、校验、无障碍名称和展开状态都属于文案。
- 用完整 ICU 消息表达动态句子和复数，以当前 intl 格式化数字、时间和日期。持续显示的本地提示保存 UiMessage 与原始参数，在渲染时翻译。
- 保留用户输入、第三方名称与正文、原始诊断。内部路由、配置值、React key、测试 ID 与日历存储键保持稳定，不使用翻译后的文案。
- 在两种语言下检查受影响路径、窄窗口及必要的草稿保留行为，并运行 typecheck、verify:i18n 和相关验收。

```sh
pnpm --dir clients/gui typecheck
pnpm --dir clients/gui verify:i18n
make gui-build
AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:i18n
AREAL_CORE_BIN=/absolute/path/to/areal pnpm --dir clients/gui test:i18n-native
```

普通 verify 已包含 verify:i18n。它验证双语词条完整、ICU 语法和参数一致，检查设置源码和直接共用控件的裸文案，并相对于 Git 基线阻止其他生产 Renderer 新增可见裸文案。CI 沿用 AREAL_DESIGN_BASE，也可设置 AREAL_I18N_BASE。技术示例、品牌和稳定身份有精确例外。provider-ui-state.js 保留纯数据投影合同，由 React 消费者翻译状态。静态检查不追踪任意动态字符串流，仍需实际界面复核。

test:i18n 复用现有隔离 Electron/Core 迁移 smoke，保留截图、ARIA 和 manifest。覆盖双语切换、英文导航、双语搜索、窄窗大字号、草稿返回和重启持久化。

Main 直接生成的归档、会话与诊断导出、目录选择、浏览器授权、退出及恢复确认文案跟随界面语言。Renderer 启动和偏好更新通过受来源校验的窄 IPC 同步语言，Main 只保留易失投影，不另存偏好或改变 Core 请求。首次同步前的启动提示仍使用默认简体中文。原生菜单、其他服务及插件生成的提示、外部应用 iframe、原始诊断，以及尚未迁移的界面保留原文。

test:i18n-native 使用同一隔离 runner，覆盖双语归档、会话与诊断导出、目录选择、本地错误、取消、语言校验和保存英文后的重启。它截获 Electron dialog API 的参数与取消结果，保留截图、ARIA、原生文案 JSON 和 manifest，不代表系统弹窗外观、安装包或其他操作系统验收。

对话增量文案沿用相同门禁。`test:context-usage` 另验上下文、用量详情和执行过程控件的双语切换、窄窗显示及草稿和 Core 历史保留。旧状态、耗时、上下文分类名和原始输出仍属于未迁移范围。

## 安装与更新

检查更新遇到网络变化等错误时，点击蓝色更新按钮可重新检查。发现新版本后再次点击才会下载；若确认已是最新版，错误提示会消失。下载或原生校验失败后，同一按钮重试当前版本。

正式 macOS arm64 包使用 DMG 首次安装、ZIP 自动更新，并保留 Developer ID 签名和 Apple 公证。下载后先校验同一 Release 的 `SHA256SUMS`；从 DMG 将应用拖入所选安装目录，再打开应用，按 macOS 提示处理安全与隐私权限。

升级前备份 GUI 数据（默认 `~/Library/Application Support/AReaL Harness GUI`）、共享配置 `~/.areal` 和自定义项目数据。下载不停止任务；原生校验完成后等待活动任务、队列和后台操作安全结算，再停止后台并交给系统替换/重开。停止受理结果未知时检查原后台资源，不重复提交安装。下载/校验失败可重试；交接系统后未重开时手动打开原安装位置并核对版本。程序回退不等于数据降级，恢复旧程序时可能需要同步恢复备份；凭据继续使用原安全存储，备份目录不代表可跨机器迁移钥匙串。

预览包仅供手动安装，使用 ad-hoc 签名，不执行 Developer ID 分发签名或公证，也不推进正式更新频道。使用隔离数据或先做备份；预览数据格式不保证旧正式版可读，预览转正式需要手动安装并单独验证。不要关闭安全防护或清除隔离标记来绕过系统拦截。

浏览器与电脑自动化的实现边界见 [Browser](../../docs/api/browser.md) 和[电脑控制](../../docs/api/computer.md)。`pnpm --dir clients/gui run test:automation` 使用隔离 Electron/Core 与合成站点；原生输入验收只操作独立测试应用，需已有系统授权。Helper 构建随 GUI build 执行。源码验收不代表安装包、公证或真实供应商验收。
