**中文** | [English](browser-testing.en.md)

# Browser 行为与发布验收

B-10–B-13 的原生 fixture 须检查 Core 交互包含实际准备的页面、目标和 Origin；拒绝审批时服务端副作用为零，批准后原生点击/填写/按键只产生一次副作用；导航、目标替换、视口变化、接管、伪造审批和跨 Thread 请求均不产生副作用。分别在输入前注入 prepare 失败、在 fixture 服务端收到输入后丢失回执，断言 `not_sent` 和 Core UNKNOWN。源码检查不能替代这些原生断言。

B-24–B-26 的原生 fixture 通过公开 GUI/Core 入口验证：跨 Workspace 达到 8 个原生页和单 Workspace 4 个逻辑页，执行/接管/对话框页 pin 时新页被拒绝且原生对象数不增长；空闲驱逐必须显示状态损失。隐藏后核对原生对象、表单和 scroll；崩溃重开后核对 `pageGeneration`、旧 Ref/计划/回执拒绝以及已派发操作的 UNKNOWN。将延迟加载/接管回调与归档、隐藏项目、关闭窗口竞争，核对旧页不复活、共享 Session 在兄弟页存活时不清除，最后页面关闭后无孤儿 WebContents 或下载。各次真实原生验收结果单独记录。

B-21–B-23 须通过公开 Core/GUI 路径，使用两个 Workspace 和合成回环登录服务。在一个 Workspace 设置 HTTPOnly Cookie、localStorage、IndexedDB 及 Service Worker；确认兄弟页在不重建已认领 WebContents 的情况下可见这些状态，第二个 Workspace 也能通过同一共享 Profile 使用这些状态。关闭一个兄弟页、关闭最后一页后重建，以及使用相同隔离 GUI userData 重启后，均确认持久登录和站点数据保留，旧 Page 控制引用失效。显式清缓存保留登录数据，显式全部清理后 Cookie、localStorage 和 IndexedDB 为空。可信精确 Origin 授权后才能导航。夹具探测另一个未授权的回环 Origin、实际 Core/适配器端点、内网/元数据目标，以及重定向、Frame、Worker fetch 与 WebSocket；禁止目标的服务端副作用计数必须为零。运行清单保留页面/Session 身份、请求及界面截图。各次原生场景的结果单独记录。

本文件定义完整 Browser 的测试契约。R0 原生实验已有独立入口，其结果以具体运行证据为准，不表示全部场景已经运行。后续主要测试切口沿用现有桌面 smoke/connection/architecture 的真实 Electron+Core+Runtime+确定性模型形态，参照[GUI指南](../../clients/gui/README.md)。

当前同页读取切口运行 `make build`、`make gui-install`、`make gui-build` 后，以 `node clients/gui/scripts/browser-read-smoke.mjs` 验证 B-04/B-05/B-06。脚本仅用隔离 home、合成网页和本地确定性模型；记录 Core 动态工具 callId、真实原生 WebContents 身份与内存 sentinel、GUI/原生截图、服务端请求计数和跨 Thread/伪回执/宿主缺失结果。源码构建测试不代表安装包、真实账号或其他 OS 已验收。

同一验收层使用 `node clients/gui/scripts/browser-evidence-smoke.mjs` 检查 B-07/B-08/B-09：部分观察后仍有效的 Ref、重复同名元素替换与 Frame 导航后的旧 Ref、iframe/Shadow 覆盖、语义状态和父节点关联、预算截断。脚本单独验证根页面/Frame/Shadow/明文敏感信息/跨源 Frame 的截图拒绝，检查截图期间视口变化与超大原生 PNG，并记录实际请求了哪种原生观察表面；随后验证模型图像输入、GUI 中的 Core 媒体回取及跨 Thread Blob 拒绝。仅脚本实际通过且保存运行清单时才能认定对应场景通过。

