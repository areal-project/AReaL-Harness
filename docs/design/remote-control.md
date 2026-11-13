**中文** | [English](remote-control.en.md)

# Remote Control 架构

共享 Host 的实施与验收边界见[实施规格](../development/shared-host-spec.md)，所有权以 [ADR 0016](../adr/0016-shared-host.md)为准。当前 Rust Host 持有 Gateway、授权、Store 外提交 journal、定时激活及 provider subscription transport。GUI 普通退出释放自身连接，后台 Remote 继续由 Host 承载；明确停止后台按原回执结算。完整 H3 对照与真机验收尚未完成。Host 监督身份与 Remote Noise peer 独立，多 profile 的不同 Noise 身份不能覆盖。

本文定义 Remote v2 的架构与边界，协议设计不等于全部场景已验收；当前模块职责见[架构与目录](architecture.md)，验证入口见[测试计划](../development/remote-control-testing.md)。

## Direct 入口与实现范围

Direct 入口由 Rust Host Gateway 独立监听 loopback；它不代理 Main 的高权限请求分发器。浏览器 shell 复用现有 GUI 构建，使用共享 `@areal/remote` Noise 实现；方法按实际能力和设备授权开放，不持有 Core 连接或执行循环。v2 在解码 JSON 前使用收紧的消息与缓冲限额，旧本地服务继续沿用其所有者。旧 JS `RemoteControl` 保留为迁移对照，完整对照通过后再退役。

本机开关默认关闭。Direct 与 Relay 共用配对和设备授权；本地隔离测试不证明公网部署或旧配对真机升级已通过。运行入口和证据范围见[测试计划](../development/remote-control-testing.md)。现有 Shared Browser、原生预览和浏览器工具不属于本票改动。

## 目标与决策

桌面电脑运行共享 Rust Host，并由它持有 Remote Gateway。Core 是 Thread、Turn、Task、TaskRun、交互与历史的唯一权威；Runtime 仍只负责执行边界与操作事实。Web/PWA 保存可重建投影和未发送草稿。

首发提供 Direct 与 Relay 两种网络实现。两者共享配对、授权、命令及投影契约；详细方法只定义于 [Remote API](../api/remote-control.md)。关键决策见 ADR 0002–0005。

## 组件与依赖

| 组件 | 所有者与职责 | 禁止承担 |
|---|---|---|
| Desktop GUI | 本地启用、网络配置、配对确认、设备撤销、故障诊断 | 成为 Remote 存活条件 |
| 共享 Rust Host | Project 监督与连接、凭据保管、Gateway 生命周期、Core 提交关联 | 第二个 Agent/任务调度引擎 |
| Remote Gateway | 当前设备授权、方法白名单、受限投影、业务命令映射、审计元数据 | 通用 RPC 或任意文件/终端代理 |
| SecureChannel / Transport | 复用 Noise；Direct 或 Relay 的字节收发与背压 | 执行权限判定 |
| Core | 业务准入、持久收据、会话状态、审批裁决、Task 协调 | 信任客户端自己宣称的权限 |
| Web/PWA | 概览、Session、交互和只读结果；连接代际与草稿 | 自动重放不确认的命令、保存 Core token |
| 可选 Relay | Host 登记、路由、限流和连接健康 | 存储业务正文、审批、离线代执行 |

所有 Remote 请求先经过 Gateway。Direct 不代理现有桌面私有 WebSocket，也不把 Core loopback 端口改为公网监听。Thin UI 不意味着把授权和错误恢复推给浏览器。

## 共享客户端实现

`@areal/remote-client` 供 PWA 与原生壳复用。`RemoteConnection` 负责 Direct/Relay wire、Noise Host pin、hello/ready、RPC 超时与清理。握手事件交给页面展示，`ready` 钩子完成身份持久化后才开放请求。`session.open` 的结果回调在 RPC Promise 完成前同步发布基线，随后增量沿同一消息流处理。

`CommandState` 保存命令与草稿映射；`acceptSessionMessage` 校验订阅身份与序号；`SessionBodyReader` 保存可丢弃的正文分页缓存。`ClientState` 管理身份 epoch、记住设备的 revision 与 UNKNOWN 命令定位信息。它通过注入的原子存储事务比较并提交 `{ schema: 1, revision, credential, locators }`，不把未确认命令重发。存储回调同步返回待保存记录与结果，适配器只能在提交完成后返回结果。

Web 的 `BrowserState` 提供 IndexedDB、BroadcastChannel 与 sessionStorage 适配。IndexedDB 请求成功不等于事务提交，跨标签失效和提交后的 abort 继续由事务边界处理。DOM、页面生命周期与重连调度仍由 PWA 所有；共享包不访问 DOM、IndexedDB 或 Capacitor。

## 两条连接路径

### A：无自建云端

Client 的浏览器通过组织 HTTPS/VPN 或 Tailscale Serve 访问 Host 的低权限本地服务；该服务同时提供静态 PWA 和加密 WebSocket。Host 不向产品厂商登记，不需要 AReaL Relay。

