**中文** | [English](conversation-catalog.en.md)

# 会话目录、分页与 GUI 刷新对照

第一轮采用内存轻量目录、游标范围读取和 GUI 刷新合并，暂不接入 SQLite。固定 fixture 的目录查询与请求次数已经改善；这些结果不代表模型、工具、任务成功率或整体 Agent 性能提升。后续稀疏过滤、真实缓存写盘和功能保护的比较见[迭代验证](conversation-catalog-validation.md)。

## 修复与兼容边界

- Engine 维护 UUID 与 `(createdAt,id)` 两个有序索引，只保存会话句柄和不可变排序键。元数据直接从当前状态投影，不先克隆 `turns`、checkpoint 或冷历史清单；名称、配置、权限、归档等旧字段保留。
- `areal/conversation/list` 从游标后按序取候选，不再每页扫描、复制和排序整个目录。权限与业务过滤先于 LIMIT，再看一个匹配项判断 continuation。旧 `thread/list`、`areal/agent/list` 的 UUID 顺序和会话目录的游标编码保持兼容。
- GUI 按项目、连接及代际维持最多一批在途和一批待办；同步突发请求共用待办，在途收到的新通知合并到后续一批。完成的调用方不等待后续通知停止。已加载完整目录时，Turn 等通知只读取受影响会话的 `thread/read(includeTurns:false)`；初次加载、重连与显式刷新仍读完整目录。
- Worktree 绑定判断继续使用完整目录。旧连接或旧代际结果不发布，只有权威 not-found 才移除目标摘要；权限和普通读取错误保留已有投影。
- 文件事实、Store 提交与 fsync 顺序、状态版本、UNKNOWN 处理和模型输入保持原样。没有新增持久化索引、迁移、延迟快照写入或隐式重试。

本轮目录不是一份独立的动态状态缓存：实际检查的候选仍需取得会话锁，稀疏过滤仍可能扫描大量候选。目录锁只覆盖有界句柄读取，在等待会话锁前释放。分页不提供跨页一致快照；并发创建和分类变化沿用当前状态可见性。

## 测量方法与来源

原始样本、源码和二进制 SHA-256、校验尝试见 [JSON](conversation-catalog-results.json)。基线为 `61ce8ecc296a648f41b353da1b304d902711c48a` 的查询实现；工作区包含其他未提交修改，未称为整仓 clean commit 对照。基线三份 Engine/GUI 查询源文件与该提交一致，app-server 仅添加性能测试模块注册。基线 release 测试可执行文件在改动生产实现前冻结，之后复测使用该文件。

环境为 Apple M5 Pro、24 GiB 内存、Darwin arm64、Rust 1.94.0、Node 23.11.0。同机 release 构建，page size 为 100。fixture 先写真实版本的 Thread 文件并用真实 Engine 恢复，查询使用实际 `Connection::conversation_list` 与 JSON 编码；文件准备、启动恢复、WebSocket、界面绘制、模型与工具执行不计时。没有真实模型请求。

单页各预热 2 次、记录 7 次；完整目录记录 5 次，取中位数。初次试跑的旧实现样本单独保留，没有并入主对照。未测并发写入下的尾延迟、跨机器分布或置信区间，因此以下数值只说明本地机制收益，不是线上延迟承诺。

| 场景 | 优化前中位数 | 优化后中位数 |
|---|---:|---:|
| 100 个会话，首屏 | 0.1515 ms | 0.1332 ms |
| 100 个会话，完整目录 | 0.1568 ms | 0.1417 ms |
| 2,000 个会话，各 16 KiB 历史，首屏 | 3.7788 ms | 0.1194 ms |
| 同上，末页 | 3.9202 ms | 0.1382 ms |
| 同上，完整目录 | 75.6039 ms | 3.1749 ms |
| 20,000 个空历史会话，首屏 | 132.1060 ms | 0.1259 ms |
| 同上，末页 | 128.9174 ms | 0.1350 ms |

20,000 个会话的巨大单页差异来自移除每页全目录收集、排序和旧路径的重复遍历，不能外推为整体任务千倍提速。小目录没有出现同量级收益，符合固定工作量减少的解释。

