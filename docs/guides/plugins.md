**中文** | [English](plugins.en.md)

# 插件包兼容

AReaL 的插件包由共享 Core 管理；GUI 与 CLI 读取同一安装与启用状态。支持本地/Git marketplace、Git 与 npm 来源、兼容 manifest 中的 Skills，以及显式 onboarding；插件 MCP、Apps 和 GitHub Connector 通过现有 Core 执行边界接入。固定格式基线见 [upstream/pins.json](../../upstream/pins.json)，完整实施与验收见[任务计划](../development/codex-plugins-plan.md)。

## 查看组件支持

打开插件详情可查看安装组件报告。目录快照变化时，候选报告单独显示。安装更新前核对两个完整摘要。报告可以同时显示受支持的 Skills 和不支持的 commands、agents 或 UI 声明，这表示包只部分兼容，不能据此认定全部能力可用。

展开逐项声明可查看解析契约、原因与使用前提。当前 MCP 连接、认证以及 Hook 定义信任仍由原有面板显示。目标会话的 Profile 决定实际准入。查看报告不会启动 setup、包代码、连接、认证或模型请求。

CLI 使用 `areal plugins --workspace /path/to/project read <plugin-id>` 读取同一 Core 报告。同一命令与工作区下的 `mcp-list`、`hooks-list` 提供当前连接和信任事实。核对 `pluginId` 与 `installedDigest`，不能把候选摘要当作安装版本。静态报告中的真实供应商、平台和签名发行包验收保持未核实。

