**中文** | [English](CONTRIBUTING.en.md)

# 参与开发

先阅读[快速开始](docs/guides/quickstart.md)、[架构](docs/design/architecture.md)和[开发规范](AGENTS.md)，再按[开发指南](docs/development/README.md)运行 `make setup` 与 `make verify`。原生 Runtime、插件和 Workgroup 修改还需对应[集成测试](docs/development/testing.md)。

涉及 GUI 页面、组件、样式、动效或 UI 文案时，编辑前先读[设计系统开工顺序](clients/gui/design-system/README.md#开工顺序)，交付遵循[设计完成条件](clients/gui/design-system/governance.md#完成条件)。

缺陷报告提供提交、平台、最小复现与预期行为；安全问题使用[私密报告流程](SECURITY.md)。复现使用合成数据，不提交凭据、会话数据、个人配置或本机绝对路径。

变更聚焦一个问题，遵循 Clients → Core → Runtime 依赖方向。接口与配置变更同步维护类型、调用方、示例和中英文文档。PR 说明目的、兼容性、文档位置及实际验证结果；未执行的检查说明原因。仅文档变更运行链接检查并核对示例即可。

功能、测试和验证规则在同一变更中交付。开发前运行 `make check-changed CI_BASE=<实际比较引用> ARGS=--plan`，按生成的必跑清单选择验收；共享接口、锁文件、构建脚本、CI 和未知路径扩大范围。行为或接口变化时，同步核对 schema、调用方、测试断言与 fixture、测试 manifest、环境能力、产物依赖和文档。已有检查足以覆盖时提交执行证据即可；新增能力或运行前提必须登记到共享计划。入口迁移后测试走当前产品入口，底层兼容、安全和 UNKNOWN 契约继续保留。

提交前运行局部快检，推送前对最终提交运行 `make check-changed CI_BASE=<实际比较引用>`，执行受影响快检及已有报告中的失败专项和依赖。完整本机验收可按需运行 `make ci-preflight CI_BASE=<实际比较引用>`。启用 hooks 后，提交钩子检查暂存快照的 manifest 并生成影响计划；推送钩子要求干净 HEAD 并执行相同快检和失败专项。历史报告只用于选检，不复用通过结果；报告来源和进度读取方式见[测试指南](docs/development/testing.md)。远端独立重算计划，核对当前源码、run/attempt、全部应跑项及其结果；缺项、失败、取消、环境阻塞和失效证据都不能放行。只有规则判定不适用的项目才可跳过。目标是当前提交全部适用必需门禁通过，同时保留首跑失败；用首跑全绿率、首次可信失败时间、完整反馈时长与 runner 分钟衡量改进，不以重跑后的绿色掩盖不稳定性。

使用锁定依赖，不以无沙箱执行绕过测试失败。本项目使用 [Apache-2.0](LICENSE)，贡献遵循同一许可证。
