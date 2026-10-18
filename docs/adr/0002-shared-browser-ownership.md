**中文** | [English](0002-shared-browser-ownership.en.md)

# 由既有桌面 ToolHost 提供共享浏览器

**状态：proposed（设计提案，尚未实施）**

现有 Core 独占历史，桌面原生页面归 Main。共享浏览器采用 Core 动态工具回调，经独立桌面适配器转发至同一原生页面；Core 不依赖 Electron，Main 不运行 Agent Loop。选择复用现有连接和单写历史，代价是 GUI 原生资源消失时 Browser 不能继续运行，尽管独立 Core 仍存活。

## 考虑的方案

直接将浏览器放入 Runtime 会扩大 OS 执行协议与原生 UI 耦合；另起 agent-browser/ego-lite App 会分裂用户当前页面。两者保留为未来不同 Provider 的独立需求，不作为本次默认。

## 后果

执行结果必须标为 client 后端。适配器存活不证明 Main 页面可用。ToolHost 路由归属和普通观察订阅必须分开；关闭 GUI 不得关闭无关 Core 任务。

关联：[规格](../design/browser.md)、[契约](../api/browser.md)。