B1 原生控件验收入口为 `node clients/gui/scripts/browser-actions-smoke.mjs b1`。它通过公开 Core 工具调用、真实审批 UI、原生页面和独立站点事件计数验证滚动加载 sentinel 与新观察、hover、有序不透明选项身份、同值替换、重排/类型/视口失效、disabled/重复值/多选控件、checkbox true/no-op/false、disabled 状态等待、已确认批量前缀和去重，以及接管期间 select ACK 丢失。选定成功场景保留审批面板 PNG 与独立原生 WebContents PNG，并绑定原 Core call、Page、Ref 和准备计划。Main 未捕获错误从 bootstrap 记录到自然退出。runner 保留私有服务身份，核对自有 Electron、adapter 和 Core 清理。相同命令加 `AREAL_BROWSER_B1_PUBLIC=1` 使用合成公网主机名，证明未声明的 scroll、hover、select 和 checkbox 仍要求人工接管。fixture 对话框响应和解析映射是明确替代边界。源码测试不证明真实供应商、物理输入、签名安装包或其他 OS。运行前通过 `AREAL_CORE_BIN` 指定已核对且不可变的候选产物。

相同 B1 命令加 `AREAL_BROWSER_B1_PRIVACY=1` 聚焦验证动作回执隐私。页面 change handler 将合成私密字段值写入选中 OPTION 的 value/label。直接选择和批量选择必须保留 confirmed 输入与 `stateMatched:false`，而动作回执、Core 历史、模型收到结果和保留的批量回执不能包含该值。独立原生读数和站点计数确认一次选择、一组 input/change；普通 Notes 字段回显还经公开 observe 验证既有选项隐私过滤。

## 测试层级

1. **行为单测**只穷尽Ref身份、预算、去重、代次和状态转换；不要断言内部Map/类名。
2. **Core契约测试**覆盖真实app-server双向请求、准备/批准/执行、旧Thread追加、observer不重绑、UNKNOWN与重启；复用现有动态工具fixture。
3. **真实桌面E2E（主验收）**从用户入口或公开Core请求驱动真实native Page；断言fixture服务端副作用计数、页面sentinel、Core记录及GUI投影一致。不可通过直接Controller调用绕开权限后再称E2E。
4. **人工视觉/可访问性验收**针对native overlay、焦点、截图反馈、IME和安装版。自动测试不能证明完整主观视觉质量。

Fixture 至少含：不同端口的A/B站点、HTTPOnly Cookie登录模拟、跨源iframe、Shadow DOM、重复同名元素、动态替换、Canvas、popup、阻塞dialog、下载/chooser、失败API、含测试令牌日志、延迟表单提交、HMR样式页。测试仅用合成数据，不导入真实Profile。访问Core/adapter控制端口的测试使用测试服务，不探测用户现有服务。

## Agent JavaScript 对话框归属

Main 的 [`agent-dialog-presentation.cjs`](../../clients/gui/app/src/core/agent-dialog-presentation.cjs) 只接管自己创建的 Preview WebContents 的展示。人工控制时原样调用 Electron 的原 handler，并在其 Promise 完成前拒绝 Agent 认领；Agent 控制时保留真实 `alert`/`confirm` callback，不展示原生消息框。正常回答仍通过原有 Core 审批、Main `dispatchInput` 和 CDP `Page.handleJavaScriptDialog`，CDP Opening/Closed 仍是对话框观察来源。批准计划只在 Main 本地绑定当时的对话框身份，旧批准不能回答同文档中新开的替代对话框；公共协议不增加字段。`prompt()` 继续不支持，`beforeunload` 保持原路径。

