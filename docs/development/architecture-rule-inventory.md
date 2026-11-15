**中文** | [English](architecture-rule-inventory.en.md)

# 首批架构规则与验证旅程

这份清单把 pstack 实践中的第一批确定性规则落到 AReaL-Harness。规则由 `schemas/architecture-manifest.json` 执行，旅程由 `clients/gui/scripts/journey-manifest.json` 登记；本文只说明为什么存在、如何验证和何时可以放宽。

## 首批规则

| ID | 约束 | 机器检查 | 合法例外 |
| --- | --- | --- | --- |
| `renderer-shell-boundary` | Renderer 只能通过 `PlatformServices` 使用壳能力 | `scripts/check-architecture.py` | 测试文件中的 bridge mock 由现有 lint 规则管理 |
| `client-authority-boundary` | 客户端不直接拥有 Core 历史、Runtime 权限或 Store | `scripts/check-architecture.py` | 无；需要新能力时增加 Host/Core 协议 |
| `core-runtime-authority-boundary` | Core 不导入 Electron 或 Runtime OS 实现 | `scripts/check-architecture.py` | 无；通过 Runtime 合同调用 |
| `runtime-product-boundary` | Runtime 不决定模型策略、产品工作流或并行宽度 | `scripts/check-architecture.py` | 无；由 Core 调度 |

这些规则先阻止新增越界，存量例外必须在对应代码路径被实际触及时收敛。规则的错误信息需要指出 owner、文件、行号和推荐入口，不能只报告 forbidden import。

## 首批旅程

- `conversation-submit`：提交后同时证明 Core 受理、Turn 结算和用户可见结果。
- `unknown-receipt-recovery`：连接中断后保留原 request、核对原收据、不重放未知修改，并观察 Runtime 清理结算。

旅程注册表用于从改动路径反查需要的用户路径和证据。它不能把单元测试冒充真实页面验收；`checks` 是入口索引，最终报告仍要区分契约、权威执行、可见投影和清理证据。

## 接入顺序

1. `check-architecture.py` 和 `check-journeys.py` 先作为早期离线合同。
2. `check-changed` 根据改动路径将架构和旅程检查加入计划。
3. `ci-preflight` 在报告中保存 `evidenceVersion`、受影响旅程和权威层级。
4. 旅程证据覆盖稳定后，才允许自动修复或自动合并低风险 PR。
