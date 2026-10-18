**中文** | [English](GLOSSARY.en.md)

# AReaL Harness 产品术语

本文定义 AReaL Harness 各用户入口的共同语言，不表示规划中的入口已经实现。

## Language

**定时安排（Schedule）**：
用户预先指定发起某项工作的时间安排，可以执行一次或重复执行。
_Avoid_：前台或后台执行方式；一次已经开始的执行；会话本身

**定时执行（Scheduled Run）**：
由定时安排发起的一次工作及其执行结果。同一安排的各次执行可以分别查看。
_Avoid_：定时安排本身；一次模型调用

**AReaL 客户端（Client）**：
用户访问 AReaL Harness 会话和执行能力的交互入口；桌面端、移动端、TUI 与 CLI 属于同一层级。
_Avoid_：将客户端等同于执行引擎，或将移动端视为桌面端的下级产品

**桌面端（GUI）**：
用户在电脑上使用的完整 AReaL 图形应用，包含交互界面及其所需的桌面能力。
_Avoid_：仅将界面组件或页面源码称为完整桌面端

**共享浏览器（Shared Browser）**：
用户与 Agent 围绕同一组真实网页交替操作、观察和交流的环境。
_Avoid_：独立自动化浏览器；相同 URL 的另一页面

**浏览工作区（Browser Workspace）**：
属于一个 Thread 的一组 Browser Page 及其浏览上下文，是一次共享浏览任务的资源边界。
_Avoid_：代码 Workspace；AReaL Task；ego Task Space 的直接别名

**浏览页面（Browser Page）**：
共享浏览器内可被认领、观察和交付的单个真实网页。标签是它的界面呈现，不是另一个页面。
_Avoid_：当前活动 Tab；URL 作为身份

**页面来源（Page Origin）**：
页面最初由人、Agent 或未知来源创建的归属线索，与网页的网络 Origin 不同。
_Avoid_：把创建者等同于当前控制者；混同站点 Origin

**浏览器宿主（Browser Host）**：
向 Core 提供受控浏览器能力的可信桌面宿主。
_Avoid_：网页脚本；第二套 Agent Harness

**浏览器控制器（Browser Controller）**：
拥有真实 Browser Page 与控制切换规则的原生资源所有者。
_Avoid_：React Store；会话历史所有者

**认领（Claim）**：
在既定授权下把一个已有人工页面纳入当前 Thread 的 Agent 可控范围。
_Avoid_：复制页面；自动读取所有用户标签

**人工接管（Human Takeover）**：
用户取得 Browser Workspace 的交互权并暂停 Agent 对它的输入与观察。
_Avoid_：只停止点击；暂停整个 Core 服务

**交还控制（Resume Control）**：
用户明确允许 Agent 在重新观察后继续使用当前浏览工作区。
_Avoid_：自动重试；恢复旧坐标

**控制代次（Control Epoch）**：
标识一次连续浏览控制授权的版本；换手后的动作必须属于新的代次。
_Avoid_：连接代次；页面加载次数

**页面观察（Browser Observation）**：
Agent 在已知 Page、文档和视口条件下获得的一次语义或视觉证据。
_Avoid_：网页指令；永久页面真相

**元素引用（Element Ref）**：
由一次有效观察提供、指向特定文档中元素身份的短引用。
_Avoid_：随意猜的 selector；永久 DOM ID

**动作计划（Prepared Action）**：
宿主基于真实页面准备、可供 Core 审批并核对的具体浏览动作。
_Avoid_：模型自然语言意图；可无限重用的授权

**动作回执（Action Receipt）**：
记录一次浏览动作是否未派发、已完成或结果无法确认的执行事实。
_Avoid_：业务验收通过；网页可以回滚

**页面批注（Browser Annotation）**：
用户附着于页面元素或捕获区域的反馈，含其证据来源。
_Avoid_：Agent 工具授权；代码补丁

**样式试改（Style Preview）**：
供用户比较和撤销的临时页面外观或文字变化，不代表源代码修改。
_Avoid_：已保存代码；永久网站改动

