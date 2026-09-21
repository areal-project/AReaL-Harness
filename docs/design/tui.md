**中文** | [English](tui.en.md)

# TUI 结构

TUI 只投影 Core 状态，不拥有模型循环或业务历史。全屏与 `--prompt` 复用协议客户端，`local.rs` 负责可信启动装配。

| 模块 | 职责 |
|---|---|
| `main.rs`, `client.rs` | 终端生命周期、WebSocket、收发队列与重连 |
| `app.rs`, `commands.rs` | RPC 上下文、焦点、订阅预算、Slash 元数据与选择器 |
| `history.rs` | Item 布局缓存、宽字符换行、稳定阅读锚点与视口裁剪 |
| `theme.rs`, `ui.rs` | 主题、颜色降级、响应式布局、任务树和 Workgroup |
| `headless.rs`, `local.rs` | 单 Turn 输出筛选与本地 launcher |

长历史仅布局当前视口及必要缓存；阅读旧内容时新事件不抢滚动位置，返回底部后恢复跟随。展开工具或调整终端宽度使用稳定 Item 锚点。

会话选择、父子树与 Workgroup 状态从 Core 读取；订阅有预算，断线后 resume 替换基线再消费增量，不能拼接缺失事件。模型切换/默认复位仅在空闲边界以配置 revision 提交；主题等本地偏好不进入模型上下文。

操作见[客户端指南](../guides/clients.md)，回归入口见[测试](../development/testing.md)。