GUI 比较运行真实生产协调器，以 `setImmediate` 模拟异步传输和内存缓存，固定 2,000 行、每页 100、一次突发 20 个请求，每侧各 5 次。下面各次计数相同；计时原样保存在 JSON，因没有真实网络和磁盘，不将其解释为用户等待时间。

| GUI 场景 | 优化前目录 RPC / 摘要缓存写入 | 优化后目录 RPC / 摘要缓存写入 |
|---|---:|---:|
| 20 个同时完整刷新 | 400 / 20 | 20 / 1 |
| 完整目录已加载，同会话 20 个 Turn 通知 | 400 / 20 | 1 / 1 |

后一场景的新请求为目标会话的元数据读取。活动标记、通知和其他 library 写入不在上述摘要缓存计数中，也没有在本轮合并。

## 验证与保留的不利结果

- app-server 全部 lib 测试通过：27 通过、1 个性能用例显式忽略。新增覆盖元数据字段与持久文件字节不变、时间戳并列分页、过滤与授权、游标绑定、无关会话锁、归档和新建、真实 Fork 注册。
- GUI 相关八组测试 120 通过；最终目录测试 13 通过，包含任务草稿过滤。完整 `pnpm --dir clients/gui verify` 通过，测试组分别为 6、208、104 通过，另有 3 个既有跳过。
- 初版目录测试误把 Side 专用恢复 API 用于普通根会话，出现 1 个失败（5 通过、1 忽略）。修正测试以核对既有归档与新建行为，没有放宽生产契约；失败记录保留在 JSON。
- 首次 Engine 全集在一项 HTTP 审计测试上停滞，其他 279 项通过、4 项忽略；本机代理接管了 loopback 请求。终止本次测试进程后，同一审计测试设置 `NO_PROXY=127.0.0.1,localhost` 单独通过。隔离代理后的完整复验为 Engine lib 280 通过、4 忽略，另四组集成测试共 22 通过。
- Rust 格式、GUI 新测试与性能脚本的 Prettier、文档语言配对和链接、diff 空白检查通过。首次 Clippy 发现新文件的测试模块没有置于末尾，移动模块后 `--all-targets -- -D warnings` 通过；生产逻辑不变。

这些检查属于查询正确性、兼容性和局部性能验证，不涉及 Agent 默认策略、预算或能力晋级。没有执行原生 GUI 人工视觉验收、安装包验收或整体 Agent benchmark；本轮没有修改页面、样式或交互控件。

## 复现

从仓库根运行：

```sh
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
  cargo test --locked --release -p areal-engine --lib \
  --test conversation_references --test session_name \
  --test admission_guards --test recovery_contract
cargo test --locked --release -p areal-app-server --lib
pnpm --dir clients/gui verify
AREAL_CATALOG_PERF_PHASE=after cargo test --locked --release \
  -p areal-app-server --lib catalog_performance_comparison -- --ignored --nocapture
AREAL_CATALOG_PERF_PHASE=after node clients/gui/scripts/catalog-refresh-benchmark.cjs
```

重建旧查询路径时，在独立 checkout 使用上述基线提交，复制此版本的 `core/app-server/src/catalog_tests.rs` 并在 app-server `lib.rs` 注册 `#[cfg(test)] mod catalog_tests;`，仅运行性能用例并冻结其可执行文件。完整行为测试用来验证修复，不要求旧实现通过。GUI 脚本接受旧版 `history-observation.cjs` 路径，依赖仍从生产模块原路径解析，不需要覆盖工作区。

## SQLite 决策

当前先保留本轮修复：它直接移除了已证实的重复工作，没有引入文件与数据库双写、索引重建和失效管理。这是目前证据支持的优先步骤，不能证明是所有负载下的最佳架构。

仍未解决的问题包括启动恢复时读取全部记录、热会话内存、稀疏筛选、候选会话锁等待，以及真实 GUI 的完整目录初始化。新增索引本身也有 O(N) 的键和引用开销，未量化内存或启动收益。若真实规模下启动或内存成为主瓶颈，出现全文检索需求，或并发写入下的查询 p95 持续超过产品预算，再比较可重建的 SQLite 元数据索引。单纯引入 SQLite 不会自动优化快照序列化、fsync 或 Runtime 工具文件操作；那些路径需要各自的证据与持久化语义设计。
