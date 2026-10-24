# 决策组合合同

## DecisionCard

[DecisionCard.tsx](DecisionCard.tsx) 展示请求、头部动作、摘要正文、默认折叠详情、Feedback 和页脚。本次准入审批与提问两种上下文。请求草稿与提交仍归调用方。`busy` 宣告传入的等待状态，不会自动禁用任意页脚子项。传入键盘处理函数时，卡片才进入焦点顺序。键盘决策与动作禁用由调用方负责。错误使用 alert 反馈；普通消息与结果未知说明均来自调用方提供的事实。

生产消费者包括 [ApprovalRequest.tsx](ApprovalRequest.tsx) 和 [AskUserQuestion.tsx](AskUserQuestion.tsx)。回调成功不等于权威执行已经完成。

## ApprovalRequest

[ApprovalRequest.tsx](ApprovalRequest.tsx) 由 [TaskRunConversations.tsx](TaskRunConversations.tsx) 挂载，负责当前请求的本地提交锁。可操作请求允许拒绝或仅允许一次。只有有效权限允许时，才展示可记住的授权范围。处理中、提交已受理与结果未知均锁定响应动作。收到回执后仍明确等待执行状态更新。明确失败可以重试；结果未知时提供原有 manage/interactions 核对动作，不自动重复提交响应。

Tab 可到达可用动作；Enter 与 Space 沿用 Button 语义。Escape 仅在未锁定卡片内部触发拒绝，并尊重已经处理的事件。未知结果核对是独立动作。请求移除与执行进展仍以 Core 投影为准。

## 证据与边界

[E-DECISION](../../design-system/base-evidence.md#e-decision) 记录本地决策与长内容检查。列明状态是有限准入范围，不代表真实供应商、全部权限组合或安装包已验收。


## Ask User与过程展示

AskUserQuestion保留业务草稿、问题导航、输入法处理与提交锁，使用包内QuestionCard。单选/数字选择只修改草稿，明确发送才提交；多题回答一次提交。稍后回答与关闭只折叠并保留草稿，原Core请求保持pending。UNKNOWN核对不自动重发。

TurnElapsed使用Core起始时间和终态durationMs，所有语言均为`Working for …`。失败工具记录不进入默认活动行；TurnProgress用一个可展开标识提供原始记录，结果待确认与恢复动作继续沿原所有者展示。