Portable 作者可通过 `extensions.org.areal.componentRequirements` 声明静态必需 kind，例如 `{"version":1,"requiredKinds":["skills"]}`。每个必需 kind 的全部声明记录必须受支持。不兼容的必需 kind 会让包保留安装以供检查，但排除有效激活。可选 unsupported 声明不会禁用有效 Skill。该语义只适用于已识别的 portable 1.0.0 manifest。严格字段及限制见 [API 契约](../api/desktop.md#组件支持报告)。支持 `.zcode-plugin` 的有限组件导入；完整宿主 SDK 与其他差异见下文。

历史 Skill 保留自身包摘要的静态兼容性要求。安装兼容的新版本不会解锁被阻止的旧引用。兼容的旧引用可继续使用，直到当前包被阻止、停用或卸载。

## Claude Code 与 ZCode 的兼容范围

Core 继续使用同一个 Store、不可变原包缓存和管理回执。原包不会被改写为 AReaL manifest。可移植 Agent Plugins 1.0.0 优先，其后依次选择 Codex、Claude、Cursor、ZCode manifest。未知可移植 schema 不降级到其他格式。OpenAI inline extension 仍整体替代兼容 overlay。

Claude 市场允许由条目定义没有独立 manifest 的插件。例如 `source: "./"` 与 `skills: ["./skills/review"]` 只选择该条目的 Skill，不把同根其他条目的技能混入。`strict` 默认 true，存在 manifest 时追加条目的组件路径；`strict:false` 与 manifest、条目组件同时存在时拒绝冲突。Claude 有独立 manifest 时，只有条目的 commands、agents、skills、hooks、outputStyles、themes 参与合并和 strict 冲突。条目中的 MCP、LSP、userConfig、channels、apps、UI 不覆盖 manifest。显式 Claude skills 路径与默认目录相加。Claude MCP 按默认文件、显式文档的顺序合并，同名服务保留最后定义。manifestless 显式列表仍按条目限定。ZCode 的默认 skills 目录与显式路径相加。新导入格式首批只执行 Skills 与已支持的 MCP；commands、agents、UI、宿主专用 SDK 和未支持的 hook 语义仍明确诊断，不因安装而执行。

目录 source 的相对路径和 `directory` 类型均受市场根边界约束。`github` 来源归一到固定 Git 来源，再沿原有显式解析和审阅步骤安装。HTTP JSON 市场、marketplace archive source、command source 与 pip 不在本批范围。手工 ZIP 导入是独立入口，不能用它证明对应市场 source 已支持。相同字段名按所属格式解释，不把 Git URL 自动当成 JSON catalog。

项目范围选择按实际执行工作区路径隔离。原工作区的项目范围选择不会自动启用于另一个 worktree；应单独核对新执行目录中的插件范围。

`sourceDigest` 始终描述当前候选的原包字节。消费市场条目定义的候选另有 `admissionDigest`。安装时 `expectedDigest` 使用 `admissionDigest ?? sourceDigest`，界面与 CLI 自动选择正确身份。`installedDigest` 描述有效安装快照，`installedSourceDigest` 单独描述已安装原包。市场条目只改组件选择、来源或执行前提，也会要求重新审阅。安装后读取、重启及历史引用使用固定定义，不重新读取可变市场。旧无上下文包保留原摘要和收据行为。旧客户端只提交原包摘要时不能安装需要新审阅身份的候选。

自有可移植包可以声明 `extensions.org.areal.hostRequirements` 为 `{"version":1,"tools":["browser_v1"]}`。这些要求只收窄可用性，不注册、开启或授权工具。桌面试用前检查当前部署；Core 在实际会话与 Turn 准入时检查可用工具及 Profile 限制。电脑控制关闭或使用不同 provider 时，要求 `computer_v1` 的 Skill 不会自动切换输入通道。工具存在不代表 OS 权限已授予，审批、系统权限、Stop 与 UNKNOWN 规则继续由原所有者执行。没有结构化声明的任意 Skill 文本不被当作可自动推断的完整依赖图，其行为兼容保持未验证。

仓库提供 [本地市场示例](../../examples/plugin-marketplace/README.zh-CN.md)，包含调用现有工具的 AReaL 浏览器和电脑适配 Skill。它们是 AReaL 适配包，不宣称原始 ZCode JavaScript SDK 可以原样执行。创建技能继续使用既有 **Create Skill** 和固定官方 Creator，市场发现、创建产物和发布分别处理。

## 插件、Skills 与 MCP

左侧“插件”打开插件市场。公共和个人目录按已注册来源展示，Skills 和已安装插件在同一工作区导航。点击插件或 Skill 打开内容页，可返回原列表。Skills 页的已安装总览默认展示六项，点击“查看更多”展开。下方通过“个人”和项目标签浏览各来源的已安装技能，各自保留展开状态；搜索展示全部匹配结果。市场操作使用此前明确选择的项目；尚未选择项目时，先选择或打开项目。浏览不会创建任务目录。

“设置 → 插件”管理已安装的插件、MCP、Skills 和市场来源。Skills 和 MCP 同时展示独立资源与已安装包内的组件，并标明来源。同名资源按所有者区分，不复制配置或合并身份。

插件沿用 OpenAI 的包结构。便携包使用根目录 `plugin.json`、`skills/` 和 `mcp.json`，OpenAI 专用设置位于 `extensions.com.openai`；兼容 manifest 仍按既有规则解析。安装、启用、认证与连接状态由 AReaL 的原有所有者管理，不写回包声明。

独立技能支持内容页和范围启停；“创建 Skill”先核对所选项目当前部署的任务配置，再进入该项目的普通聊天草稿并加载产品内固定版本的官方 Skill Creator。旧任务保留原配置；产品默认部署下保存的基础配置会使用当前资源版本，自定义受限配置不会获得额外权限。用户发送需求后，Agent 按 Creator 流程在该项目的 `.agents/skills/<skill-name>/` 中创建并校验技能。该资源保留上游版本、许可证与内容摘要，不读取其他 Agent 应用的本机配置。独立 MCP 保留配置编辑与连接入口。范围选择只筛选独立资源。包内组件显示当前项目的选择；详情页“管理”打开同一插件的设置，保留整包范围、摘要信任、认证和提交核对流程。每个 Skill 与 MCP 服务都有当前项目开关。关闭选择跨更新保留，卸载清除；包声明和会话 Profile 继续限制实际准入。包内组件不通过独立资源接口修改，目录展示不扩大当前聊天的有效技能或工具范围。

官方 Creator 的初始化和校验脚本需要 Python 3 与 PyYAML。选择 Skill 本身不扩大 Runtime 文件权限。受限任务通过 `skill_read` 分页读取脚本，再由 Runtime 将返回的原始字节写入授权工作区的临时目录后执行；不会直接执行 Desktop 私有缓存中的文件。`clients/gui/scripts/plugin-concepts-smoke.mjs --creator-only` 验证空项目普通首轮中的资源读取、项目内创建和官方校验，可用 `AREAL_TEST_PYTHON` 指定解释器；该解释器须在隔离 HOME、禁用用户 site-packages 的环境中仍能导入 `yaml`。

交互应用和 Hooks 位于插件详情或已有工作区入口。GitHub 在用户界面中作为插件管理，Connector 仅保留为内部服务映射与凭据绑定。

详情页展示已安装版本的真实介绍、使用示例和声明组件，来源审核单独显示候选版本。没有声明的 Skills/MCP 区块不显示。网站和法律链接可以复制。只有 Skills 的包无需登录；混合包中的 Skill 不等待 MCP 认证。安装不会连接服务，浏览器授权、密钥配置、Connector 映射和连接继续走各服务的明确步骤。

普通聊天与新建聊天草稿输入 `@`，可选择已安装、已启用且在当前上下文可用的插件。选择插入插件标签，不发送消息；原 MCP 资源搜索保留在同一菜单。发送时重新核对安装摘要、已选择的精确 Skill 引用和启用服务，把可读插件意图与允许的 Skill 内容交给模型。选择后关闭、更新或卸载插件会阻止发送并保留草稿。删除插件标签只移除它隐含附加的 Skills，单独选择的 Skill 标签保留。Side 的插件标签标为“仅作引用”，只传递意图，保留现有只读权限。

关闭 Skill 会立即拒绝新的发现、旧版本读取和设置流程。改变任一 MCP 开关会撤销该插件的所有连接代并清除自动重连信任，其他仍开启的服务也需显式重连。重新开启不会自动授权或连接。清理状态为 UNKNOWN 时，关闭选择已经保存，但不能宣称后台已退出；核对原回执，不重复提交未知写入。

## 发现与安装

在工作区或个人目录的 `.agents/plugins/marketplace.json` 声明本地插件：

```json
{
  "name": "team-tools",
  "plugins": [{
    "name": "review-helper",
    "source": {"source": "local", "path": "./plugins/review-helper"},
    "policy": {"installation": "AVAILABLE", "authentication": "ON_USE"},
    "category": "Productivity"
  }]
}
```

路径相对 marketplace 根，不相对 `.agents/plugins` 文件所在目录。可在插件市场右上角“添加 → 添加市场”添加本地 marketplace 根目录或 Git 来源，查看组件并安装。安装固定已选来源和内容摘要；预览后源文件变化会拒绝安装，需要刷新后重新选择。安装不执行包中的脚本、MCP 或 hooks，也不自动运行 setup。

“添加 → 上传插件包”选择本机 ZIP，导入后先审核摘要，再安装。支持包根目录或一层外包目录。压缩文件和展开内容各最多 64 MiB，最多 4096 个条目。链接、越界路径、重复路径、加密、多卷和 ZIP64 归档会被拒绝。导入不执行插件。

CLI 连接到已经运行的 Core，保持运行服务的配置：

```sh
areal service ensure --workspace /absolute/workspace --json
areal plugin --workspace /absolute/workspace list --json
areal plugin --workspace /absolute/workspace marketplace-add /absolute/marketplace
areal plugin --workspace /absolute/workspace marketplace-add-git https://github.com/TEAM/catalog.git --ref-name main
areal plugin --workspace /absolute/workspace resolve review-helper@team-tools
areal plugin --workspace /absolute/workspace read review-helper@team-tools
areal plugin --workspace /absolute/workspace install review-helper@team-tools --scope project
areal plugin --workspace /absolute/workspace setup review-helper@team-tools
areal plugin --workspace /absolute/workspace connect review-helper@team-tools --expected-digest REVIEWED_INSTALLED_DIGEST
areal plugin --workspace /absolute/workspace mcp-list
areal plugin --workspace /absolute/workspace disconnect review-helper@team-tools
areal plugin --workspace /absolute/workspace disable review-helper@team-tools --scope project
```

用户选择作为默认值，项目的明确选择覆盖用户默认；它们不代表更高权限的强制要求。产品生成的普通标准 Profile 明确启用 `allowPluginSkills`，因此可选择已启用插件的 Skills。其他显式 Profile 未声明该权限时，不会自动获得插件 Skills。MCP 必须明确核对已安装摘要后连接；Connector 必须映射原始 ID 并配置账户。未支持的 hook handler、认证机制、旧命令或依赖显示诊断。“已安装”不代表服务器已经连接。

## Skills 与设置流程

普通聊天可在 Skills 目录选择已启用插件的技能。禁止隐式调用的 Skill 仍可以显式选择。资源按需分页读取；同包共享资源可以通过相对路径读取，最终路径必须留在固定安装包内。独立 Skill 保留原有实时文件与路径限制。

Rust 嵌入式调用通过 `Engine::install_plugin_store` 接入插件。未配置默认 Profile 或插件 Store 的纯 Engine 会话保留原有轻量状态，不因插件代码可用而注入桌面指令或改变上下文预算。

“运行设置”在普通聊天中选择包内 onboarding Skill；用户可以打开该对话查看结果与审批。它使用普通 Core 模型执行和受理回执，不是具有额外权限的安装脚本。Side 和受限 Profile 不能借 setup 扩大范围。没有可用模型时配置模型后再运行。

## 版本、停用与恢复

安装副本按内容摘要保留，源目录编辑不改变已经安装的资源。活动 Turn 固定插件技能引用；后续 Turn 使用当前可用版本。停用和卸载立即阻止后续资源读取，保留旧包用于历史，不默认删除可写数据。活动 Turn 的工具 schema 和调用对象一起固定；升级为后续 Turn 建立新连接，旧连接等待已有调用和 App 排空。停用、卸载和显式断开撤销调用。清理未确认显示 UNKNOWN 并阻止重连；显式断开也清除自动重连信任。

新会话应用独立技能配置时可能重启 Core。桌面恢复此前已连接的独立 MCP 和已信任的插件 MCP；插件恢复仍须匹配原安装摘要，失败不重放工具调用。交互应用在创建会话后重新读取同一插件版本的当前连接，再执行首次打开。

普通会话的消息和受理回执先由 Core 保存，可信插件的自动重连随后准备首轮模型工具。插件认证或初始化仍在等待时，已受理的消息可见，模型尚未开始请求。取消本轮不会丢弃共享连接的清理；准备尚未结束时，后台生命周期仍报告资源未结算。重连只使用本轮受理时允许的已信任插件摘要，不扩大受限 Profile 的权限。

Core 管理写入要求 `requestId` 与必要的 `expectedRevision`；RPC 安装还要求选中 `source` 和 `expectedDigest`。重复同键同参数查询原结果，异参数拒绝。界面遇到结果未知可“核对插件提交”，只读查询受理回执，不重新执行：

```sh
areal plugin --workspace /absolute/workspace submission REQUEST_ID
```

添加、移除、更新 marketplace 和卸载插件成功后，若完整目录回执超过 256 KiB，RPC 返回 `{"revision":N,"catalogRefreshRequired":true}`。变更已在版本 N 完成，再用 `areal/plugin/list` 读取完整当前目录。CLI 遇到此标记会读取一次当前目录并输出到 stdout，stderr 标明请求 ID、原回执版本与当前目录。后续读取失败时，CLI 仍明确报告原变更已成功，并提供请求 ID；不要重放变更。`submission` 保留原始历史回执，不读取当前目录来替换它。

权限归 Core；观察者和限制到特定 Thread 的身份不能进行全局插件管理。安装状态存在 Core 配置 home 的 `plugins/`，不修改 Codex 的缓存或配置。

## Git/npm 与 MCP

在“添加市场”选择 Git marketplace；包条目可以使用以下来源。Git ref 固定到 commit，npm 版本范围解析到具体版本与 integrity；下载和安装不运行 npm lifecycle scripts。

GUI 的 Git marketplace 添加和 marketplace 更新请求最多等待 120 秒，仍受外层 150 秒服务期限约束。超时或断开后结果可能未知，应核对原提交回执，不自动重发。

```json
{"name":"example","source":{"source":"git-subdir","url":"https://github.com/example/plugins.git","ref":"main","path":"plugins/example"}}
{"name":"example","source":{"source":"npm","package":"@example/plugin","version":"^1.0.0"}}
```

详情中先“解析并预览来源”，核对提交、版本和摘要，再勾选确认并安装。候选摘要与已安装摘要分开显示。连接必须确认已安装摘要；新版本安装后需要再次核对。MCP 配置按便携/legacy 格式归一化；命令、环境和认证字段不作为管理结果返回。服务器策略控制工具启用、必需性、审批和模型可见输出预算；失败不等于包已卸载。

认证配置支持 provided、DCR、CIMD preference、声明的 endpoint/resource/OIDC/scopes，以及 API-key bearer/basic/custom header。没有宿主可信 metadata URL 的 CIMD preference 回退 DCR；不会借用 OpenAI 客户端身份。OAuth client secret 和签名私钥在详情中配置并由 Main 安全存储，Core 只持引用。`ON_INSTALL` 安装后显示待认证并门控声明认证的服务；`ON_USE` 在需要时提出需求，mixed 可先匿名使用公开能力。

OAuth 使用私有存储和 loopback PKCE callback。scope override（包括空列表）在授权与刷新时保留；认证挑战只交给认证所有者。服务要求增加权限时，同一绑定的授权请求保留已授予权限；取消后重试也保留，待授权权限不会被当成已授予权限，新配置或账号不继承旧授权。工具级拒绝绑定实际发送的 token，不误删并发刷新得到的新 token，也不自动重发 MCP 操作。实现与真实服务证据分开记录，见[验收矩阵](../development/codex-plugins-p1-p3-acceptance.md)。

缓存凭据恢复只发现授权元数据，不向原 MCP 资源端点发送探测请求。标准 well-known 地址或显式配置的端点可用于静默恢复；若服务仅通过自定义认证挑战提供元数据地址，冷启动后需显式认证以恢复该发现路径。真实请求返回的挑战与 scope 保留，认证不会重放被拒绝的 MCP 操作。

Codex `marketplace/add` 接受顶层 `sparsePaths`：非空列表使用 Git cone 目录选择并在更新时保留；调用方须包含目录文件与所需插件路径，不自动扩大选择。省略或空列表保留完整 checkout；本地目录来源不接受非空 sparse 选择。

Git marketplace 快照最多包含 20,000 个文件和 20,000 个文件系统条目。单插件快照仍最多包含 4,096 个文件和 8,192 个文件系统条目。两类快照的单文件和内容总量均最多为 64 MiB，不计 `.git`。

## 桌面 Apps 与 GitHub

首次从插件详情或其他全局入口打开应用时，应用使用当前选中的已有会话，保留其执行工作区、项目插件选择和连接信任，不发送草稿。调用初始工具前会打开所属会话，使普通工具审批可见。若当前是尚未绑定会话的新草稿，请先在侧栏选择已有会话，再打开应用；全局入口不会自动创建或选择另一条会话。再次选择已经打开的应用会返回它原有且仍有效的会话。Composer 的会话入口与文件入口仍可按普通创建流程为新草稿创建会话；应用明确请求新会话时也沿用普通创建准入，新执行工作区不会继承源工作区的项目插件选择或连接信任。

插件详情中的交互应用、全局/会话入口及匹配文件入口使用官方 MCP Apps AppBridge。详情只展示所属插件的应用与应用设置。插件页面运行在独立 origin 的沙箱框架内，不提供 Node、产品 bridge 或凭据。调用绑定项目、Thread、包摘要和连接版本；同服务器工具经普通 Core 执行、审批和日志路径调用。旧 App 在 Core 重启后失效，需要重新打开。窗口内切换标签、隐藏面板、切换会话或项目，以及打开设置和定时任务，保留同一活页面与 bridge，包括未保存文字、选区、滚动位置、订阅和在途请求。显式关闭、会话归档或来源撤销才释放页面。每窗口最多保留 8 个活页面，正在打开的页面也计入；达到上限时拒绝新增，关闭页面后归还额度。后台页面的 `send:true` 消息仍发送至原所属会话；要求新建会话或修改输入草稿的后台消息返回 `app_hidden`，不会切换当前视图。

普通对话中新完成且带可验证来源的 MCP 工具记录可显示“打开交互结果”。点击后使用该次调用保存的参数与结果，包括页面专用 `_meta`；模型投影仍剔除私有元数据。打开、重复点击、关闭后显式重开均不再次执行原业务工具。重复点击聚焦同一页面，隐藏与切换视图保留编辑、选区和滚动位置。旧历史没有来源证明时仍可阅读原始记录，不自动打开页面。

结果页面资源支持 `text/html` 和 `text/html;profile=mcp-app`，UTF-8 内容最多 2 MiB，并保留既有 CSP 与沙箱限制。失败、取消、UNKNOWN、损坏快照、插件变更/停用/卸载、连接或 Core 进程变化都会阻止打开。资源或 bridge 初始化失败以及 10 秒内未就绪会回退原始记录并关闭页面；这不保证能辨认所有 CSP 失败原因。打开或关闭结果待确认时，点击核对同一意图，不自动产生新请求。

固定版本的页面可以在 SDK initialize 中声明实验能力 `areal/page-tools`，只提供 `getSelection` 与带 `expectedDocumentRevision` 的 `applyPatch`。可信宿主完成初始化后登记，Agent 通过普通 Core 工具调用操作该页面尚未保存的选区或文字，仍受审批和取消约束。过期 revision 返回冲突，结果不明确时记为 UNKNOWN，不自动重放。隐藏页面保留执行能力；原连接断开则保留页面内容并撤销工具，须显式打开新实例。该扩展不等于支持所有第三方编辑器，作者契约见[有限页面工具](../api/desktop.md#有限页面工具)。

`ui/message` 可以将文本和资源添加到草稿，保留未发送的人类内容；只有 `send:true` 发起明确的新提交。标题和 `_meta` 留在历史/UI，递归剔除 `_meta` 后才进入模型。App 上下文按实例分组，可更新或移除。设置、mentions 和表单预览通过服务器声明的工具/资源处理；不猜测方法或地址。

GitHub Connector 保留 `.app.json` 的原始 ID。在详情中填写这个 ID 和 GitHub token，通过系统安全存储保存，再明确连接。Core 将这个显式映射接到 `https://api.githubcopilot.com/mcp/`；不会根据不透明 ID 猜测供应商。账户凭据不足、未映射和不支持分别显示。`scripts/plugin-github-smoke.mjs` 使用固定版本的官方 GitHub 包，通过真实 MCP 读取公开 `openai/plugins` 仓库的市场文件。模型使用本地确定性服务，GitHub HTTP、桌面用户路径和真实模型供应商的验收分别记录。

文件入口只给 App 不透明资源 URI。Core 校验保存的文件授权，并复用 Runtime 的目录描述符文件助手读写；Main 只管理窗口与文件监听。读取最多2 MiB，当前原子写入最多64 KiB；超限返回 `too-large`。写入支持 ETag/CAS 和持久请求回执；重试同键返回原结果，不覆盖后续编辑。

现代 MCP `2026-07-28` 支持多轮 MRTR 表单；直接旧连接仍支持 legacy elicitation。每轮保留原工具参数和 Core 调用归属，重新检查权限，不重放 UNKNOWN。资源更新只投递给订阅该 URI 的 App；多个 App 共享 wire 订阅，关闭最后一个才退订。

表单可通过原生选择器添加本机文件/目录。Core 导入只读副本，原文件后续编辑不影响副本；每文件16 MiB、每逻辑调用256文件/64 MiB、目录深度16。URI 绑定表单字段和服务世代，取消/关闭/撤权/调用结束会清理。当前文件副本仅交给同机 stdio 服务；HTTP 服务没有公开约定的上传通道时明确报告不支持，仍可选择服务器提供的资源。

## 当前边界

P2 完整 hooks 验收、OpenAI 私有 catalog/sharing、跨平台、真实供应商 OAuth 和签名/公证安装包仍未接受。部分子进程验收在本机收到原因未确认的 SIGKILL；不能把源码完成或局部通过当作完整兼容验收。未配置的托管服务返回明确 capability error。完整清单与可重复证据见[验收矩阵](../development/codex-plugins-p1-p3-acceptance.md)。

## Hooks（P2 候选实现）

包内 hooks 与用户、项目配置使用同一个 Core 执行所有者。用户来源是选定 home 的 `hooks.json` 与选定 TOML 的 `[hooks]`；项目来源是工作区 `.codex/hooks.json` 与 `.codex/config.toml` 的 `[hooks]`。每层先 JSON 后 TOML 累加，包定义沿用原格式及覆盖规则。项目文件只提供 hooks，不覆盖模型、凭据或用户全局功能开关；不导入 Codex `hooks.state` 的信任声明。

在“设置 → 插件”审阅当前包摘要、定义摘要、事件、matcher、命令/MCP 输入与完整定义，勾选确认后才允许执行。用户/项目配置来源也须分别审阅。安装、启用包或连接 MCP 都不授予 hook 信任；更新定义须重新核对。CLI 使用同一 Core 状态：

```sh
areal plugin --workspace /absolute/workspace hooks-list
areal plugin --workspace /absolute/workspace hooks-trust review-helper@team-tools --expected-digest REVIEWED_INSTALLED_DIGEST --definition-digest REVIEWED_DEFINITION_DIGEST
areal plugin --workspace /absolute/workspace hooks-revoke review-helper@team-tools
```

已布点的事件是 SessionStart/SessionEnd、UserPromptSubmit、PreToolUse/PermissionRequest/PostToolUse、PreCompact/PostCompact、SubagentStart/SubagentStop、Stop/Interrupt。command 使用 Runtime 的现有 Scope；MCP handler 只调用已经连接且仍获授权的包内工具，不递归进入模型工具审批。MCP 的活跃时间预算在真实人工表单等待期间暂停，取消和撤权继续生效。`deny`、输入改写和已完成工具的 Post 反馈独立处理；Stop 可在同一 Turn 内继续，自动续轮不制造用户提交事件。包命令获得包根/数据环境；配置命令不获得包环境或额外路径授权，provider 秘密不继承给 hook 后代。

Core 保存每次受理的 `desktop.hookRuns`。UNKNOWN 保留并阻止继续执行；检查实际副作用和资源后，可通过 `areal/hook/acknowledge` 保存有界说明，结果仍为 UNKNOWN且不重放。归档和关闭先取消、等待已受理任务，再结算 SessionEnd；正在关闭的 Session 不接受新轮次。后台结果只在安全点或下一次用户 Turn 投影，不自行启动空闲 Turn。

已信任的 command hook 使用有界 Runtime 任务写入组：固定窗口内同任务 hook/工具允许重叠，ordinary/ordinary 与跨任务冲突仍独占。窗口不能延长，封口后的操作可能排在外组任务之后。P2 尚未完整验收：Side/研究及限制 Profile 继续排除；普通只读子任务采用独立 command 许可。Windows shell、完整配置栈与固定 Codex 二进制对照仍开放。详见 [P2 验收矩阵](../development/codex-plugins-p2-acceptance.md)。

普通只读子任务的 command hooks 需要审阅当前定义后另行勾选同意；CLI 在 `hooks-trust` 添加 `--allow-read-only-commands`，省略该选项会移除此项同意。工作区/安装包只读，仅私有子任务 scratch 和本插件 data 可写，禁止网络和 provider 秘密继承，data 目录被重定向时拒绝执行。Side、研究任务、nativeTaskAgent、受限 Profile 和只读根会话继续排除，此项同意不包含 MCP handler。
