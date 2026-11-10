# one-protocol 本机验收交接

## 当前合并版本的本机复验

本节记录 `5cf3d2e6`（合入 `origin/claude/project-thread-o3srq8@c8500f05`）的结果，不将下方旧版本证据当成当前版本通过。源码构建、固定槽及日志位于 `.scratch/one-protocol-current/`；Core inputHash 为 `00fb18b41dd77cb54cff84af3f4baaacbc28d0e5e85ca5a9de2d5cb209d4af60`。测试使用隔离数据和合成凭据。

| 用例 | 当前结果 |
| --- | --- |
| 四个 Host 写失败注入 | 普通 macOS 用户分别运行，全部通过；每个过滤器实际执行一条测试。 |
| `cargo fmt -p areal-host -- --check` | 通过。 |
| `@areal/gen-ui` 构建 | 通过；但其后的 `local_send_and_steer_freeze_authoritative_gen_ui_context_without_private_state` 失败，`session.create` 在预期派发前返回原请求 `UNKNOWN`，见 `cargo-local_send_and_steer_freeze_authoritative_gen_ui_context_without_private_state.log`。 |
| `test:workbench-backend` | 通过。覆盖浏览器配对写回执、任务、Worktree、后台崩溃恢复、Main detach、Host stop 和重启后的原回执；证据 `/private/tmp/areal-a3-c1ROUY/result.json`。本轮记录的 Host/后台 PID 均退出，合成 Keychain 清理回执确认测试项不存在。 |
| `test:host-protocol-conformance` | 失败：本地 Host schema 引用无法解析；Relay 的 `RemoteReady.limits.applicationMessageBytes` 未满足 schema 常量。见 `host-protocol-fixture.log`。首次缺少合成 Keychain 夹具标记的失败也保留。 |
| `remote-device-management-host.test.mjs` | 5 项中 3 项通过、2 项因 `storageLocked: credential helper exited without a result` 失败；见 `remote-device-fixture.log`。不能据此判定唯一原因。 |
| `test:shared-host-consumers` | 失败，`Core connection failed`；见 `shared-host-consumers.log`。 |
| `shared-host-smoke.mjs` | 首次缺旧版固定槽；复制既有旧产物后，旧服务已有 Host owner，不满足无 owner 的旧服务夹具，停在 `legacy-start`。该旧产物的 build-info 标记 workingTree=true，不能作为通过的迁移证据。runner 清理等待锁超时；随后对该隔离 Host 执行 stop，回执 completed，记录的 Host/Core PID 已退出，见 `legacy-cleanup-stop.json`。 |
| `test:mobile-storage`、Host schema 生成检查 | 通过；不替代设备或协议一致性验收。旧 `test:mobile-workspace-state` 命令在当前 package 中不存在。 |
| `test:service-connection` | 合并后补齐依赖及生成产物仍失败，包括 `Host Core 投影尚未就绪` 和恢复断言失败；未确定根因。 |
| Worktree 界面冒烟 | Chromium 路径通过前六项后，断言期待英文 `Worktree`，实际可访问名称为中文“工作树分支 … · 工作树已就绪”；Electron 路径后台报 `CAPABILITY_UNAVAILABLE`，等待项目连接超时，未完成检查。清单与截图见 `native/chromium-retry/`、`native/electron-retry/`。Electron 清单记录隔离服务已停止，已核实该 Electron PID 退出；runner 写完清单后仍挂起，按本次进程身份终止。默认 Electron runner 并非 `--rust` 路径。 |
| 文档检查 | `check-docs.py` 首次通过，打包后再次运行报告 `content-system.md` 和 `conversation-design-research.md` 各一处锚点不存在；原因未确定。提交 hook 的格式检查通过，生成的影响计划没有执行。 |

