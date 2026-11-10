# 身份与所有权

`R-IDENTITY-001` AReaL Harness 中，用户需要区分正在看的会话、承担工作的 Agent，以及允许操作的身份。名称和头像帮助识别对象，不能证明权限或执行归属。

## 会话身份与执行职责

`R-IDENTITY-003` 创建成功表示对象已受理，运行状态另行读取。Task 的创建者记录也不代表私有邮箱权限。可见性由当前身份的授权决定，详见 [Task 所有权](../../docs/api/tasks.md#所有权与模式)。

`R-IDENTITY-004` 用户看到的 Agent 名称与头像保持稳定，并能回到其实际会话。状态来自该会话的权威观察。缺少观察时显示待确认，不从头像、创建文案或最后一条回复猜测。

## 三种关系分别表达

Side Chat 是基于来源快照的独立只读讨论。来源关系不赋予执行权限，也不表示来源停止后 Side 同步停止。讨论的访问权限按自身会话检查。

## 身份不是授权

`R-IDENTITY-007` 显示名、Thread 标识和选中的项目不能替代认证。界面只展示当前身份可访问的对象。切换对象后，操作必须仍指向用户正在处理的归属。

权限选择与审批含义归 [控制与审批](control-and-approval.md)。委派的生命周期归 [委派与交接](delegation-and-handoff.md)。

## 契约与 GUI 绑定

[桌面 API](../../docs/api/desktop.md) 维护认证、普通会话、Fork 和 Side 的关系。[Task API](../../docs/api/tasks.md) 维护 Task、Run、Goal 与 Thread 的职责。

[AgentIdentity.tsx](../../clients/gui/renderer/src/AgentIdentity.tsx) 绑定稳定头像和观察状态，当前只识别受支持的标准创建回执。[AgentConversationPane.tsx](../../clients/gui/renderer/src/AgentConversationPane.tsx) 校验父子关系后展示子对话。不能据此声称所有委派后端已有相同 GUI 呈现。
