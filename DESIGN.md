---
name: AReaL Harness
description: 安静的工程工作台
colors:
  primary: "#1a1c1f"
  primary-foreground: "#ffffff"
  background: "#ffffff"
  brand: "#3a83f7"
  dark-background: "#181818"
  dark-foreground: "#ffffff"
typography:
  body:
    fontFamily: '-apple-system, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Noto Sans CJK SC", sans-serif'
    fontSize: "var(--text-ui-base)"
    fontWeight: 400
  title:
    fontSize: "var(--text-page-title)"
  label:
    fontSize: "var(--text-ui-caption)"
rounded:
  button: "8px"
  control: "10px"
  panel: "12px"
  dialog: "16px"
  composer: "18px"
  overlay: "20px"
spacing:
  inline: "8px"
  field: "16px"
  section: "24px"
  panel: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.button}"
    height: "var(--spacing-control)"
  input:
    rounded: "{rounded.control}"
    height: "var(--spacing-control)"
---

# Design System: AReaL Harness

## Overview

**Creative North Star: "安静的工程工作台"**

界面为持续工作提供稳定、清晰的秩序，让任务内容和执行事实占据注意力。导航、输入与辅助面板保持紧凑一致；通过留白、表面色差和必要的浮层阴影表达关系，避免装饰干扰阅读。

控件精确、克制、紧凑。普通内容保持常规字重，选中、悬停和键盘焦点各自清楚表达。Codex App 是已确认的桌面视觉与交互参考，品牌与资产沿用本项目。

**Key Characteristics:**
- 中性色主导，强调色承担链接与焦点角色。
- 系统字体、常规字重，操作字号与阅读字号分别响应偏好。
- 导航、主内容、辅助面板分工明确；以内容关系组织密度。
- 表面色差与留白分组，阴影表达浮层结构。

本文件是现有设计系统的便携摘要。frontmatter 是默认主题的提取快照，供设计工具读取；生产值仍只在 [tokens.json](clients/gui/packages/ui/tokens.json) 修改，并通过既有生成器更新。实现优先使用语义变量和现有组件，不能从本文件复制字面量建立第二套主题。规则所有者见[设计地图](design/README.md)与[GUI 设计入口](clients/gui/design-system/README.md)。本次记录依据源码和已确认描述，未进行新的渲染或交互验收。

本地 `.impeccable/design.json` 提供设计面板的组件视觉摘录，依赖宿主加载生产 CSS 变量，不替代 React 组件及其行为合同。其色阶为面板展示插值，不是新增的生产调色板；本次未验证面板渲染。

## Colors

默认配色以纸白、石墨和焦点蓝描述；这些名称辅助理解，不替换生产 Token 名称。暗色主题及用户调色板由同一语义角色映射。

### Primary

石墨对应默认正文与中性主动作，主动作配对使用 `--color-primary` 和 `--color-primary-foreground`。焦点蓝对应 `--color-brand`，用于链接与键盘焦点；它不是默认主按钮的填充色。

### Neutral

纸白是默认阅读表面。页面、导航、输入、卡片与浮层按自己的语义角色取值；即使当前颜色相同，也保留各自用途。暗色表面与文字见 frontmatter 的暗色快照，完整派生值见[生成主题](clients/gui/packages/ui/src/generated/themes.css)。

成功、警告、错误、待确认与已结算采用已有状态角色，并同时提供文字或图标。设置说明、禁用状态与已结算元信息不能相互借用颜色。

## Typography

系统无衬线承担界面与默认正文；代码、路径和标识使用 `--font-mono`，完整字体回退见[Token 速查](clients/gui/packages/ui/src/generated/tokens.md)。不宣称识别或复刻 Codex 的专有字体。

页面标题使用 `--text-page-title`，区块标题使用 `--text-ui-xl`，正文使用 `--text-ui-base`，按钮与紧凑标签使用 `--text-ui-caption`。对话正文、活动行、子代理与过程状态共用 `--text-conversation`、`--conversation-line`、`--conversation-gap`，层级通过颜色与图标表达。

