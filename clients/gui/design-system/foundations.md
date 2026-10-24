# GUI 基础规则

## 视觉语言

共同的内容层级、表面、资产、动效和可达性由[设计基础](../../../design/foundations/README.md)维护。本文件记录 GUI 的 Token 接线与布局约束。高密度桌面工作台保留现有导航、主内容和辅助面板所有者。

## Token 按用途选择

完整 Token 角色表见 [DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md#token-选择)。本页不维护另一份数值表。

| 决策 | 必须采用的来源与约束 |
| --- | --- |
| 颜色 | @areal/ui 生成的语义变量（[tokens.json](../packages/ui/tokens.json) + theme.ts）及 `styles.css` 的产品别名；主文字、次文字、页面、输入、边界、危险各按角色取值；禁止在新消费者写裸颜色或复制参考截图色值 |
| 字体 | UI 使用生产 `--font-sans`、`--text-ui-*`、`--ui-font-weight` 与公共行高；普通任务标题、项目标签和对话正文使用常规字重，强调内容沿用已有标题与强调角色；代码使用 `--font-mono`。排印方向见[文字与空间密度](../../../design/foundations/roles.md#文字与空间密度)，不引入新字体或任意字号修补页面 |
| 字号偏好 | 尊重 `applicationSettings.ts` / `applicationPreferences.ts`；检查字号变化后的行高、换行、操作可达性，不用缩小文字解决溢出 |
| 间距与密度 | 优先 `--spacing-inline/field/section/panel` 及既有组合；同行控件、同类设置使用相同密度。空间不足时重排，不逐页压缩 padding |
| 控件与形状 | 选组件已提供的 size / variant；圆角按 control、button、overlay、composer、panel、dialog 等表面角色取值；胶囊形仅用于已有对应动作 |
| 图标 | 图形与尺寸变体归现有 interfaceIcons 及相关组件；名称与提示遵循[共享资产规则](../../../design/foundations/README.md#图标与资产) |
| 动效 | 使用公共 motion / focus 与 reduced motion 接线；信息表达遵循[共享可达性规则](../../../design/foundations/README.md#状态动效与可达性) |

数值传递方向是生产基础/主题 → 语义角色 → 公共控件 → 页面组合。组件局部几何留在组件；有实际跨消费者需求才提升为公共角色。现有主题 alias 与用户覆盖不能因名称相近而删除。活跃设置说明使用 `--color-settings-secondary`；禁用状态和已完成过程信息各用原所有者，不能因颜色接近合并。默认参考与用户对比度映射分开验收，不将截图色值写进消费者。

## 布局约束

- 工作台沿用当前导航、主内容与辅助面板所有者；新增功能进入已有区域，不再嵌一层侧栏、标签栏或固定定位的全局操作。
- 设置按功能分区；相同行的标签起点、控件右边缘一致。宽度不足时控件落到说明下方，长名称自然换行；同组统一重排。
- 页面仅保留一个主纵向滚动拥有者；代码、日志、文件阅读器等独立工作区可有有界滚动。弹层尺寸由公共组件约束，动作可达；不能截掉内容来消除滚动条。
- 区分可见图形、布局占位和命中区域。纯图标不能只凭图形大小判断可点击面积；也不能把触屏尺寸机械套到所有桌面行导致密度变化。
- 截图测量记录窗口、viewport、DPR、主题、字号、字体就绪与具体变体。同一个按钮在浮层与工具栏里不一定是同一 size；未确认的尺寸不得升级成全局默认。

## 可访问与内容

共同要求见[设计基础](../../../design/foundations/README.md#状态动效与可达性)、[反馈与恢复](../../../design/patterns/feedback-and-recovery.md)及[控制与审批](../../../design/people-and-agents/control-and-approval.md)。GUI 由原生或公共控件提供标签、键盘和焦点，具体字段反馈、详情入口与权限动作由原业务组件接线。