已构建当前源码的本地 ad-hoc 候选 `package/AReaL-Harness-GUI-mac-arm64.zip`，SHA-256 为 `56a1c26dd1bab084e5bb16da6c2fa78f872daa185bc2b1030347a1f5b86b889d`。独立解压后核对包内 Core revision 为 `5cf3d2e6`、release profile，三个核心二进制哈希与清单一致，深度签名校验通过。构建时工作树含本 handoff 的未提交文档修改，标记 workingTree=true；包未做 Developer ID 签名或公证。当前受控 runner 固定源码 Electron 或依赖旧 Desktop 退出契约，不能证明包内 Shared Host detach，因此未启动包或声称后台生命周期通过；见 `native/package/status.md`。

真实 safeStorage、OP-07 手机路径、本机网页与桌面对齐、iOS/PWA、停机升级演练和其余直接构造 CoreBackend 的 Electron 冒烟均未完成当前版本验收。模拟器服务连接失败、真机枚举超时；旧记录中的模拟器与 ad-hoc 包结果保留为历史，不证明当前版本。旧清单中的 `areal.oneProtocol.sharedUi` 和后台开关不再是当前源码的活动入口，不能按旧开关结果推断现行界面行为。未使用真实历史凭据、未发布、未删除旧入口。

当前结论见上方“当前合并版本的本机复验”。下方此前的未完成项和失败记录保留为历史证据，不代表最新状态。

本轮集成 `origin/claude/one-protocol@0aba3e33`，包含 `7f942081` 的 A4 共享界面，基线为 `4c4c529b` 的 A3 后台迁移。远端以 fast-forward 合入 `codex/one-protocol-a0`，未 push。

## 本轮范围

- TUI/CLI 保留现有连接方式，暂不切 Host。
- 不实现远程 Noise 设备对跨项目领域的授权；远程入口应按不可用处理。
- 保留 `clients/web`、旧远程/手机页面、Core 内嵌网页、Main 旧 IPC 投影与开关。验收通过不代表获准删除；删除前仍需用户确认。
- 共享界面开关为 `areal.oneProtocol.sharedUi=1`；后台开关为 `areal.oneProtocol.domains` 包含 `backend`。

## Mac 自动化结果

环境：macOS arm64、普通用户 UID 504、Node v24.2.0。合成凭据与数据均使用隔离目录。Core 由本轮 `make build` 构建，`build-snapshots.mjs` 已生成工作台加载产物。

| 用例 | 结果 | 证据/说明 |
| --- | --- | --- |
| `create_lost_outcome` | 通过 | 普通用户运行，实际执行 1 条测试 |
| `create_pending_write_failure` | 通过 | 普通用户运行，实际执行 1 条测试 |
| `creation_outcome_failure` | 通过 | 普通用户运行，实际执行 1 条测试 |
| `lost_outcome_write_stays_unknown` | 通过 | 普通用户运行，实际执行 1 条测试 |
| `test:mobile-workspace-state` | 通过 | 包括第 7 条隔离 CA 和真实 Rust Host 路径，无跳过 |
| `test:host-protocol-conformance` | 通过 | 包含 Relay TLS/Noise 连接 |
| `remote-device-management-host.test.mjs` | 通过 | 完整运行，无跳过 |
| `cargo fmt -p areal-host -- --check` | 通过 | 先保留原格式失败，再执行 cargo fmt 修正 Host crate |
| `paired-transport.test.ts` | 通过 | 共享连接适配器单测；不替代 UI 验收 |
| `test:workbench-backend` | 通过 | 源码布局完整运行，见下文 |
| 共享 Remote 项目身份回归 | 通过 | 修复前 canonical ID 的回执查询返回 FORBIDDEN；修复后模型目录、发送、原回执查询通过，未知项目和移除授权仍拒绝 |
| 修复后的 Relay 协议一致性 | 通过 | 真实 Host/Relay/Noise 使用 canonical ID 读取模型并发送，Core 完成第二个 Turn；canonical ID 与别名读到同一回执，旧方法严格性仍通过 |

