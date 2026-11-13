**中文** | [English](0017-one-protocol-one-ui.en.md)

# 0017：Host 是唯一入口，客户端共用一套协议和一份界面

状态：已接受，已实现；工作台服务（Node）仍是过渡承接。本文在 [ADR 0016](0016-shared-host.md) 的所有权之上，决定客户端如何连接与界面如何复用。它取代[共享 Host 实施规格](../development/shared-host-spec.md) H2 中"Renderer 与 Core 的连接方式不变"的表述：当前 Renderer 经 Electron Main 的桌面 IPC 取数，并不直连 Core。

## 背景

共享 Host 落地后仍有三个客户端入口：GUI 经 Electron Main 的 48 个桌面命令，远程网页与手机经 Host 内的 Remote Gateway，TUI、CLI 与本地网页向 Host 取 Core 描述后直连 Core。界面也有四份：GUI Renderer、远程网页、手机页面和 `clients/web`。发送、停止、审批、配置与队列在 Main（JS）和 Gateway（Rust）各实现一遍。Main 仍持有约 2.7 万行业务代码，浏览器与手机无法复用。

## 决策

1. **客户端只是投影。** 客户端只保存可重建的投影和未发送草稿。Thread、Turn、Task、回执以 Core 为准，跨项目数据以 Host 为准。
2. **Host 是唯一客户端入口。** GUI、网页、手机、TUI、CLI 都只连 Host。Host 认证、授权、按 `projectId` 路由并按需唤醒 Core。项目服务与 Core 不面对客户端；TUI 直连 Core 只保留为开发与排障入口。
3. **一套协议，多条传输。** 方法与消息沿用 Host 现有封装 `{version,id,method,params}` 和 Gateway 方法表，由 `schemas/` 下一份 schema 生成 Rust 与 TypeScript 类型。本机 GUI 与浏览器用 Host 直接监听的 `127.0.0.1` WebSocket；TUI、CLI 用 Unix socket；远程用 Noise（Direct 或 Relay）。三条传输承载同一组方法。
4. **一份界面，多个外壳。** GUI、网页与手机运行同一份 React 构建。Electron 外壳提供窗口、通知、文件对话框等原生能力，以及由外壳登记到 Host 的桌面工具；Capacitor 外壳提供钥匙串、扫码与推送；浏览器不提供额外能力也能完整使用。界面按能力显示入口，不按端分支。
5. **能力按授权与资源给，不按端。** 设备授权分为查看、提交、审批、管理。手机默认获得前三级，管理（凭据、配对、删项目）在配对时单独勾选。保留的限制只有分页、单帧大小与分块上传等资源上限，由 `hello` 告知；不保留按端写死的会话类型、附件或 Workflow 限制。
6. **业务先迁到 Host 监督的 Node 子进程。** 尚未改写为 Rust 的 Main 业务迁入 Host 监督的无头 Node 子进程（工作台服务），沿用本机 Relay 的监督方式。它只通过 Host 对外，不开放客户端端口。之后按领域改写进 Host 或 Core，不阻塞协议统一与界面合一。

## 取舍

- 本机多经过 Host 一跳，延迟可忽略；换来的是一处认证、一份清单和一套实现。性能风险在推送数据量，所以同步必须是清单订阅加单会话订阅，不推全量。
- Node 子进程增加一个受监督进程，并要求发行布局带无头 Node。缺 Node 的布局对相应能力报告不可用，与本机 Relay 一致。
- 统一协议后，旧桌面 IPC 在迁移期间并存。新功能只进协议，旧 IPC 只删不增。
- 已发布的 iOS 与 PWA 客户端按原方法表继续工作。新能力只通过 `hello` 协商加入。

## 不变

不改 Core Store 格式，不移动数据目录，不改监督链与清理证明。UNKNOWN 不重放、受理回执优先、单写者继续有效。实施与验收见[实施规格](../development/one-protocol-spec.md)。
