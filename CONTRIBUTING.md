**中文** | [English](CONTRIBUTING.en.md)

# 参与开发

先阅读[快速开始](docs/guides/quickstart.md)、[架构](docs/design/architecture.md)和[开发规范](AGENTS.md)，再按[开发指南](docs/development/README.md)运行 `make setup` 与 `make verify`。原生 Runtime、插件和 Workgroup 修改还需对应[集成测试](docs/development/testing.md)。

缺陷报告提供提交、平台、最小复现与预期行为；安全问题使用[私密报告流程](SECURITY.md)。复现使用合成数据，不提交凭据、会话数据、个人配置或本机绝对路径。

变更聚焦一个问题，遵循 Clients → Core → Runtime 依赖方向。接口与配置变更同步维护类型、调用方、示例和中英文文档。PR 说明目的、兼容性、文档位置及实际验证结果；未执行的检查说明原因。仅文档变更运行链接检查并核对示例即可。

使用锁定依赖，不以无沙箱执行绕过测试失败。本项目使用 [Apache-2.0](LICENSE)，贡献遵循同一许可证。