本轮日志与身份回执在 `.scratch/one-protocol/mac-handoff/`：`fault-tests.json`、`integration-tests.json`、`deployment.json`、`build.log` 和对应日志。固定校验槽为 `/Users/sailfish/CodeProject/AReaL-Harness/.local/one-protocol-mac-bin`，运行期间锁定，不修改组件。

后台首次在普通固定二进制槽启动失败：该槽不具备工作台资源布局；Host 只从源码 `target/debug` 或签名应用资源布局加载工作台。原始失败保留在 `/private/tmp/areal-a3-zjRDIM`。随后锁定本轮 `target/debug` 产物运行原完整用例，通过证据为 `/private/tmp/areal-a3-zpDDhu/result.json`，Host 停止回执为同目录 `host/host/stop.json`。

完整后台用例已覆盖：浏览器配对；资料库写回执、去重与排序；供应商配置；任务目录、暂停/恢复/编辑/取消/删除；Worktree 环境、创建、打开、删除；后台崩溃恢复且不重放写；Main detach 后后台存活；Host stop 关闭后台；Host 重启保留浏览器授权与原回执。它不证明真实 Electron 安装包行为。

## 共享界面真实入口发现与修复

生产 Remote 与 iOS 模拟器均已完成配对并显示同一共享 App、两个项目和会话；iOS 撤销后可见“授权已撤销，请重新配对”。证据在 `shared-ui/report.md` 及对应截图。手机使用独立测试 bundle，复制的验收 App 注入了 sharedUi 开关；不代表正式发行包默认开启。

原 Remote 实测捕获 `project.models` 和新独立 `session.send` 返回 `FORBIDDEN`：共享清单使用 Host UUID，而这两个项目入口仍按远程来源别名鉴权。修复放在 Host 的已协商 `gui-write-v1` 入口，按当前来源解析 UUID/别名，再执行原项目授权与回执规则；未协商调用保持原语义。红绿日志 `shared-identity-red.log` / `shared-identity-green.log`、相关回归 `shared-identity-regression.log` 和真实 Relay 回归 `shared-identity-relay.log` 已保存。

修复产物 inputHash 为 `eec8d33163499d5ca4a43049b15fe90345196402beabb40ca7a13ee60d5e2825`，`areal` SHA256 为 `f6fb9abaf9ae3782659ae509d6380dd1c9f2949986ed2e9bb1f6392fb3ef0e2c`，固定槽部署回执为 `shared-identity-deployment.json`。候选安装包仍含修复前的二进制；其生命周期与原生能力证据不作为本次身份修复的包内验收。

首个未抓包的 MOBILE_TEST 没有原 commandId，不能推断是否到达 Host，也不把它改写为 UNKNOWN。后续抓包的独立发送是明确拒绝，没有重放。原界面还出现 session.open/subscription.close 循环及 CORE_UNAVAILABLE；iOS 前后台返回虽显示已连接，会话随后加载失败，完整恢复仍未通过。旧夹具已取得 Host/项目 stop completed，记录进程全部退出。

## 安装包已取得的证据

本地 ad-hoc 候选从 `Resources/areal-workbench/src/backend-main.cjs` 启动后台；显式终止隔离 GUI 后同一 Host/后台仍在线。远程会话经过真实工具审批完成浏览器 describe/observe 并读到本地页面标记；GUI 退出后新的远程发送明确 rejected、`submissionUnknown=false`、`CAPABILITY_UNAVAILABLE`。这是进程意外退出后的能力边界证据，不能替代正常 ⌘Q。

后台崩溃后，退避窗口内手动重开失败，随后再次手动重开恢复。此轮发生在原 GUI 退出后，不覆盖存活 Main 的自动重连。随后补验时 GUI 保持在线，后台被终止约 6.96 秒后，在相同 Host generation 下自动接上新后台，无须重开 GUI。设置页“高级诊断 → 退出 AReaL Harness”正常退出后 Host/后台仍在线，再执行 Host stop completed；记录进程均退出。证据为 `package/live-reconnect.json`、`live-stop.json`、`live-cleanup.txt`。

