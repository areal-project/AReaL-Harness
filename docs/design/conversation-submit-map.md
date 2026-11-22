**中文** | [English](conversation-submit-map.en.md)

# 主对话发送与多轮引导功能地图

本表记录 `conversation-submit` 动线的用户视角产品规则与验证绑定，不复制测试命令或源码路径。机器选检与执行契约由 [journey manifest](../../clients/gui/scripts/journey-manifest.json) 唯一持有；方法论见[系统化验证设计](verification-system.md)。

> 编写铁律：**预期产品规则列只写纯用户视角的行为承诺，不出现内部错误码、进程名或实现词**；工程故障线索仅记录在现状列供排查。

| 规则 ID 与用户目标 | 预期产品规则（PM 意图） | 现状与工程线索 | 权威结果 & 可见结果 | 绑定 `factId` 与覆盖边界 | PM 裁决 |
|---|---|---|---|---|---|
| **`FM-CHAT-01`**<br>打开冷项目后，输入框首次可发送时按 Enter<br>（Web / Desktop / Mobile） | 只要输入框进入可发送态，直接按 Enter 就能把首条消息发出去并收到回复——不报错、不卡住、不需要再点重试。 | 已在 `web-journeys` 接入不经只读调度探测绕过的冷启动首条验收并实跑通过；历史冷启动曾暴露过就绪竞态，需持续守护。 | **权威**：首个 `session.create` 一次受理并结算唯一 Core Turn。<br>**可见**：消息进入对话流并展示回复，零原始错误与页面异常。 | 已锁入 `conversation-submit`：`coldStartFirstSend`、`requestAccepted`、`turnSettled`、`visibleResult`。<br>Mobile 与正式安装包未执行。 | 已拍板 · 锁入验证 |
| **`FM-CHAT-02`**<br>Composer 附带文件、图片或审查评论后发送<br>（Web / Desktop） | 添加的附件或评论随消息一起送出，发送后草稿清空，对话中可回看已发送的附件或评论内容。 | 审查评论已锁入 `web-journeys` 逐事实契约；文件与图片附件由 `composer-smoke` / `composer-folder-vision` 覆盖。 | **权威**：Core 收到对应附件/结构化载荷且不丢不重。<br>**可见**：草稿结算，消息区可展开查看已发送内容。 | 已锁入 `conversation-submit`：`attachmentSubmitted`（审查评论）；文件/图片附件由 `composer-smoke` 覆盖。 | 已拍板 · 锁入验证 |
| **`FM-CHAT-03`**<br>第 1 条运行或等待审批时，继续输入并发送第 2 条引导消息<br>（Web / Desktop / Mobile） | 运行或等审批时输入框保持可用，发出的第 2 条进入排队不丢不覆写；等待审批时界面绝不显示“运行中”。 | 已锁入 `web-journeys` 逐事实契约，核对审批态诚实度、排队反馈及权威 Core 独立第 2 条 Turn 结算。 | **权威**：第 1 条结算后按序受理第 2 条独立 Turn。<br>**可见**：排队条出现，审批态文案诚实，两条回复均可见。 | 已锁入 `conversation-submit`：`queuedFollowUp`。<br>Mobile 与正式安装包未执行。 | 已拍板 · 锁入验证 |
| **`FM-CHAT-04`**<br>中途切换模型后发送下一条引导消息<br>（Web / Desktop / Mobile） | 切换模型后发出的下一条消息立即按新模型执行，且不破坏前序轮次的历史展示与草稿。 | 模型选择专项由 `model-selection-smoke` 覆盖；对话中途切模型后再发消息尚未纳入 `conversation-submit` 逐事实报告。 | **权威**：下一条出站求解请求命中新选模型与档位。<br>**可见**：模型选择器显示新模型，前序轮次保持完整。 | 待绑定 `modelSwitchNextTurn`（与 `model-selection-smoke` 对齐）。 | 已拍板 · 待接入 factId |
| **`FM-CHAT-05`**<br>消息生成中触发停止/取消，随后继续发新消息<br>（Web / Desktop / Mobile） | 点击停止或按 Esc 后当前生成及时停下，不会一直转圈；随后继续发新消息能正常完成。 | 取消路径由 `stop-turn-smoke` 覆盖；尚未与 `conversation-submit` 共享同一逐事实证据摘要。 | **权威**：原 Turn 结算为取消/终止态，无残留孤儿执行。<br>**可见**：停止态明确，输入框可立即继续提交新轮次。 | 待绑定 `cancelAndContinue`（已有 `stop-turn-smoke` 覆盖）。 | 已拍板 · 待接入 factId |

## 防漂移原则

代码行为与本表不一致时，按三类处理：**文档漂移**（产品规则有意变更，经 PM 确认后更新本表）、**验证缺口**（本表已定但未覆盖，补 `factId` 与断言）、**产品回归**（代码偏离既定规则，先留红灯再修代码，严禁反改本表掩盖回归）。
