**中文** | [English](history-restart-map.en.md)

# 历史阅读、切会话与重启恢复功能地图

本表记录 Wave 1 第 2 域（历史阅读、会话切换、断线/重启恢复）的用户视角产品规则与验证绑定，不复制测试命令或源码路径。机器选检与执行契约由 [journey manifest](../../clients/gui/scripts/journey-manifest.json) 唯一持有；方法论见[系统化验证设计](verification-system.md)。

> 编写铁律：**预期产品规则列只写纯用户视角的行为承诺，不出现内部错误码、进程名或实现词**；工程线索仅记录在现状列供排查。

| 规则 ID 与用户目标 | 预期产品规则（PM 意图） | 现状与工程线索 | 权威结果 & 可见结果 | 绑定锚点与覆盖边界 | PM 裁决 |
|---|---|---|---|---|---|
| **`FM-HIST-01`**<br>刷新页面或关闭重开应用后查看原对话<br>（Web / Desktop / Mobile） | 刷新或重开后，原有项目、历史消息与最后一条回复仍在，不会退回空页或丢失已完成的对话。 | `web-journeys`（W3 刷新）与 `service-reopen-smoke` 已覆盖，但 `unknown-receipt-recovery` 尚未接入逐事实 `evidenceCheck`。 | **权威**：Core 持久存储保留原 Thread 与已结算 Turn。<br>**可见**：重开后展示同一会话历史与已完成回复。 | 关联 `unknown-receipt-recovery`（`service-reopen` / `web-journeys`）。<br>Mobile 与正式包未执行。 | 待拍板 |
| **`FM-HIST-02`**<br>在不同会话或项目之间切换再切回<br>（Web / Desktop / Mobile） | 切走再切回原会话时，不会串入别的会话内容，未发送草稿不丢失，阅读位置保持稳定。 | `history-navigation-ui-smoke` 与 `conversation-reading-ui-smoke` 已在浏览器夹具上验证导航、草稿与锚点。 | **权威**：读取请求绑定原项目/会话身份，不接受过期切换回包。<br>**可见**：切换回来后内容、草稿与阅读位置一致。 | 关联 `test:history-navigation-ui` / `test:conversation-reading`。 | 待拍板 |
| **`FM-HIST-03`**<br>在长对话中向上滚动加载更早历史<br>（Web / Desktop） | 向上滚动能平滑补齐更早轮次，消息顺序不乱、不重复渲染，插入旧消息时当前阅读段落不跳屏。 | `bounded-history-ui-smoke` 验证按需分页与 ≤2px 位置偏移；`large-history-smoke` 验证 140 次操作与大历史重启。 | **权威**：按原游标分页加载完整历史，不丢页不重页。<br>**可见**：旧消息插在上方且阅读位置偏移 ≤2px。 | 关联 `test:history-recovery` / `test:conversation-reading`。 | 待拍板 |
| **`FM-HIST-04`**<br>发消息时连接中断或响应丢失，重连/刷新后继续<br>（Web / Desktop / Mobile） | 即使发送瞬间断线，恢复后系统只核对那一次发送的结果，**绝不偷偷重发一条重复消息**，草稿按真实结果结算。 | `web-journeys`（W2b）与 `connection-recovery`（`unknownNotReplayed`）已实测覆盖；`unknown-receipt-recovery` 尚未统一接入 `evidenceCheck`。 | **权威**：仅查询原请求回执，Core 中无重复 Turn。<br>**可见**：原消息与评论仅出现一次，草稿状态与事实一致。 | 已在 `connection-recovery` 锁入 `unknownNotReplayed`；待在 `unknown-receipt-recovery` 统一 `evidenceCheck`。 | 待拍板 |
| **`FM-HIST-05`**<br>打开较旧格式的历史会话并继续新轮次<br>（Desktop / Web） | 打开历史留存的旧格式会话能正常浏览过往内容，不额外乱发请求，并可继续输入发新消息。 | `history-copy-smoke`（`test:history-compat`）已验证旧格式分页、已结算子会话与零模型请求。 | **权威**：只读读取不改写来源哈希，零多余模型请求。<br>**可见**：旧会话顺序与关系正确呈现并可继续交互。 | 关联 `unknown-receipt-recovery`（`smoke:test:history-compat`）。 | 待拍板 |

## 防漂移原则

代码行为与本表不一致时，按三类处理：**文档漂移**（产品规则有意变更，经 PM 确认后更新本表）、**验证缺口**（本表已定但未覆盖，补 `factId` 与断言）、**产品回归**（代码偏离既定规则，先留红灯再修代码，严禁反改本表掩盖回归）。