上轮保存的合成 Cloud token 经真实工作台和 Main safeStorage 在重启后解密，本地测试监听器确认匹配，`package/cloud-roundtrip.json` 的 received/matched 均为 true；未访问真实供应商。旧格式及真实历史凭据兼容仍未验证。远程 runner 因审批耗时两次超时，第二轮随后才在 UI 和模型记录中完成；原始超时和首次页面归属错误保留。完整证据见 `package/README.md`。

修复后的生产 Remote 使用新固定槽通过侧栏进入已有会话，`session.send` 返回 accepted，模型收到新请求且界面显示回复。证据为 `shared-ui/attempt2/frame-log.ndjson`、`remote-send.png`，未观察到上一轮打开会话循环。首次首页的“正在连接项目…”来自默认选中 stopped 项目；shell 中另一项目为 ready，点击其会话即可发送。当前读订阅不会唤醒停止项目，首屏持续连接提示仍是独立未完成项。

同一修复产物下，iOS 已打开的真实会话发送 `A4_IOS_SEND` 后显示 `MOBILE_REPLY_3`，截图 `shared-ui/attempt2/ios-send.png`。停止操作两次因设备调用期间模型重试已经结束而错过窗口，未取得有效 UI 停止证据，保留未验状态。

修复后 iOS 切到系统设置再返回，顶部显示已连接与 Host ready，但共享界面显示“暂时无法完成加载，请重试或检查后台”，会话未恢复，审批因此受阻。夹具在追加诊断请求前已停止，缺少失败当时的 Host status、Core 状态和手机 session.open 原始错误，不能确定是连接重新挂接还是 Core 路径失败。启动时的 ready 记录不能替代失败时快照。最终 `shared-ui/attempt2/cleanup.json` 中 Host/项目 stop 均 completed，记录进程全部退出，固定槽已释放。临时测试 CA 留在模拟器 keychain，一天后到期，未重置用户 keychain。

## 环境与首次失败记录

- iOS `mobile:sync`、独立 Debug bundle 构建与安装成功。一次重建连接夹具时发生 `No space left on device`，该轮 Host/项目服务 PID 已退出但没有 stop 回执；保留该清理缺口，不改写为正常退出。
- 本地 `.app` 候选已生成，首次 ad-hoc 签名在嵌套 `AReaL Harness Service.app` 处报 `internal error in Code Signing subsystem`；释放本轮中间文件后，对同一候选重签与严格验证通过。资源链接最小夹具也通过，但未证明首次失败的唯一原因。日志 `package-build.log` 与 `package-sign-verify.log` 已保存。
- 磁盘处于空间压力下，仅清理本轮生成的临时 staging、候选包外重复资源及本轮新建的非可执行 Rust 中间文件；Core/Runtime 二进制、真实用户数据、其他任务与原始证据保留。删除清单在 `package/temporary-cleanup.json`、`package/owned-cache-cleanup.json`。

## 隔离事故（必须保留）

候选 app 的隔离种子实例退出后，CUA 应用状态查询自动启动了新的候选实例，未继承隔离环境。误启动 PID `56628` 使用了日常 GUI 数据目录。已核对该 PID 退出，不停止归属不明的日常服务。

只读核查确认日常 `diagnostics/main/164316d2-7aca-4e35-807a-49749f7f2653/run.json` 属于 PID `56628`；偏好、缓存、部分项目辅助文件与 Host 调度文件在同一时间段有写入。没有误启动前快照，无法确定全部业务数据变化，也不能声称无写入或无影响。未对真实数据做回滚或清理。

事实与限制在 `package/incident.json`、`package/incident-readonly-audit.json`。后续候选验收禁用可能自动启动应用的 CUA 应用对象；仅显式隔离环境与 `--user-data-dir` 启动，核对 owned PID 和子进程数据路径后，经该隔离实例的 CDP 端口操作，退出状态由进程及 Host 回执确认。

