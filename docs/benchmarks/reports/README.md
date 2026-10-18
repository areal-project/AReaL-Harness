**中文** | [English](README.en.md)

# 历史报告

历史记录不定义当前能力。新测试使用[运行指南](../README.md)，统计约束见[方法](../methodology.md)。

| 报告 | 证据范围 |
|---|---|
| [上下文连续性与持久化](context-continuity.md) | 真实多次压缩、修订、重启和 Goal 交付；Chat/Responses 与持久化阶段对照 |
| [内置搜索与历史结果回取](native-result-views.md) | 146 次尝试，最终 18 对常规探针和 3 对 MCP 回取；含成本与耗时退化，未复跑 MM480 |
| [原生工具优化 A/B](tool-optimization.md) | 当前配置模型的 56 次定向尝试，含迭代退化与最终 12 对结果；不代表 MM480 成功率 |
| [五题 Harness 比较](perf-pro-five-report.md) | 保留 23 次尝试的 JSON 与可校验统计；受选题偏差、缺失用量和私有镜像限制 |
| [多 Agent 研究归档说明](multi-agent-history.md) | 研究结论的范围；旧控制器与原始数据不随当前源码提供 |

不把历史加速比当作当前源码、其他模型或平台的承诺。完整原始轨迹未随这些摘要公开时，不声称独立复现已具备全部材料。
