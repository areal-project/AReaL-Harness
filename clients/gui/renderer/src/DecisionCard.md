# 决策组合合同

## DecisionCard

`R-DECISIONCARD-009` [DecisionCard.tsx](DecisionCard.tsx) 展示请求、头部动作、摘要正文、默认折叠详情、Feedback 和页脚。本次准入审批与提问两种上下文。请求草稿与提交仍归调用方。`busy` 宣告传入的等待状态，不会自动禁用任意页脚子项。传入键盘处理函数时，卡片才进入焦点顺序。键盘决策与动作禁用由调用方负责。错误使用 alert 反馈；普通消息与结果未知说明均来自调用方提供的事实。

`R-DECISIONCARD-010` 生产消费者包括 [ApprovalRequest.tsx](ApprovalRequest.tsx) 和 [AskUserQuestion.tsx](AskUserQuestion.tsx)。回调成功不等于权威执行已经完成。

## ApprovalRequest

`R-DECISIONCARD-011` [ApprovalRequest.tsx](ApprovalRequest.tsx) 由 [TaskRunConversations.tsx](TaskRunConversations.tsx) 挂载，负责当前请求的本地提交锁。可操作请求允许拒绝或仅允许一次。只有有效权限允许时，才展示可记住的授权范围。处理中、提交已受理与结果未知均锁定响应动作。收到回执后仍明确等待执行状态更新。明确失败可以重试；结果未知时提供原有 manage/interactions 核对动作，不自动重复提交响应。

`R-DECISIONCARD-012` Tab 可到达可用动作；Enter 与 Space 沿用 Button 语义。Escape 仅在未锁定卡片内部触发拒绝，并尊重已经处理的事件。未知结果核对是独立动作。请求移除与执行进展仍以 Core 投影为准。