基础界面字号与当前应用默认内容字号均为 14px，实际值随用户设置变化；[表达角色说明](design/foundations/roles.md)仍描述 12px 默认值，与当前源码存在差异。本记录以 [applicationSettings.ts](clients/gui/renderer/src/settings/applicationSettings.ts) 和生产 Token 为现状依据，未调整该既有差异。普通任务标题和正文使用常规字重，强调遵循所属组件合同。

## Layout

工作台保留导航、主内容与辅助面板的既有所有者。消息列与 Composer 共用 `--reading-width`（基础上限 768px），嵌入式会话遵循宿主宽度。同行、字段、分区和面板间距使用 frontmatter 对应的语义角色。

每个页面保留一个主纵向滚动拥有者；代码、日志和文件阅读区域可有有界独立滚动。窄窗口下按组重排，设置控件可以落到说明下方，长标签自然换行；不通过缩小正文或裁掉动作解决空间不足。组件局部断点与宽度继续由组件维护，不提炼未经证实的全局断点。

## Elevation & Depth

以表面色差、留白和必要边界建立分组。菜单、浮层、Composer 与对话框分别使用 `--shadow-menu`、`--shadow-overlay`、`--shadow-composer`、`--shadow-dialog`；阴影表达结构，不给每段文字增加独立卡片。半透明导航和原生材料需要在实际背景下独立核对，静态颜色不能证明最终合成效果。

## Shapes

圆角按按钮、控件、面板、对话框、Composer 和大浮层的角色选择，值见 frontmatter。导航与内嵌块沿用各自的 `--radius-navigation` 和 `--radius-inset`。胶囊只用于已有的发送动作、标签和计数等对应模式；具体组件的局部几何以其实现为准。

## Components

- **按钮**：复用 [Button](clients/gui/packages/ui/src/components/button/button.md) 的 default、secondary、outline、ghost 与语义动作变体；size 控制密度。默认按钮使用中性主动作配色，hover 改变表面，键盘焦点使用独立 ring，禁用与无效状态保留真实语义。
- **输入框**：复用 [Input](clients/gui/packages/ui/src/components/input/input.md)，默认边界、hover 边界、聚焦背景与错误状态分别表达。宿主提供 label、值与校验结果；不能仅靠 placeholder 命名字段。
- **卡片**：复用 [Card](clients/gui/packages/ui/src/components/card/card.md) 表达功能分组。内部留白和标题层级采用现有尺寸变体，不将每条过程信息卡片化。
- **导航**：复用 [SettingsNavigation](clients/gui/packages/ui/src/workbench/settings-navigation/settings-navigation.tsx) 等工作台组合。选中表面、hover 与焦点分别表达，保留当前页语义和宿主导航控制。
- **对话与 Composer**：沿用[对话信息流合同](clients/gui/design-system/patterns.md#对话信息流)；过程与正文维持共同阅读节奏，详情进入现有详情面板或明确的文字展开入口。

即时、常规与较长过渡分别使用 `--motion-fast`、`--motion-normal`、`--motion-slow`，配合公共 easing 和 reduced motion 接线。Button 只过渡颜色，避免 `transition-all` 引发尺寸与滚动样式动画。

## Do's and Don'ts

### Do:
- Do 按用途引用生产 Token，复用现有组件及其 size / variant。
- Do 分别检查明暗主题、用户字号、窄窗口与键盘焦点。
- Do 保留操作字号与阅读字号的独立偏好。
- Do 用状态文字和图标补充颜色表达，并依据真实执行结果呈现反馈。

### Don't:
- Don't 从本文件复制色值、字号或圆角到页面，建立平行主题。
- Don't 用缩字、禁用透明度或内容裁切掩盖可读性与布局问题。
- Don't 给每段文字增加卡片、重阴影或装饰渐变。
- Don't 使用左侧三角作为展开入口；沿用详情入口或带可访问语义的展开文字按钮。