这里依赖精确固定的 [Electron 44.5.0 私有事件实现](https://github.com/electron/electron/blob/v44.5.0/lib/browser/api/web-contents.ts#L768)：安装和认领检查唯一默认 `-run-dialog`/`-cancel-dialogs` listener 的形态，运行时检查事件参数。版本或契约不符时保留人工浏览，并拒绝 Agent 认领。升级 Electron 必须重新检查该实现并执行真实 pending、accept/reject 和生命周期验收，不能仅更新版本 guard 或用 listener 数量推断语义兼容。

撤销控制先 fence 旧 epoch，再取消保留的 callback；主 Frame 文档替换、关闭和 dispose 同样先取走引用，再至多调用一次 `callback(false, '')`。同文档或子 Frame 导航不主动取消主页面对话框。CDP Closed、平台取消和销毁只释放引用，不再次回答。普通 Core `turnEnded` 不取消对话框，允许后续 Turn 调用 get/handle。CDP 回执丢失仍为 UNKNOWN，不以清理 callback 补报成功或重放回答。

`pnpm --dir clients/gui run test:automation` 的对话框验收应记录真实网页结果、独立副作用计数、CDP Opening/Closed 和原生展示调用：在跨 Turn 的 get/handle 与拒绝审批期间保持 pending，批准后真实 JS 布尔值与 accept/reject 对应且完成一次。另验 pending 时撤销、导航、关闭、平台取消/销毁、回答与接管竞态、人工 handler 转交和不兼容契约拒绝。探针若只证明 Electron/CDP 闭环，不能据此宣称完整 Core 审批、人工输入或安装包验收通过；原生展示日志只能观察，不能替换 handler 或决定测试结果。

## 场景矩阵

| 场景 | 行为 | 必须证明的事实 | Ticket |
|---|---|---|---|
| B-01 | 原生对象不变 | 同一页面sentinel/表单/scroll在读取与隐藏后不变；记录native对象身份。 | 01 |
| B-02 | 真实输入屏障 | 遮罩下点击/键盘不达网页，接管仍可触发；不能仅断言CSS。 | 01 |
| B-03 | 调试连接冲突 | DevTools触发detach；重新attach后旧计划失效。 | 01 |
| B-04 | Core同页工具闭环 | 模型经真实Core工具回调读出既有页sentinel，GUI证据与历史callId一致。 | 02 |
| B-05 | 身份与回执伪造 | 跨Thread、不同socket同id、假pageId/hostGeneration均拒绝。 | 02 |
| B-06 | 宿主不存在 | 无Main或无浏览能力不创建替代浏览器；capability与错误一致。 | 02 |
| B-07 | Ref替换 | 同名元素换节点、frame文档导航及partial snapshot，Ref不误复用。 | 03 |
| B-08 | 观察覆盖与截断 | iframe/Shadow/动态DOM及超预算明确coverage/truncation。 | 03 |
| B-09 | 图像与证据授权 | 模型实际接收图像；跨Thread读Blob拒绝；大图不突破Core帧限制。 | 03 |
| B-10 | 真实批准链 | 拒绝不输入；允许只执行记录的真实目标计划。 | 04 |
| B-11 | 审批后页面变化 | 导航、重绘、缩放或接管后旧批准不能点击替代目标。 | 04 |
| B-12 | 权限伪造 | 模型arguments或网页文本中的allow标志不能创建许可。 | 04 |
| B-13 | 已派发与未派发 | 注入prepare失败与发送后断线；前者not_sent，后者UNKNOWN。 | 04 |
| B-14 | 接管优先 | 长wait/队列满/Core不响应仍本机先fence，后续input计数为0。 | 05 |
| B-15 | 人工阶段隐私 | 接管后测试secret不进入DOM/截图/日志，交还不补发缓冲。 | 05 |
| B-16 | 接管中的不明提交 | fixture服务端已记一次submit，回执丢失后不再提交；历史UNKNOWN。 | 05 |
| B-17 | 旧Thread追加 | 旧历史/工具保持、追加幂等、重启可读，同页浏览首次执行。 | 06 |
| B-18 | 忙碌与工具冲突 | 活跃Thread/其他Host/同名不同schema/不支持版本拒绝。 | 06 |
| B-19 | Tab与popup归属 | popup关联opener/Thread/Context；未知页不可被无授权关闭。 | 07 |
| B-20 | 不抢焦点 | 后台Thread页变化不切当前chat/tab；活动Tab不是全局执行目标。 | 07 |
| B-21 | 临时存储隔离 | A/B Workspace分别用Cookie/localStorage/IndexedDB/SW标记，互不可见。 | 08 |
| B-22 | 临时登录交接 | 人工登录后同Workspace sibling有效，退出重开不承诺恢复。 | 08 |
| B-23 | 内网与控制端口 | 授权开发Origin可达；控制端口、未授权redirect/frame/传输被拒绝或明确门控。 | 08 |
| B-24 | 容量与pin | 8页上限，所有候选pin时新页拒绝，执行页不驱逐。 | 09 |
| B-25 | 崩溃与旧代次 | 崩溃重建后旧ref/事件/回执不能操作或覆盖新Page。 | 09 |
| B-26 | 隐藏与归属释放 | hide保状态，archive释放，迟到show不复活。 | 09 |
| B-27 | 区域批注来源 | 选区与原截图坐标一致，发送正确Thread，取消不导航。 | 10 |
| B-28 | 草稿与中文输入 | 输入法Enter、切Thread、失败发送不误发或丢草稿。 | 10 |
| B-29 | 元素过期 | 选取后DOM换代，批注保旧证据，下一动作要求重观测。 | 11 |
| B-30 | 元素降级 | 不可读iframe/Canvas只提供区域反馈，不编造selector。 | 11 |
| B-31 | 诊断脱敏与预算 | Console和network含测试令牌，输出脱敏、缓冲有界。 | 12 |
| B-32 | 人工调试后恢复 | 用户DevTools期间自动动作阻止，关闭后明确恢复与新观察。 | 12 |
| B-33 | 坐标矩阵 | DPR1/2、pageZoom、scroll、viewport变化后命中指定点，旧图拒绝。 | 13 |
| B-34 | Canvas状态验证 | 键鼠/drag作用于真实Canvas状态，取消释放按键。 | 13 |
| B-35 | 服务路由 | 只复用真实项目服务；端口冲突和服务失败不跳错项目。 | 14 |
| B-36 | 源码与验证关联 | 改前失败改后通过，刷新后仍通过；检查/截图关联call与变更。 | 14 |
| B-37 | 样式撤销与HMR | 撤销只移除自己覆盖，HMR换节点不覆盖应用新值。 | 15 |
| B-38 | 清除试改后验证 | 未改源码仅试改时不能验收通过；清除后展示真实结果。 | 15 |
| B-39 | 上传人类选择 | 模型路径拒绝，chooser取消正常，用户文件不自动给Agent读取。 | 16 |
| B-40 | 下载有界 | 来源/目标/大小及取消保回执，超限/关闭清理，不自动执行。 | 16 |
| B-41 | 批量前缀 | 第3步前拒绝时前2步不重复，剩余不执行。 | 17 |
| B-42 | 批量接管与UNKNOWN | 每步fence，任一步UNKNOWN不继续也不重放。 | 17 |
| B-43 | 观察不重绑 | CLI原子订阅不改变GUI ToolHost；错误socket回执无效。 | 18 |
| B-44 | 退出隔离 | GUI退出影响Browser但另一Core任务继续，适配器存活不算Page存活。 | 18 |
| B-45 | 迟到结果 | 旧Host/请求回执不能写入新Turn/新Page或改写UNKNOWN。 | 18 |
| B-46 | 重连不重放 | 读取快照和重绑不重新派发旧call，重复请求保持幂等。 | 18 |
| B-47 | 键盘与辅助技术 | 关键操作键盘可达，状态可读，focus与IME不退化。 | 19 |
| B-48 | 安装版自包含 | 隔离安装无开发依赖/全局Chrome/CDP端口仍通过流程。 | 19 |
| B-49 | R2综合交付 | 真实安装版完成要求的开发协作故事并保留审核证据。 | 19 |

文件交接源码检查只覆盖受信任 IPC 范围、文件配额及 Agent 文件输入拒绝。真实 Electron fixture 须在同一 Page/Thread 上分别触发人工上传选择、取消及 Agent 间接点击；用独立站点计数确认取消没有自动重放。下载需核对系统保存对话框出现前无落盘，路径仅由用户选择，未知大小、超限、超时、关闭/崩溃、同 Workspace 兄弟页归属与取消回执均与实际文件和 GUI 状态一致。测试若注入系统对话框选择，须标明其替代了真实用户选择；不能据此宣称人工完成。

临时样式源码检查覆盖受限 IPC、Main 节点身份/实际值栅栏与 Composer 草稿接线。B-37/B-38 须使用真实原生页验证撤销/重做、HMR 换节点、导航、键盘/输入法、敏感内容截图拒绝、草稿发送失败，以及清除试改前后的真实页面与 Core 回执；源码检查不构成这两项验收。

## 故障注入时刻

至少在prepare前、审批等待、execute发送前、输入已到fixture但回执未到、Core持久化前、Main退出、适配器断线、Core重启和页面换代时切断。对每个时刻检查 `not_sent / confirmed / UNKNOWN` 区分、工具无重放、旧结果无写权限。取消测试不能只断言AbortSignal。

## 性能与资源记录

记录工具次数、模型输入文本/图像预算、prepare/审批/原生执行/回执分段时间、请求队列峰值、WebContents数和截图编码字节。支持复现实验的机器/版本/视口/输入固定；不把项目方宣传的加速数字作为验收阈值。初始页面/队列/观察上限来自[契约](../api/browser.md)，需要压力fixture证明不会无界增长。性能退化与安全正确性分别报告。

## 发布门

- R0：B-01至B-03有真实原生证据，ADR-0003的技术选择可复核。
- R1：Tickets 01–09完成，各自场景通过，授权/接管/UNKNOWN/隔离无已知阻断缺陷，功能仍明确标为安全共享Browser阶段。
- R2：全部49场景及19号发布票通过，真实安装版完成同页→批注→源码修改→验证，Profile等延期项显示清楚。
- 任何安全门失败不可通过仅关闭日志、降低权限断言或删除测试绕过。不能为了全部通过而修改外部站点真实结果。

## 证据包格式（新增约定）

每次运行保存 run-manifest.json：git SHA、包版本、OS/arch、Electron/驱动版本、fixture版本、测试入口、场景ID、开始结束时间、检查结果、未测项；附Core call/Item关联、合成站点副作用计数、去敏感日志与截图。UNKNOWN用其真实值，不用0/失败代替。截图只作观察证据；业务成功要由明确断言或人工评审给出。

同页读取、观察/媒体和旧 Thread 追加脚本使用 [`browser-evidence.mjs`](../../clients/gui/scripts/browser-evidence.mjs) 生成版本 1 清单：

- `runKind` 显式区分 `acceptance` 与 `diagnostic`；`executionStatus` 为 `completed`、`failed` 或 `blocked`，表示运行状态。
- `cases` 预先列出稳定案例 ID 和关联需求；断言完成后记录 `passed`、断言说明与当场复制的观察值，未执行的案例保留 `not_run`。`B-05.forged-receipt` 等子案例不能代表整个需求矩阵。
- `provenance` 绑定源码提交、工作树 diff、脚本与 Core 二进制 SHA-256；原有 `hashes` 包含被读取的实现与公共 fixture helper。
- `acceptanceStatus` 由运行类别、状态和全部计划案例推导。诊断始终为 `not_applicable`；部分运行不得写成完整通过。`checks` 仅是说明，不能单独用于计分。

按明确的案例清单汇总同一候选的证据，例如：

```sh
node clients/gui/scripts/browser-evidence.mjs B-04.same-page,B-05.forged-receipt /path/to/manifest.json
```

完整包含这些案例时退出 0，缺项或格式不合格退出 1。多个清单会显示 `mode: composite` 并保留各次运行状态，不能显示为 `cleanRun`；源码/diff/Core 身份不同的清单不能自动拼接。历史 `passed: true` 清单必须人工核对，不由汇总器升级。诊断运行不增加通过数；出现失败时保留原始文件与修复后的定向结果。此汇总只覆盖命令指定的案例，不声称整个 milestone 或发布门通过。

评审反例时检查它是否能区分目标错误：例如伪回执必须引用真实在途请求 ID；任意不存在的 ID 被拒绝不能证明同号跨 socket 隔离。

## 固定候选的启动检查

上述三个脚本在业务场景前，通过 [`browser-startup.mjs`](../../clients/gui/scripts/browser-startup.mjs) 从实际 Electron Main 运行隔离 home 中的 `config models read`，一次运行只做一次探测，替代无关的多次 `--version` 对照。`startup.json` 保存父/子 PID、argv、二进制哈希、退出码、信号、超时与有限 stderr；不保存配置正文。启动失败记为 `blocked`，业务案例保持未执行。

显示器和可见窗口数量不能证明桌面已解锁，记录中的 `desktop.unlocked` 保持 `unverified`。统一原生验收的唯一执行者先确认桌面会话可用；锁屏或明确启动策略拒绝时保留候选和证据，等待相关环境条件变化后再恢复。旧二进制的版本探测不能替代当前候选的实际启动路径。该检查不修改签名或系统策略。

## 工具结果回读

截图通过 Core 媒体/Blob 通道验证模型输入与 GUI 展示；截断的大工具结果使用 `read_tool_result(resultId, after)`，沿 `nextCursor` 分页，并按所属 Thread 的原始 Item 授权。其实现归 [`core/engine/src/tools/results.rs`](../../core/engine/src/tools/results.rs)，契约见 [Core API](../api/core.md)。内部结果快照不能当作媒体附件读取。改用较小的内联结果可验证缓存等独立断言，但不能据此宣称大结果分页已通过。

## 现有命令与新增命令

`pnpm --dir clients/gui run test:browser-navigation` 使用隔离 Electron、真实 Core/Runtime 与确定性本地模型，覆盖可交互文档仍有慢资源、登录重定向、主文档超时 UNKNOWN、人工打开页面后从 Composer 核对并继续发送。验证取消保留草稿、核对本身不调用模型、UNKNOWN 历史不改写及消息只受理一次，并检查慢资源页面可以截图、含密码框的页面仍拒绝自动截图。夹具显式配置完全访问，以生产 `describe`/`observe` 取得控制；不代表真实账号、供应商或安装包验收。导航事件的反例回归随 `test:browser-contracts` 运行。

设置 `AREAL_GUI_EXECUTABLE` 为候选或已安装应用的绝对可执行文件路径，可对同一导航恢复场景进行包内验收。脚本不覆盖 `AREAL_CORE_BIN`，核对实际加载的包内 Core 路径、组件完整性及应用资源哈希；用户数据、站点和模型仍使用隔离夹具，不操作真实账号。此模式目前只支持 `navigation`。

`pnpm --dir clients/gui run test:browser-contracts` 执行现有读取、网络与诊断契约检查，以及证据分类和启动探针检查；已接入 GUI CI，无需启动桌面窗口。这不替代 milestone 收尾时在冻结候选上的真实 Core/Native/GUI 验收。开发期间运行必要局部检查，因果修复只重跑受影响场景并保留先前失败。

现有可用入口包括 `make gui-smoke`、`pnpm --dir clients/gui run test:connection`、`pnpm --dir clients/gui run test:architecture`、`pnpm --dir clients/gui run test:composer`、GUI typecheck与verify；详见GUI指南。Browser 专用脚本见本页所列入口；不得假设存在未公布的 `test:browser` 命令。

`pnpm --dir clients/gui run test:browser-annotations` 验证可信 GUI 人工批注：冻结同一原生页面，点选两个元素，确认后以独立 Composer 附件保留正文，跨聊天隔离与恢复，空白说明阻止发送，上传拒绝保留后显式重试，以及重载 Renderer 后从 Core 历史重建消息。比较 Composer 裁图与模型收到的 PNG 字节哈希，证明图片与说明均经过既有 Core 通道。合成输入法 Enter 事件仅覆盖组合态保护，不替代真人中文输入；本地模型与可信 GUI 的站点导航不构成真实供应商或物理焦点验收；可设置 `AREAL_GUI_EXECUTABLE` 使用隔离安装包。跨源截图隐私边界另运行 `node clients/gui/scripts/browser-frame-origin-smoke.mjs oopif`。

文档与类型变更同时运行当前仓库要求的检查。原始设计交付仅做产物结构校验，没有运行仓库测试、真实 Electron 或安装版，不能作为发布证据；实际 R0 运行按下面的独立入口留证。

## R0 原生实验入口

```sh
make gui-install
pnpm --dir clients/gui run test:browser-feasibility
```

入口只启动隔离的 Electron fixture，复用当前 `CorePreview` 与其既有 WebContentsView；不启动 Core、Runtime 或独立桌面适配器，不登记 `browser_v1`。测试控制使用继承的私有管道，不启用全应用 CDP/Inspector 端口。网页保持独立临时 Session、sandbox、contextIsolation，无 Node、preload 或产品 bridge。实验位于 GUI scripts，普通启动与打包不加载它。

测试在三个 checkpoint 等待真实桌面输入：先在网页输入 `HUMAN_DRAFT` 并点击 CENTER；遮罩出现后以桌面坐标点击同一目标、按一个字母键，再点击顶栏“接管”；最后查看冻结截图并点击“返回实时页”。鼠标必须经过原生窗口命中测试，不能用网页 DOM click 代替。可用桌面自动化或人工输入，并在 checkpoint 保存包含原生页面与叠层的窗口截图。

自动断言检查原生对象、sentinel、表单、滚动与 AX 读取，遮罩接收输入而网页计数不变，截图 bitmap/CSS/zoom/scroll 变换及合成站点回执，最小化返回 `page_not_visible`，DevTools 原生 detach/重新附加和旧调试代次拒绝，以及冻结后返回原对象。截图前等待可见页面绘制提交；不假定缩放属性更新就代表合成帧已经更新，也不依赖特定 Electron 版本自动 detach。测试显式在打开 DevTools 前暂停并 detach，关闭后重新附加。

入口输出临时证据目录，保存 `run-manifest.json`、场景事实、截图元数据和页面 PNG；manifest 记录工作树、源码散列、运行版本、未测项及空 Core call 列表。原生窗口截图单独采集，Renderer 截图不能替代。失败运行保留原貌；不同进程的画面不得拼成一次连续运行。该实验没有生产 Browser 权限、Host 回调、UNKNOWN 恢复、区域评论或安装版验收能力。

## 人工跨源 Frame 切片

`node clients/gui/scripts/browser-frame-origin-smoke.mjs oopif boundaries` 使用真实 Core、独立 adapter、同一 Native 页面、确定性模型和两个本地 Origin。`same-process` 参数覆盖同进程跨源；实际进程身份与 FrameTree 区分 OOPIF，不能只看端口。覆盖显式重载、Main 确认取消与迟到失效、父页面借权拒绝、站点严格策略、全图敏感/瞬时变化/隔离上下文失败拒绝、Agent 截图拒绝、原 Thread 裁图 Blob 与模型 SHA、撤销销毁、标注隐藏保留同一 Native、普通关闭预览及随后切 Thread（不打开新预览）销毁旧授权、无效截图凭据拒绝保留，以及跨 Thread 隔离。Main 对话框由夹具对精确 Origin 回答，不算真人确认。以 `AREAL_CORE_BIN` 指定已冻结 Core；保存 fixture/源码散列、调用身份、图片与停止回执。

共享 Profile 和 Chrome 导入包另外使用合成数据的真实 Electron 验收。记录两个独立进程、相同隔离 userData、不同项目/聊天以及 defaultSession/另一分区的隔离事实。导入验收不得读取个人 Chrome 或真实钥匙串；用受控源资料、数据库和密钥注入验证字节、计数、取消及临时窗口释放。