## 最终未完成项

- iOS 前后台恢复：已复现失败，尚未定位；下一轮应先在同一次恢复中记录连接身份、session.open 请求与响应、Host 项目代次，再操作设备，避免用连接状态代替会话恢复证据。
- 停止项目的共享首页持续显示连接中，没有明确的不可用状态；已有 ready 项目的发送不受影响。
- iOS 停止未取得有效 UI 证据；审批被恢复失败阻断。配对、窄屏发送和撤销可见状态已通过，不再列为待验。
- Remote 断线/重连切换、远程跨项目不可用入口、flag off 旧页面尚未验证。协议一致性保留了旧方法表行为，但不等同已发布 iOS/PWA 应用验收（OP-08）。
- 安装包正常 ⌘Q 键盘入口；已通过设置页正常退出、进程意外退出、在线后台自动恢复和 Host stop。
- 真实 safeStorage 的旧密文兼容；合成新保存值跨重启读回已通过，按本轮兼容性放宽要求不扩大真实历史夹具。
- OP-07 远程会话使用桌面浏览器和退出后明确不可用已通过；不是手机实机证据。候选包是本地 ad-hoc 调试包，不是正式分发验收，且未重新打入本轮身份修复。

本轮已执行的检查、已修复缺陷及剩余限制均已记录，不标记 A3/A4 全部完成。未迁移 TUI/CLI，未删除旧入口，未 push。最终检查包括相关 Rust 回归、真实 Relay 一致性、改动脚本 lint、文档配对与 diff 检查。提交钩子的全量格式检查另外暴露 CLI、app-server 和 verification.py 的既有格式差异，已仅按 rustfmt/ruff 修正；这些最后的格式变更不改变业务，未重复构建测试二进制。

## 当前分支续接结果

`origin/claude/project-thread-821xno@246e2124` 已合入 `codex/one-protocol-integration`，合并提交为 `f350e9ca`；本地修复为 `744d7a08`。未 push，未发布，未删除旧入口。

- 停止项目的状态不再被投影丢弃：首页显示项目已停止，并结束忙碌状态，不通过读订阅唤醒 Core。工作树会话使用执行项目的状态，避免被逻辑父项目覆盖。投影回归已通过；页面证据另见下述 UI 记录。
- 真实 WebSocket 回归复现了同一会话并发选中时重复打开订阅。共享客户端现在复用同一连接、项目代次和选中目标的在途请求，已新鲜的同目标选中不再重开。重连与 UI 恢复同时到达的回归通过，切换目标、迟到响应、Core 代次变化及 UNKNOWN 不重发的原回归仍通过。该缺陷不能直接认定为旧 iOS 故障的唯一根因。
- 合入的 Beta 更新通道有异步竞态：检查期间关闭 Beta，旧检查的结果仍可能成为下载目标。现已丢弃旧频道的成功或失败结果，再检查当前频道；两种回归均通过。已下载包仍沿用既有安装规则。
- 原集成代码的三处动态校验类型错误已修正；类型检查、受影响文件 lint/格式、仓库格式、文档配对、Host schema 生成检查、IPC freeze、CLI/TUI 更新专项均通过。真实 Host/Relay 协议一致性使用本轮构建和隔离 CA 通过，不能替代页面或手机验收。

源码构建回执位于 `.scratch/one-protocol-resume/root/verification-build.json`：Core inputHash 为 `2dc4cd343b4dd542f0c588a5bb84b6ce21ec4f5a43819f6c3c6c8b185dd52b7d`。原始红灯、通过结果、构建与门禁日志位于同目录；UI 夹具、截图及失败日志位于 `.scratch/one-protocol-resume/ui/`。

