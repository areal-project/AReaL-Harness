**中文** | [English](README.en.md)

<div align="center">
  <h1>AReaL-Harness</h1>
  <p><strong>模块化 Agent 执行框架</strong></p>
  <p>独立 Runtime · 可组合 Core · CLI、TUI 与本地 Web</p>
  <p><a href="docs/guides/quickstart.md">快速开始</a> · <a href="docs/README.md">文档</a> · <a href="docs/design/architecture.md">架构</a> · <a href="CONTRIBUTING.md">贡献</a></p>
</div>

AReaL-Harness 使用 Rust + Tokio 构建。Core 管理模型、工具循环和多 Agent 任务，Runtime 管理执行权限与资源，客户端共享同一份会话历史。

项目处于开发阶段，以源码构建方式使用。完整本地工具链面向 macOS 可信宿主；Linux 工具执行限受控 Docker 环境。SDK 尚未发布 npm。详见[当前能力与边界](docs/features.md)。

| 从这里开始 | 内容 |
|---|---|
| [快速开始](docs/guides/quickstart.md) | 构建、无密钥验证、第一次模型会话 |
| [文档目录](docs/README.md) | 使用指南、API、架构、开发与基准测试 |
| [开发指南](docs/development/README.md) | 依赖、检查与贡献流程 |
| [安全报告](SECURITY.md) | 信任边界与漏洞反馈 |

使用 [cordis-rs](https://github.com/dshbox/cordis-rs) 组件，参考 Codex 协议和 DeepSeek Harness 插件接口；来源见 [upstream/pins.json](upstream/pins.json)。

**许可证：** [Apache-2.0](LICENSE)。第三方材料保留各自的许可证与版权声明。
