**中文** | [English](README.en.md)

# AReaL Remote Relay

单实例 `areal.relay.v1` WebSocket 字节路由。SQLite 只保存登记 hash、允许的 room、状态、创建时间和 channel 限额；连接仅在内存，没有 payload、离线命令队列或会话数据库。Noise 身份 pin 和设备授权仍由端点负责。

本服务验收使用真实本机 HTTP/WebSocket 进程和 SQLite，**不代表**桌面 Host/PWA Noise 配对、真实手机、公网 WSS 或跨网验收。Host/PWA 源码接入与本机 Node 严格 TLS 用例由 GUI 的 `test:remote-relay` 单独覆盖；浏览器与真机层仍需独立证据。参见 [API 契约](../../docs/api/remote-control.md#c12-relay-的最低服务契约)、[使用指南](../../docs/guides/remote-control.md)和[验收矩阵](../../docs/development/remote-control-testing.md)。

[Relay/TLS 部署说明](deploy/README.md)提供非 root 容器、Remote 专用静态产物构建/只读挂载与运维命令。公开域名、可信证书、真实设备和容量仍须在部署环境分别验收。

## 本机运行

从仓库根执行：

```sh
cd services/remote-relay
npm ci --ignore-scripts
node src/cli.mjs enrollment --config config.development.json
node src/cli.mjs serve --config config.development.json
```

精确使用 **Node 24.2.0**（`.node-version`），本服务独立检查，不修改 GUI 的运行时要求。此版本内置 `node:sqlite` 仍为实验功能，会打印警告。唯一包依赖为 MIT 许可的 `ws` 8.21.3，公共 registry 地址与完整性固定在 `package-lock.json`。不需要安装脚本或可选原生包。

内部 `src/host-runner.mjs` 为 Host 监督的本机 Relay 提供私有进程接口：stdin 首行接收配置和 room，stdout 在监听成功后发送 ready，stdin EOF 后关闭服务与 store 并释放本次锁。GUI 包可使用其受控 Electron 无头 Node；普通 Relay CLI 仍要求上述 Node 24.2.0。该内部入口不改变对外 HTTP/WebSocket 协议。

管理员本地 `enrollment` 命令输出 256 位随机、十分钟、一次性 code，经私密渠道交给 Host 操作者。`POST /enroll` 只接收 `{"code":"..."}`，要求 `Content-Type: application/json` 且**无 Origin**；成功（201）仅返回 `{"capability":"...","room":"..."}`。capability 为 32 字节随机数的无 padding base64url；room 为 capability UTF-8 的小写十六进制 SHA-256。capability 保存到 Host 安全存储，绝不进入浏览器邀请/二维码。响应丢失须生成新 code，没有凭据找回 API。

`GET /healthz` 返回 `{"ok":true}`，没有公开管理路由。`assetsDir` 必须显式指向包含 `remote.html` 的已构建 PWA 目录；`/` 提供该文件。纯传输服务可省略该目录（静态请求返回 404）。只提供目录内文件，设置 CSP、no-referrer、MIME 防护和 no-store；不要将凭据或私有文件放在该目录。

使用 `pnpm --dir clients/gui build` 与 `pnpm --dir clients/gui export:remote /absolute/new/remote-pwa` 构建并导出 Remote 资源闭包，将输出目录用作 `assetsDir`。不要指向 Desktop dist。CSP 的 `style-src` 与 Direct 一致允许内联样式，以支持同一 PWA 的现有样式；脚本策略仍为同源。

Host ready 返回当前配置的帧/字节/最大帧限额、实际 heartbeat 间隔和 `push:boolean`。缺少 `push` 的旧服务按不支持推送处理。新 Host 要求该限额声明，不兼容缺少限额声明的旧服务；Client 的 ready-channel 不变。Host 保留心跳额度并对 data/close 平滑限速，拒绝无法安全承载数据的低额度而不更改服务配置。服务仍逐帧执行其原有资源限制；该声明不是执行授权。

## 生产边界

复制 `config.example.json`，填写精确 HTTPS `publicOrigin`、明确的 `allowedClientOrigins`、私有 `dataDir` 和已构建 `assetsDir`。相对路径按工作目录解析。后端只绑定 `127.0.0.1` 或 `::1`；`trustedLocalTlsProxy: true` 明确确认**同一台机器上的可信 TLS 代理**。公网 TLS/WSS 与代理部署归 RC-14。本服务没有直接 TLS 监听器，不能将公网明文监听器转发到此后端。

代理只接收选定的 HTTPS 主机名，保留精确 Host 头，将 `/remote/socket` 按 WebSocket 转发，并设置请求/连接限制。明文 HTTP 可重定向 HTTPS，但不能代理 enrollment 或 WebSocket 流量。禁止记录请求体、WebSocket 内容、登记 code、凭据、邀请或敏感 URL fragment。后端不信任 `Forwarded` 或 `X-Forwarded-*`；其他本地进程处于这一明确的信任边界内。没有通配 Origin 或自动公网回退。只有显式 `development: true` 且公开 origin 为 loopback 时才允许 HTTP/WS。

Relay 的 `allowedClientOrigins` 继续只接受 Web origin。可选 `allowedAppOrigins` 默认为 `[]`；原生 App 部署可显式设为 `["capacitor://localhost"]`。每项必须是精确的 `scheme://host`，scheme 不能是 `http`、`https`、`ws`、`wss`；拒绝空 host、凭据、端口、路径（含结尾斜杠）、查询、fragment、空白与百分号编码。WebSocket upgrade 和 client 注册都要求 Origin 精确命中两份列表之一；无 Origin 只允许证明登记凭据的 Host，不能注册为 Client。自定义 scheme 的 `URL.origin` 可以是 `null`，因此按已验证的完整字符串比较。原生 App 可以伪造 Origin，Origin 不提供身份或执行授权；Host 身份仍由 Noise pin 验证，权限仍由 Host DeviceGrant 决定。

## 外层协议

连接 `/remote/socket`；禁用压缩和二进制 WebSocket 消息。第一条 JSON 为登记消息：

| 发送者 | 消息 / 响应 |
|---|---|
| Host，无 Origin | `{protocol:"areal.relay.v1",role:"host",room,capability}` → `{type:"ready",push?:boolean,limits:{framesPerSecond,bytesPerSecond,maxFrameBytes,heartbeatIntervalMs}}` |
| Client，允许的 Origin | `{protocol:"areal.relay.v1",role:"client",room}` → `{type:"ready",channel}`；Host 收到 `{type:"open",channel}` |
| 任意端点 | `{type:"data",channel,data}` 仅向所属对端转发 opaque 标准带 padding base64 |
| 任意端点 | `{type:"close",channel}` 释放该 channel |
| Relay | `{type:"error",code}` 或 `{type:"close",channel}`；错误不回显输入 |

支持推送的 Host 在 WebSocket upgrade 时发送 `X-Areal-Relay-Capabilities: push` 请求头。只有这些 Host 的 ready 包含可选 `push` 字段，并接收 `pushResult`。旧 Host 继续收到原有 ready 结构；旧 Relay 忽略该请求头，ready 缺少该字段时表示不支持推送。此请求头只声明解码能力，Host 身份仍由登记 capability 证明。

Client 的 data/close **必须**携带 ready 返回的 channel。合法 Host 重连替换旧连接并关闭旧 channel；旧 Host socket 不能访问新 channel。Host 的未授权或已关闭 channel 帧统一返回 `UNAVAILABLE` 且不转发，允许在途帧与 Host close 回送不拖掉其他设备。Client 伪造 channel 则关闭该 Client。未知、禁用、离线 room 均返回相同 `UNAVAILABLE`。重启后由端点重连并获取应用新基线，不保留离线消息。

## 配置 APNs

默认配置省略 `apns`，Host `ready` 返回 `push:false`。`config.apns.example.json` 展示启用推送所需的配置。替换其中的团队 ID、密钥 ID 和 Bundle ID，并把 Apple 提供的 P-256 `.p8` 密钥放到 `keyFile` 指定的位置。服务启动时读取该文件，管理命令仅验证配置。服务进程必须有读取权限。容器部署时，把密钥单独只读挂载到配置的路径，UID 1000 必须可读。密钥不放进镜像、仓库或数据备份。

`maxPerHostPerMinute` 默认 60，可设为 1 至 600 的整数。额度按已登记 room 计算，Host 重连不能重置当前分钟额度。最多同时处理 32 个 APNs 请求，每个请求最多等待 10 秒。限流返回 `LIMIT_EXCEEDED`，未开启返回 `UNAVAILABLE`，Host 连接继续可用。Relay 不保存 token，不排队或重试通知。通知失败不会改变任何会话或审批状态。

`production` 使用 `https://api.push.apple.com`，包括 TestFlight；`development` 使用 `https://api.sandbox.push.apple.com`。系统 TLS 校验保持开启。ES256 JWT 缓存 50 分钟。APNs 请求带配置的 Bundle ID、`alert` 类型、优先级 10 和 Host 的 `collapseId`。只有固定中文标题和正文进入 `aps`，导航 IDs 放入顶层 `target`。APNs 返回 `410 Unregistered` 时，Relay 向当前 Host 发送 `pushResult`，供 Host 删除失效 token。日志只含时间、随机 route、kind 与状态码。

参考 Apple 的[令牌认证说明](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns)和[通知请求说明](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns)。

## 预算与管理

配置只能收紧 `src/config.mjs` 的上限：100 个活跃 Host、256 个 TCP/WS 总连接、32 个未登记 WS、每 Host 16 个 channel、512 KiB 外层 JSON、每 socket 2 MiB 发送积压、每 socket 每秒 80 帧和 2 MiB、全局每秒 50 次 upgrade 与 10 次 enrollment。base64 必须小于等于 `maxFrameBytes - 128`；更大的 Noise 字节序列须先拆帧再编码。慢 Client 只失去自己的 channel；Host 共享 socket 的发送也有同样积压上限。

WebSocket 解码最多允许 128 个 fragment 和 128 个缓冲 chunk。登记截止 15 秒；心跳 15 秒，45 秒不可达后关闭。HTTP headers 截止 10 秒、请求截止 15 秒、enrollment body 1 KiB、headers 8 KiB，全局每秒 200 个请求。速率使用一秒窗口。这些限制在 Noise 前生效；Relay 看不到 Noise 完成状态，也不能区分业务读写。Host 仍须执行 15 秒 Noise/hello 截止、待处理设备与应用请求限额。这些数值是资源控制，**不代表**已验证生产容量。

所有本地管理命令使用同一配置：

```sh
node src/cli.mjs revoke ROOM --config CONFIG.json
node src/cli.mjs backup /private/backup.sqlite --config CONFIG.json
# 先停止 serve 再恢复：
node src/cli.mjs restore /private/backup.sqlite --config CONFIG.json
```

撤销先持久化；逐帧检查登记，空闲 Host 也会在一秒内关闭。撤销 Relay room 与撤销手机的 Host grant 不同。backup 使用 SQLite 在线备份，拒绝已有目标。受支持的 restore 要求服务停机，在替换前禁用**全部**恢复出的 Host 登记与 enrollment code；替换前，restore 要求对已禁用的暂存库和已有库完成 SQLite checkpoint，确认无 busy 或剩余 WAL 工作，不手工删除现有 WAL。checkpoint 失败则拒绝替换；原子 rename 失败或被中断时，旧库仍保留全部已提交撤销。成功恢复后重新生成登记，不直接把旧数据库复制到运行中的部署。

数据目录/文件权限为 0700/0600。`server.lock` 阻止两个服务进程或运行中恢复；`admin.lock` 串行化本地管理。正常关闭释放锁。崩溃后，确认记录的 PID 与任何服务/管理进程均已停止，再删除残留锁，不能删除活跃锁。被中断的 restore 还可能留下 `restore.sqlite`、`restore.sqlite-wal`、`restore.sqlite-shm`；确认相关进程停止后，仅删除这三个暂存文件，再重试 restore。不能删除现有 `relay.sqlite-wal` 或 `relay.sqlite-shm`。清理锁后正常启动，读取的要么是完整旧提交状态，要么是全部禁用的新库。如果现有库损坏或无法 checkpoint，保留它，将可信备份恢复到新的私有 `dataDir`，不能绕过 checkpoint 校验。单 OS 服务账号运行，使用本地文件系统，不跨机器共享卷。enrollment 过期记录在生成 code 时清理；库中最多 1,024 个未过期 code、10,000 个 room 记录（含已撤销）。不自动删除 room 或回滚撤销。

## 验收

```sh
npm test
npm audit --omit=dev
```

测试启动隔离的真实服务进程，使用真实 WebSocket socket，覆盖 capability/room/channel 伪造、替换/close 竞态、重启/离线、匿名容量/超时、帧/字节/fragment 限额、实际停止读取的 TCP 客户端、HTTP/Origin/静态边界、过期、撤销、备份/禁用恢复以及日志/SQLite 秘密标记扫描。它们验证 opaque 路由接口，不验证 Noise 或 GUI；不运行云、手机、公共域名、原生 GUI 或生产容量测试。

推送测试临时生成 P-256 密钥和 TLS 证书，经 CLI 登记、真实 WebSocket 与本机 HTTP/2 TLS 验证签名、缓存、固定载荷、限流、错误和关闭。测试通过内部构造器替换网络连接，仅连接本机服务。真实 APNs 投递、iPhone 锁屏与 TestFlight 签名需要配置真实 Apple 资源后单独验收。