尚未通过的门禁不作豁免：`gui-health` 的 Main 总行数为 24760，基线为 24714；业务行数为 8058，基线为 8057。增量来自合入的更新通道及本轮频道竞态修复。`verify:design` 在既有 `content-system.md:17` 未登记规范段落处失败；`design:build` 通过，`test:design` 在 `a mounted accepted follow-up reserves response space` 断言失败。未发现这两项设计失败与本轮状态修改的同因证据，未修改基线或放宽断言。

Remote 最终构建在真实配对后先显示暂态加载失败，随后同一连接自动恢复，共享工作台显示“项目已停止，可选择其他项目继续。”，截图与同期 Host 状态见 `.scratch/one-protocol-resume/ui/report.md`。已证明停止项目的最终可见状态；没有点击已有会话，不能据此关闭 Remote 断线重连等其他用例。两轮诊断仍未取得原始 shell/session 请求错误，不再为夹具追加重试。

包含 UUID 与本轮恢复修复的本地候选 ZIP 已生成：`.scratch/one-protocol-resume/package-final/AReaL-Harness-GUI-mac-arm64.zip`，SHA-256 为 `fc7b56c1fbb3222020ea8add5aead5e7c222c64478962480d8d720357c01e412`。包内 Core 绑定 `744d7a08`，debug profile，ad-hoc 严格签名校验通过；`candidate-identity.json` 与 `package-evidence.json` 保存身份。这不是正式分发或公证验收。首次打包因 Core revision 不匹配而拒绝；待测试槽释放后重建，再补齐缺失的锁定 Electron 运行时，最终打包成功，原失败日志保留。

最终 ZIP 解压到独立副本后，经显式隔离环境启动，已用 System Events 按本次 GUI PID 前置并发送系统合成 ⌘Q。backend 关闭时 GUI 正常退出，同代 Host 保留；backend 开启时已确认后台 owned=true，⌘Q 打开“后台状态暂时无法核查”的原生确认，选择“保持后台运行并退出”后 GUI 退出，同代 Host 和相同后台 PID 保留。后者证明该确认分支的键盘退出路径，不证明后台状态核查正常；两轮均非物理按键操作。完整状态与清理回执见 UI 记录。

旧 safeStorage 密文兼容仍待补证。iOS 前后台恢复、停止与审批、Remote 重连、远程不可用入口及 flag off 的页面证据不能由上述回归替代，仍按 UI 记录逐项保留。恢复排查的后续软件方案：优先在共享客户端加入按连接与项目代次关联的脱敏请求诊断导出，以取得同次失败原始错误；另一方案是在既有真实 Host 夹具中补齐 App 前后台和断网的可控驱动。两者均应保留原始 UNKNOWN，不以自动重放写操作恢复。

## 剩余问题修复与验收结果

本节覆盖上文历史记录中的未完成项；原始失败、UNKNOWN 和隔离事故保留。最终业务源码为 `cf005d45`（含 `36e51975`），已包含合并的 `origin/claude/project-thread-821xno@246e2124` 和前轮 UUID/共享订阅修复。仅本地提交，未 push、发布或替换日常安装。

### 后台状态与会话恢复

后台状态失败已取得可重复因果证据：Host 的项目 Mutex 让只读活动/状态检查相互排斥，活动探测又独占生命周期文件锁，并发菜单/Main/外部客户端可将空闲 ready 项目误报 unavailable。已将 Host 项目门闩、活动锁、项目服务 status 启动锁及可用性探测改为共享读取，生命周期、凭据及停止变更仍独占；真实写锁和不确定活动仍保留 UNKNOWN。确定性红绿回归、完整 Host 测试及最终真实 Host/工作台并发读取通过。没有把 unavailable 默认改为空闲。