**浏览器证据（Browser Evidence）**：
与 Thread 及相关操作关联、可回取核对的页面观察与验证材料。
_Avoid_：实时页面本身；公开分享链接

**浏览器验证（Browser Verification）**：
把明确检查与浏览器证据结合，对交付行为或视觉结果作出的判断。
_Avoid_：点击成功；模型自称完成

**临时浏览上下文（Transient Browser Context）**：
本次 Browser Workspace 生命周期内使用的 Cookie 与站点存储容器。
_Avoid_：持久 Profile；OS 沙箱

**浏览器档案（Browser Profile）**：
可跨浏览工作区或桌面重启保留浏览身份与登录状态的用户档案。
_Avoid_：Agent Profile；临时上下文

**主会话（Main Conversation）**：
用户用于推进主要任务的连续对话。由 Fork 产生的会话也是一条主会话。
_Avoid_：把所有聊天面板都称为主任务，把主会话等同于仍在运行的任务

**轮次（Turn）**：
一次被受理的用户输入及其引发的连续处理过程，包括回复、工具交互和终结状态。同一轮可以包含多条消息。
_Avoid_：消息、一次模型调用、屏幕中的消息序号

**来源会话（Source Conversation）**：
新分支或旁路讨论所依据的原对话。来源关系表达内容出处，不表达任务委派。
_Avoid_：父 Agent、负责等待子任务的调度者

**来源关系（Conversation Origin）**：
派生会话与其来源及所选位置之间的可追溯联系。
_Avoid_：委派关系、权限继承关系

**分支操作（Fork）**：
以来源对话的某个轮次边界为起点，创建另一条独立主会话的操作。
_Avoid_：撤销、文件回滚、重放工具、复制当前屏幕

**轮次之前（Before Turn）**：
紧接目标轮次开始之前的位置；所选轮次的输入及之后内容不属于继承范围。
_Avoid_：重新执行该轮、包含该轮用户问题但不包含回答

**轮次之后（After Turn）**：
目标轮次结束之后的位置；所选轮次及之前的对话属于继承范围。
_Avoid_：当前流式输出末尾、下一条回复之前的任意位置

**旁路讨论（Side Chat）**：
用户围绕主会话内容开展的独立辅助对话，用于理解、审查和讨论，不承担主任务的执行指挥权。
_Avoid_：子 Agent、主会话的消息队列、第二个可写执行者

**来源锚点（Source Anchor）**：
派生会话采用的来源对话位置，明确它的历史依据截止在哪里。
_Avoid_：当前最新内容、UI 列表下标

**观察快照（Observation Snapshot）**：
在某一确定时刻保留下来的对话证据视图；后续来源变化不改变这一视图。
_Avoid_：文件系统快照、正在变化的实时状态

**继承历史（Inherited History）**：
Fork 用于继续对话的既有历史前缀。它描述之前已经发生的事情，不表示新会话重新完成了那些工作。
_Avoid_：新执行记录、新采样、新工具结果

**引用证据（Reference Evidence）**：
旁路讨论用于理解问题的来源内容及可核对出处。
_Avoid_：待执行命令、当前权限、实时文件版本

**当前工作区（Current Workspace）**：
用户此刻实际使用的项目文件环境。它与对话历史中的文件观察属于不同时间视图。
_Avoid_：分支锚点时的文件版本、自动隔离的工作区

**回填草稿（Bring-back Draft）**：
用户选择将旁路结论放入来源会话待发送内容的操作。
_Avoid_：自动发送、自动引导、自动合并分支

**归档会话（Archived Conversation）**：
从日常工作视图中收起、但内容仍保留并可恢复的对话。
_Avoid_：删除、清除所有副本、终止正在执行的任务

**委派子任务（Delegated Agent Task）**：
主执行者交给另一个 Agent 的工作，具有任务协调与生命周期约束。
_Avoid_：用户自行发起的 Side Chat、Fork
