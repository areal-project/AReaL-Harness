**中文** | [English](README.en.md)

# 历史报告

历史记录不定义当前能力。新测试使用[运行指南](../README.md)，统计约束见[方法](../methodology.md)。

| 报告 | 证据范围 |
|---|---|
| [会话目录、分页与 GUI 刷新](conversation-catalog.md)、[迭代验证](conversation-catalog-validation.md)、[内存与 SQLite 对照](conversation-catalog-sqlite.md)、[轻量目录与按需历史](conversation-catalog-lazy.md) | Engine/RPC 交替 release 对照、真实 GUI 缓存 IO 与兼容回归；保留不利结果，不外推整体 Agent 收益 |
| [收尾、读取补位与 Responses 路由](completion-cache-routing.md) | 固定100次对照、缓存接近但仍慢30.6%；保留失败、UNKNOWN、机制补修与未晋级结论 |
| [复杂任务收尾、制品就绪与策略继承](complex-work10-completion-runtime.md) | 固定100次滚动对照、实际GUI安装；协议链路纠正、2次收尾超时及用量UNKNOWN保留，不将旧41%作为因果基线 |
| [复杂任务并发、共享写入与网络恢复](complex-workflow-concurrency.md) | 通用机制与实际 GUI 安装；100次故障污染矩阵、6次中断补充、20次最终确认分别保留，长尾与用量 UNKNOWN 不隐去 |
| [复杂协作工具链、交接与收尾修复](complex-workflow-repair.md) | 八个已见任务双方各五次，共80次；保留失败、计量UNKNOWN、复算契约待定与共享写入并行限制 |
| [Standard122 权限修复后复验](standard122-permission-rerun.md) | 双模型244题、失败重试5次，与历史DSH/Codex比较；保留失败与用量缺口 |
| [分析子任务权限与本地工具验证](inspection-permissions-v2.md) | 默认只读、显式继承、写租约及 macOS Git/Bash 修复；保留失败与 UNKNOWN |
| [委派准入与并发修复](delegation-admission-repair.md) | 真实 Scope 准入、创建锁和额度竞态的机制回归 |
| [子任务结果消费与收尾续轮](child-result-consumption.md) | 固定版本 Codex/DSH 对照、已见终态去重、迟到结果与压缩边界；确定性请求数回归，不宣称整体提速 |
| [上下文连续性与持久化](context-continuity.md) | 真实多次压缩、修订、重启和 Goal 交付；Chat/Responses 与持久化阶段对照 |
| [内置搜索与历史结果回取](native-result-views.md) | 146 次尝试，最终 18 对常规探针和 3 对 MCP 回取；含成本与耗时退化，未复跑 MM480 |
| [原生工具优化 A/B](tool-optimization.md) | 当前配置模型的 56 次定向尝试，含迭代退化与最终 12 对结果；不代表 MM480 成功率 |
| [五题 Harness 比较](perf-pro-five-report.md) | 保留 23 次尝试的 JSON 与可校验统计；受选题偏差、缺失用量和私有镜像限制 |
| [多 Agent 研究归档说明](multi-agent-history.md) | 研究结论的范围；旧控制器与原始数据不随当前源码提供 |

不把历史加速比当作当前源码、其他模型或平台的承诺。完整原始轨迹未随这些摘要公开时，不声称独立复现已具备全部材料。
