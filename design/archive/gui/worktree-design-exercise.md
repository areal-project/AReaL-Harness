# 冻结研究与固定题目记录

固定 Worktree 设计题输入与代表条件，配合既有 exercises/worktrees.md 运行记录复现；当前组件规则仍在各就近合同。

## 固定样例与后续验收

<!-- rule:R-WORKTREE-039 -->
页面合同拆为[配置选择](../../../clients/gui/design-system/surfaces/worktree-picker.json)、[准备过程](../../../clients/gui/design-system/surfaces/worktree-preparation.json)、[设置管理](../../../clients/gui/design-system/surfaces/worktree-settings.json)。它们引用已有模式及控件，分别登记代表截图的对照状态与未覆盖范围；不把部分截图提升为所有状态通过。

| 题目 | 固定输入 / 操作 | 视觉与交互通过条件 |
| --- | --- | --- |
| 菜单关闭 / 开启 | 一个 Git 项目，长项目名，开关两态 | 上下文条与齿轮位置稳定；三行结构，值右对齐；无纵向表单或常驻长说明 |
| 分支搜索 | 当前分支、远端分支、30 个本地分支、长名称、dirty 来源、无匹配 | 同一锚点子页；搜索 / 返回不滚走；单选可辨；dirty 不伪装成可复制来源 |
| <!-- rule:R-WORKTREE-040 --> 环境配置往返 | 无环境 → 配置 → 新建两个环境 → 保存返回选择 | 项目归属不丢；Prompt / 附件 / 分支保留；不会自动创建或发送 |
| <!-- rule:R-WORKTREE-041 --> 创建详情 | Prompt 提交，分阶段投影，展开日志，再追加输出 | Prompt 只一份；阶段真实；控制同排；人工展开保留；日志有界且可复制 |
| <!-- rule:R-WORKTREE-042 --> 已创建 / Setup / ready | checkout 已确认，随后 Setup 仍运行，再就绪 | 已创建不等于可发送；最终收敛成一行，普通 Composer 与工作区标识可见 |
| <!-- rule:R-WORKTREE-043 --> 取消与异常 | 取消中、确认取消、明确失败、UNKNOWN；分别尝试不用 Worktree | 状态与合法动作逐项准确；不提前报终止或静默回退；收起仍可发现异常 |
| 侧栏身份 | 普通会话、准备会话、已绑定会话、长标题、未读与运行态 | 标题仍是主内容，无 UUID 第二行；尾部图标不碰撞，可访问名称完整 |
| <!-- rule:R-WORKTREE-044 --> General 与目录 | 默认根、自定义根、三个项目、长路径、空列表、活动/脏目录拒删 | 单一设置组与紧凑目录；高级项不挤主组；拒删保留行及真实原因 |
| <!-- rule:R-WORKTREE-045 --> 环境编辑 | Setup macOS、Cleanup Linux、Action Default 各自有未保存文本 | 独立平台切换不串改；编辑为独立页；保存不执行脚本；返回有保护 |
| Action | 零项、三项、长命令、运行/失败/未知 | 空态安静，列表可识别；设置只配置；会话入口沿真实状态显示结果 |
| 边界组合 | 明暗主题，UI 字号 14 / 18，宽 / 窄，键盘与 reduced motion | 不靠缩字体通过；当前值、返回、取消、保存和删除均可达；无页面横向溢出 |

<!-- rule:R-WORKTREE-046 -->
逐状态对照 WT-R01～09 时保留 AReaL 品牌与安全语义差异；截图缺失状态按本稿目标验证并明确标注。当前 [renderer 与 Electron 验收范围](exercises/worktrees.md)分别报告视觉、交互和真实 Core 路径；尚未验收安装包、物理输入或 Linux 实机，不声明逐像素一致。
