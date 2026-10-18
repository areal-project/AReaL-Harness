**中文** | [English](multi-agent-history.en.md)

# 多 Agent 研究归档说明

此前研究覆盖 Python 原型、生产 Rust Workgroup、固定并发宽度与 Adaptive。不同执行器、源码版本、任务分解和模型预算分别测量，成绩不能混为当前 Core 的表现。

保留的设计原则是：以单 Agent 为基线，先处理共享写范围与任务依赖，再测真实模型重叠；将验收和修复计入成本；扩大 Worker 上限或启用 Adaptive 不保证更快。当前 CLI 仍以 balanced + fixed、2 Worker 为默认，Adaptive 需显式启用。

旧实验控制器、逐次数据、SQLite 计量和运行回执已从当前源码移除。原有多份实验结果页合并到本说明，不继续发布脱离证据的速度排名或不可运行命令。需要研究历史时从仓库历史寻找对应版本，并另行确认数据可获得性与再分发授权；当前 checkout 不构成这些研究的完整复现包。

当前实现见[Workgroup 设计](../../design/workgroups.md)，可运行回归见[测试](../../development/testing.md)，新评测遵循[方法](../methodology.md)。