默认入口限私网。普通手机浏览器跨公网可使用显式启用的 Tailscale Funnel，仍保留 Host 配对和应用授权。只暴露 Remote 监听器；不用长期 Core Bearer 登录。已有 HTTPS 反向代理同样适用，产品协议不绑定某个 VPN 厂商。Serve/Funnel 外部前置条件与限制见 [部署指南](../guides/remote-control.md)。

### B：自托管 Relay

Host 与 Client 均向组织 Relay 建立出站 WSS。Relay 关联 room/channel 并转发 Noise 记录。静态 PWA 可同域部署以减少配置，但 Web 代码发布源仍受组织信任；它不是“完全不受信任的 Relay”。

组织管理员先部署 HTTPS 入口、静态客户端和单实例 Relay，生成一次性 Host 登记凭据。桌面导入部署配置后执行扫码流程；终端用户不管理证书、路由器或数据库。Relay 不需要模型账号、项目路径和自然人账号平台。

## 所有权与故障域

一台 Host 可聚合多个已保存项目，每个项目绑定已发现的 Core serviceId/generation。Host 身份、Gateway 进程代际、Core 服务代际、Runtime epoch 和工具 Host generation 分开处理。

关闭页面释放对应观察连接。普通 GUI 退出不结束 Host-owned 监督链或 Gateway；Main 独占的桌面工具连接随 GUI 退出撤销。Remote 订阅释放不能关闭其他客户端仍在使用的订阅。停止 Gateway 不隐含取消 Core 已受理的工作。系统休眠、注销、断电、显式停止服务时不承诺在线或任务继续。

被动重连只发现兼容运行中的 Core；不启动已停止项目，不触发安全重启，不提升权限。Project 不可用显示其具体状态；Host 的其他项目继续工作。

## 命令边界

Gateway 在已有提交 journal/outcomes 中附加 remote 元数据，记录认证设备、业务命令键、语义摘要和原生 Core 请求标识。它可以记录“已转发/回执未知”，不能制造“任务成功”。不增加第二个模型执行日志或第二套 Session store。

普通新消息只走空闲准入；Core 原子拒绝竞争中的第二个活动 Turn。Remote 不沿用桌面 send 的隐式自动排队。停止携带用户看到的 Turn ID；审批携带已审阅参数摘要；Task 暂停绑定指定 Run 与 revision。具体比较及冲突结果见 API。

一个项目获得授权表示该项目内可见的会话和工作可被读取，不表示操作系统沙箱。操作者可通过 Agent 使用其被允许的工具，因此项目授权界面必须展示当前执行权限风险。

## 观察与移动端信息架构

概览中的 WorkItem 是普通 Thread 或已有 TaskRun 的投影。TaskRun 已覆盖的协调 Thread 不重复显示为独立工作；worker 归属到 TaskRun 的详情。Session 保留实际 Thread ID。

“运行状态”和“待处理原因”是两个维度。例如异步问题待回答时 Agent 仍可工作；不能一律显示“已暂停”。未知执行、离线和新结果可读也不能混成同一个 waiting 状态。

概览只含受限摘要与待处理计数；选中 Session 才建立详情订阅。完整正文、Diff、图片分段读取。暂存客户端状态只用于显示，恢复时被权威基线替换。

P0 没有全局耐久事件流。Gateway 订阅已有 Core 能力；缺少跨未打开 Thread 的汇总查询时，在 Core 暴露只读、有界、同一权威状态来源的摘要查询，不通过订阅所有历史来凑概览。该查询不得引入新状态所有者；其最小新增契约见 API 的 overview 部分。

## 安全与组织使用

本地配对确认是控制权授予入口；网络可达、room ID 或扫码本身都不是授权。观察者与操作者使用明确能力预设，不拥有远程管理权限。授权缩小后，缓存、订阅、制品流和新命令都重新受限。

P0 一次 Relay 部署对应一个组织/个人管理域，可登记多个 Host。不同组织使用独立实例/数据卷/登记凭据。P0 不声称同一 Host OS 用户内的强多租户隔离；需要该隔离的组织必须采用不同 OS 用户或独立机器/沙箱部署。

既有 Noise 库保留握手、身份和 AEAD 职责。Web 静态资产同源固定发布、严格 CSP、无第三方运行脚本；禁止任意渲染原始 HTML。浏览器身份可被同源恶意代码访问，不能宣传为钥匙串级防护。

## 迁移与发布

应用协议 v2 在加密通道建立后协商；现有 Noise prologue 是独立传输兼容标记，不因增加业务字段而自行改写密码学握手。旧配置事务迁移并留可恢复副本，设备需本地复核授权。旧写客户端不自动降级接入 v2。

P0 不迁移整个桌面 monorepo，不复制完整 Workbench，不导入第三方 ADE。新 PWA 复用领域契约与必要展示组件；Electron 原生功能留在原入口。实现路径和包归属以[架构与目录](architecture.md)及当前源码为准。

发布前两条网络路线必须通过同一业务一致性测试，并分别验证 TLS/Origin/限流/凭据和真机配对。详见 [测试计划](../development/remote-control-testing.md)。

相关决策：[Host 所有权](../adr/0008-remote-host-ownership.md) · [传输与信任](../adr/0009-remote-transports-and-trust.md) · [命令恢复](../adr/0010-remote-command-recovery.md) · [薄客户端领域](../adr/0011-remote-thin-client-domain.md)。
