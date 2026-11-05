# one-protocol 本机验收交接

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