iOS 排查发现旧 App JS 未含前轮同目标订阅复用；按 mobile assets 身份刷新后，已在同次前后台切换中记录连接、session.open、项目代次和 Core 完成回合。另一个真实故障是原 UNKNOWN 请求已 accepted，但核查按钮没传 requestId，适配器也没发布查询结果，导致 Composer 持续只读。修复后查询并发布原权威回执，校验连接和执行项目；旧 pending-operation 缺失时只依据匹配原 ID/方法/线程的回执恢复，不重放写入。原请求仍只有一条受理结果。旧未抓包事故的唯一根因不能追认。UNKNOWN 的真实按钮红绿证据来自 `744d7a08` Core 与当时修复中 JS，最终恢复映射回归通过；最终设备轮没有人为制造或迁移旧 UNKNOWN。

### 门禁

`gui-health`、`verify:design`、`test:design`、相关类型/lint/格式、文档与 Host/Relay 协议验收均通过。Main 总行数 24714、业务行数 8055，未放宽预算。更新代码消除重复；设计清单仅刷新既有非规范条目的指纹；连续回复占位断言按原 Messages R-MESSAGES-012 契约修正，产品滚动实现未改。日志与红灯在 `.scratch/one-protocol-resume2/root/`。

### 用户路径验收

| 路径 | 结果与证据 |
| --- | --- |
| 停止项目默认选中 | 首页明确显示项目已停止并结束连接忙碌；前轮真实 Remote 页面证据与投影回归保留 |
| iOS 恢复、停止、审批 | 最终共享 JS 在隔离 iOS 模拟器后台返回后保留历史并能发送，`cf005d45` Core 上单独复验两回合 completed；此前相同 JS 在 `36e51975` Core 上停止 accepted/Core interrupted，允许一次 accepted/Core completed，隔离文件实际写出 approved。见 `ui/report.md`、`ui/remote-run/final-core-result.json` 与 `ui/final-core-repeat/` |
| Remote 断线重连 | 离线提示可见，恢复后可打开会话并发送，Core completed；见 `ui/remote-run/` |
| 远程不可用领域 | 未授权跨项目领域按能力隐藏导航入口；不是点击后拒绝的证据 |
| flag off | 旧 Remote 页面显示项目，实际打开已有线程并读到共享页发送的消息 |
| 原生 ⌘Q | 最终 ZIP 原样解压，以包内 Core 运行；真实系统合成按键退出，跨 Main readiness 的并发活动读取完整，全程采样无 unavailable；退出后 Host/后台保持同代同 PID。见 `quit-ui/package-stable5-*.json` |
| 旧格式凭据 | 历史 writer + 原生 safeStorage 的合成旧密文由当前 reader 经 Main 解密后发送，loopback 验证匹配且创建会话；专用 Keychain 删除并确认不存在 |

最终原生夹具早期在工作台启动期间观察到 unavailable；后续稳定运行仍捕获一次退出准备后的 8ms unavailable，由此继续定位到项目服务的独占只读锁，扩展原回归确认红灯后修复，并用最终包全采样通过。未把首轮退出成功冒充并发全部通过。其他夹具错误及原始失败保留在 `quit-ui/report.md`。

### 最终产物

最终候选 `.scratch/one-protocol-resume2/package-final3/AReaL-Harness-GUI-mac-arm64.zip`，SHA-256 `d607610cd2d86cf93cb606e7082f584d77b56714a2a93895c3ff6e5c3446e20b`。包内 Core revision `cf005d45`、workingTree=false、inputHash `db2ee761b45fff5ca9b173f5f94196c058e2fa93f3d8c0c1ae4af117e044fe93`，严格 ad-hoc 签名有效。最终源码 Core 与 GUI 均重新构建，候选包含 UUID、订阅和本次修复。身份见 `root/candidate-identity-final3.json` 与 `package-final3/package-evidence.json`。

这是 macOS arm64 debug/ad-hoc 本地验收候选，未做 Developer ID/公证。测试使用隔离数据、合成凭据、本地模型及 Relay；iOS 模拟器与系统合成 ⌘Q 不替代物理真机/按键。旧格式兼容证明历史 writer 生成的合成密文可被最终源码 reader 解密并发送，不使用或证明用户真实历史密文字节。Node 24.2.0 存在 workspace engine 版本警告。
