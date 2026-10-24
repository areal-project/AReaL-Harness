botiverse/raft-design · 源码拆解 · commit f2675b8 · 2026-10-23

# Raft 设计系统是怎么搭起来的

一句话：Raft 把设计系统当作一个**带类型检查的编译器**来做。"意义"是源码，CSS、React 组件、文档站和给 Agent 用的 Skill 都是编译产物，测试和文档 linter 负责类型检查。下面按架构、核心思路、Mental Model、借鉴路线四部分展开。

@botiverse/raft-ui **v0.32.2** 设计文档 **65** 页 组件文档 **95** 份 测试文件 **219**（浏览器 99） tokens.json **4031** 行 · DTCG React 19 · Base UI · Tailwind v4

先给结论

## 核心 Mental Model：设计系统是一个编译器

读完整个仓库，最值得带走的不是黄色和像素方块，而是这套工程结构。把它映射成编译器的四个部件，就能看清每个文件夹在干什么。

源码意义 + 理由

`design/` 下的原则、基础、模式和决策记录。每条规则都写了 why。

中间表示语义 Token

`tokens.json`（DTCG 标准）。名字表达角色，不表达颜色。

编译产物多目标输出

`foundation.css`、Tailwind 映射、React 组件、文档站、`llms.txt`、Agent Skill。

类型检查守卫

生成一致性、APCA 对比度、选择器性能、文档对代码的 linter。

意义先于数值

每个颜色、每条线、每个形状先回答"它代表什么"。说不出意义的颜色要删掉。

单一来源，其余都生成

值只写一次，其他文件由脚本生成，并且有测试保证生成物没有被手改。

规则带理由，由机器守卫

文档和代码不一致时，*总有一方是错的*，必须在同一个 PR 里修掉其中一方。

第一部分 · 架构

## 仓库全景：从意义到产物

点击任意一块，右侧会显示它的路径、职责、关键规则，以及可以借鉴的点。依赖方向是单向的：上游从不 import 下游。

源\
Source

↓ 生成 / 实现

实现\
Build

↓ 分发

产物\
Ship

↺ 贯穿全部

守卫\
Guard

第二部分 · 设计思路

## 六个贯穿整个仓库的思路

每个思路左边是"它在想什么"，右边是仓库里的实物证据。

思路 A · 颜色是语言，不是装饰

### 每种颜色只有一个意思，全产品线通用

Raft 的原则 4 写得很直白：**黄色是"你"**（你在哪、你选了什么、提到你），**粉色是"待办"**（每屏最多一个主按钮，加上未读），内容里被单独挑出的条目是青色，通知是中性深色。红色只给**不可撤销**的后果，可恢复的错误一律用橙色。

这样做的回报是：屏幕上出现任何颜色都在传递信息，用户学一次，所有产品都通用。所以按钮**永远不能是黄色**，因为黄色已经被"你"占用了。

右边的色块是"贴纸"：1.5px 墨线边、墨色文字、暗色模式下不反转，只多一圈"模切边"。切换你的系统深浅色模式可以看到效果。

brand

你

导航选中、提及你、搜索命中、框架

attention

待办

每屏最多 1 个主按钮；未读

info

这一条

内容中被单独挑出的条目

warning

打断，可撤销

停止、离开、重置、可恢复的错误

danger

不可撤销

只出现在确认对话框的确认按钮

hud

旁白

Toast、Tooltip 一律中性

思路 B · 线条也有语义

### 三种线，三种意思；两个区域之间只有一条线

**Hairline** 在内容内部，表示"这些属于一组"；**Seam**（45% 墨）在区域之间，表示"一个区域到此为止"；**墨线边框**只给控件，表示"这里可以点或输入"。

45% 这个数字是试出来的：30% 在黄色上太淡，40% 刚好不到 3:1，50% 开始像控件的边框。记录在决策 `0009` 里，连被否掉的备选值都写了。这是"规则带理由"最典型的样子。

#design#general#agents

Bugen claimed #25Assign

Wug opened a PRReview

Task moved to In ReviewOpen

hairline：行与行之间（内容内部） seam：侧栏与主区之间（区域边界） 墨线：按钮边框（控件）

思路 C · 规则必须带理由

### 每条规则 = 规则 + 为什么 + 怎么推广到新情况

7 条原则都按同一个格式写：一句可以在 review 时检查的规则，一段 **Why**，再加一段 **To apply it**，告诉你遇到文档没覆盖的情况该怎么判断。原文的说法是："没有理由的规则，第一次不方便的时候就会被打破。"

小规则的理由就写在规则旁边；只有跨系统的重大选择才进入 `design/decisions/`，编号永不复用，被推翻的记录标成 `superseded`。还没决定的事放进 `open-questions.md`，并写明决定之前的默认做法。

RULE**2. Three lines, three meanings.** A hairline sits inside content, a seam sits between regions, and an ink border marks a control.

WHYLines are read as structure, so each kind of line answers one question… If a card had an ink border it would look clickable.

APPLYName the boundary before you draw a line. If it isn't inside content, between regions or around a control, change the fill or the spacing instead.

LINKSApplied in: Color, Shape, Page structure · 决策 0009

design/principles/principles.md 原文摘录

思路 D · 结构用组件表达，不用 props 切换

### 不要 `kind` / `state` / `emphasis` 这种万能开关

当一个 prop 会让组件渲染出**明显不同的结构**时，Raft 要求把它拆成显式的组合部件。业务状态（上传中、已收藏、权限）留在消费方，组件库只暴露"可以用来表达这些状态的部件"，消费方决定渲染哪一块。

样式上也延续这个思路：根节点通过 `data-slot` 和 `has-*` 选择器从子部件推导自己的样式，而不是要求你传 `state="pending"`。

不允许

```
// 一个 prop 决定整块结构
<Attachment
  state="pending"
  kind="diff"
  title="build.log"
/>
```

Raft 的做法

```
// 消费方决定哪个部件存在
<MessageAttachmentCard>
  <MessageAttachmentBody />
  <MessageAttachmentLoadingBar />
  <MessageAttachmentPendingIndicator />
</MessageAttachmentCard>
```

packages/ui/AGENTS.md · Product-State Styling

```
// button.tsx：视觉"材料"被写成函数，变体只是组合材料
const sticker = (fill) => [
  `border-sticker-ink ${fill} text-sticker-ink ring-[1.5px] ring-sticker-edge`,
  "hover:overlay-sticker-medium active:overlay-sticker-medium",
];
variant: {
  primary: { root: sticker("bg-attention-400") },
  danger:  { root: sticker("bg-danger") },
}
```

思路 E · 性能和疲劳度也是设计约束

### "一整天开着"的产品，每一点视觉噪音都按分钟付费

Raft 的出发点是：官网是让人看一眼就记住的，产品是让人**看几个小时**的。所以它保留官网的材料，但把音量调低：黄色退到框架上，粗黑线换成 45% 的 seam，控件去掉硬阴影，状态灯不闪烁。

"状态不动"有实测数据支撑。同样，组件库禁止 Tailwind 的 `space-*` / `divide-*` 和非锚定的 `:last-child`，因为 WebKit 在长列表里会为它们付出巨大代价，而且有测试把这条规则锁住。

144fps · 80%一个循环动画的状态灯，开着对话框时的帧率和 GPU 占用

2fps · 3%动画停掉之后。所以工作中的 Agent 是一盏静止的黄灯加一句话

180–430ms万级元素时间线里，一条 `:last-child` 规则带来的重算耗时（WebKit）

>5ms / 次一条祖先 `:has()` 规则在 1.38 万元素页面上的每次变更成本，29 条已被移除

决策 0006 · packages/ui/AGENTS.md Selector Cost · no-ancestor-has.test.ts

思路 F · 为 Agent 设计，而不只是给人看

### 设计系统的第二类读者是 AI

文档首页就写着"这些文档写给每个构建 Raft 的人，人和 Agent 都是"。整个仓库为 Agent 准备了多层入口，而且 Skill **跟着 npm 包一起发版**，所以 Agent 读到的指导永远和安装的代码版本一致。

最巧妙的是 `raft-ui-guide` 里的"**Override your priors first**"表：直接列出 AI 最容易带进来的 shadcn / Radix 习惯，逐条纠正。这是在对抗模型的训练先验。

`AGENTS.md`（`CLAUDE.md` 是它的软链接）

仓库级契约：架构归属、交付 SOP、迁移不变量、样式规范

`/llms.txt` · 每页 `.md`

文档站构建时生成，Agent 直接读 Markdown

`/components.json`

每个组件的状态、别名、摘要、文档 URL

`skills/raft-ui-guide`

怎么用：采用顺序、查 API 的方法、常见错误

`skills/raft-ui-critique`

怎么审：亮暗两种模式分别取证，代码推断必须标注 inferred

```
| Your instinct                      | Reality in raft-ui        |
| <Button variant="destructive">     | variant="danger"，且只用于 AlertDialog |
| <Button size="icon">              | size="icon-md" / "icon-lg" |
| className="text-gray-500"          | text-foreground-muted     |
| asChild (Radix)                    | render prop (Base UI)     |
```

第三部分 · Token 管线

## 一个 class 是怎么一路解析到颜色值的

选一个组件里真实使用的 class，看它经过的每一层。注意每层只做一件事：Tailwind 层负责映射，foundation 层负责模式切换，tokens.json 负责定义值和理由。

Token 命名语法：中性色是 `{role}-{purpose}-{intensity}`（role 只有 foreground / layer / line / fill 四种），色族是 `{family}-{slot}`（slot 有 strong / 实色 / muted / soft / hover / active），透明叠加是 `ink-{alpha%}`。看到一个没见过的 token 名，也能猜出它的用途。一次性的值允许直接写 `oklch()`，**第三次出现才提成 token**。

组件层的边界

## 谁拥有什么：组件库的状态边界

这张表是 `AGENTS.md` 里 State Boundary 的浓缩版，也是最容易直接搬到你们团队的一条约定。

| 职责 | 归属 | 例子 |
| --- | --- | --- |
| 交互行为 | Base UI 原语（无样式） | 开关状态、焦点、键盘导航、集合选择、受控/非受控值 |
| 视觉样式 | `tv()` recipe + 语义 token | 字号、间距、hover / active / disabled、明暗差异 |
| 可见结构 | `children` + 组合部件 | `DialogHeader`、`MessageAttachmentPendingIndicator` |
| 产品流程状态 | 消费方 App | 上传生命周期、通知策略、收藏、权限、任务流转 |
| 文案与业务图标 | 消费方 App | i18n 文本、政策文案、某个业务专用的 icon |
| 产品概念组件 | Collaboration 层（建在 Core 上） | 消息、线程、任务、Agent 卡片；Core 永不 import 它 |

判断新组件放哪一层只问一个问题：**在一个没有消息、任务、Agent 的 App 里，它还有意义吗？**有，就是 Core，按功能命名、不带业务 props；没有，就是 Collaboration。一个 Core 组件开始需要业务概念时，它已经变成两个组件了。

第四部分 · Mental Model

## 四个可以随身带走的思考框架

编译器模型管工程结构；下面三个管日常判断。它们都不依赖 Raft 的品牌，可以直接用在你们的项目上。

模型 1 · 注意力预算

### 颜色、线条、动效都是花注意力的

把屏幕想成一笔每分钟都在扣的预算。装饰花掉的注意力，就是从"选中了什么、什么在等你、哪里出错了"这些信号里拿走的。所以排查顺序固定：**屏幕让人累，先删颜色，再删线，再删动效**。

**Frame**黄色框架，没人读

**Cream**侧栏，过渡一级

**Paper**白纸，阅读发生处

**Ink**文字、边框、贴纸边

颜色从外到内递减：品牌放在没人读的地方，阅读发生在最安静的地方。

模型 2 · 三问法

### 画任何新元素之前先问

1. 它是**内容、区域还是控件**？\
   决定它在什么表面、用哪种线。
2. 它的颜色**代表什么**？\
   身份、状态、信号（你 / 待办 / 这一条）或后果。都不是就删掉。
3. 它**代表谁、装着内容，还是一个约定俗成的控件**？\
   代表身份用方形，装内容用圆角容器，开关和单选才用圆。
4. 盯着它看几个小时**会累吗**？\
   表示状态的东西不许循环或闪烁。

模型 3 · 冲突时的优先级

### 原则打架时怎么裁决

1. **意义优先于位置。**\
   暗色模式里框架变成中性色，但"你在这里"的选中项依然是黄色贴纸。
2. **可读性优先于精确的品牌值。**\
   粉色被调浅（#FE7DA8 → #FF99C3），让墨色文字对比度从 7.8:1 提到 9.5:1。
3. **少优先于多。**\
   拿不准就做减法。

一个团队有了明确的裁决顺序，大部分设计争论在 review 里几分钟就能结束。

模型 4 · 两种声音

### 人说的话和机器写的东西要能一眼分开

Space Grotesk 是"人说的"，Space Mono 是"机器写的"：ID、时间、计数、运行时长、事件行和代码都用等宽体。在一个 Agent 和人写得一样多的工作区里，这让读者在一句话内部就能分辨来源，比如 "Bugen claimed #25"。

延伸开来：**Agent 和人用同一套行、消息和头像**；Agent 在做什么，就显示在它本来出现的位置，而不是另开一个面板。

第五部分 · 怎么借鉴

## 分阶段引入到你们的项目

按投入从小到大排列，每一阶段单独都有回报。不需要做到 Raft 的规模，前两阶段就能解决多数团队"设计不一致、改一个颜色到处找"的问题。

阶段 1写下原则和语义 Token约 1 周 · 1–2 人

- 写 5–7 条原则，每条都按"规则 / Why / To apply it"三段式。先从你们已经在争论的问题写起。
- 定一张"颜色 → 意义"表，再定 token 命名语法：名字说角色（`foreground-muted`），不说颜色（`gray-500`）。
- 建一个 `tokens.json`（DTCG 格式）作为唯一来源，写个脚本生成 CSS 变量，再加一个测试：生成物和源不一致就失败。

**参考**design/principles/principles.md\
design/foundations/tokens.md\
scripts/build-tokens.mjs\
foundation.generated.test.ts

阶段 2组件契约2–4 周

- 采用"无样式行为库 + recipe + 组合部件"三件套（Base UI / Radix / Ark 都行），样式全部进 recipe，不允许靠文档站或调用方的 className 补全外观。
- 把上面的状态边界表写进组件库的 `AGENTS.md`，review 时逐条对照。
- 分出 Core 和业务层两层，Core 不准 import 业务层。新 API 先走 `wip.ts` 出口，稳定后再升级。

**参考**packages/ui/AGENTS.md\
design/components/overview.md\
src/wip.ts

阶段 3文档和代码绑在一起持续投入

- 组件文档放在组件代码旁边（`button/button.md`），示例引用真实可执行的 composition，API 部分从类型自动生成。
- 写一个文档 linter：检查 front matter、组件状态和导出是否一致、链接锚点、token 名是否存在，甚至营销用语。
- 只为跨系统的重大选择写决策记录，并写清被否掉的备选项。

**参考**scripts/check-docs.mjs\
apps/doc/scripts/build-api.mjs\
design/authoring/templates/

阶段 4让 Agent 成为一等读者1 周起步

- 仓库根放 `AGENTS.md`（`CLAUDE.md` 做软链接），写清归属、SOP 和不变量。
- 文档站输出 `llms.txt`、每页 `.md` 和组件索引 JSON。
- 把"使用 Skill"和"审查 Skill"放进包里随版本发布；写一张"纠正你的先验"表，专门对付 AI 常犯的错。

**参考**packages/ui/skills/raft-ui-guide/SKILL.md\
packages/ui/skills/raft-ui-critique/SKILL.md\
apps/doc/scripts/build-llms.mjs

阶段 5守卫与演进按需

- 给主题加对比度测试（Raft 用 APCA），手工编辑的主题文件也能被检查。
- 用"棘轮"测试锁住性能陷阱：已修掉的模式直接禁用，存量按文件冻结计数，只许减少。
- 改名时随包发 codemod，旧名作为 deprecated 别名保留到 1.0。

**参考**themes.contrast.test.ts\
no-ancestor-has.test.ts\
codemods/token-names.mjs

落到你们的场景

## 对 GUI + TUI 双端的 Agent 产品，最值得拿的几样

Raft 本身就是"人和 Agent 一起工作"的产品，所以它的很多规则对 Agent 产品是现成可用的。

### 一份 tokens.json，同时生成 GUI 和 TUI 主题

DTCG 格式和平台无关。在 Raft 的生成脚本旁边加一个 TUI 目标：把 oklch 转成 truecolor，再给 256 色终端一个降级表。两端共用 `foreground-muted`、`line-seam`、`presence-busy` 这些名字，改一次两端同步。

借自 tokens.json 的 $extensions 设计（modes.dark / desktop）

### Agent 状态静止显示，不用循环动画

"工作中的 Agent 是一盏静止的黄灯加一句它在做什么"。放到 TUI 里，就是用状态色块加一行描述代替不停转的 spinner。这能减少重绘，日志也更好读。

借自决策 0006 · design/people-and-agents/working-agents.md

### 人说的用比例字体，机器产出的用等宽字体

GUI 里用字体区分；TUI 本身全是等宽字体，可以改用颜色层级或前缀来区分：Agent 产出的 ID、耗时、事件行统一用 muted 色。规则的本质是让读者一眼分清来源。

借自原则 7 · design/foundations/typography.md

### 红色只留给不可撤销的操作

Agent 产品里"停止任务、重试、回滚"这类可恢复操作很多。全标红的话，真正危险的"删除工作区"就不显眼了。可恢复的用橙色，红色只出现在确认对话框里。

借自原则 5 · button.md Variants

不要照搬的地方

## Raft 的代价和局限

**品牌本身不是重点。** 黄色、方形像素、Space Grotesk 是 Raft 自己的身份，照搬只会做出一个仿品。该拿的是"颜色有唯一意义"这套方法。

**测试基建很重。** 219 个测试文件对 10 人团队来说维护成本很高。建议起步只保留三个守卫：生成物一致性、对比度、文档 linter。

**浏览器测试不在 CI 里跑。** 99 个 `*.browser.test.tsx` 在 CI 里全部被跳过，要靠开发者手工运行并在 PR 里写明。这是靠纪律而不是靠机器，你们引入时最好补上 CI。

**历史包袱已经可见。** `tokens.json` 里有 166 个 deprecated 别名，Button 有好几个"渲染效果完全相同"的旧变体名。这说明命名要一开始就定好语法，否则迁移成本会一直累积。

**仍是 pre-1.0，技术栈绑定较深。** minor 版本可能有破坏性变更；强依赖 React 19、Tailwind v4 和 Base UI。如果你们 GUI 不是 React 栈，能直接复用的只有 `foundation.css` 和 `tokens.json`。

这一页本身也照着 Raft 的规则做：黄色只在顶部框架、导航选中和"你"的含义上；区域之间一条 seam；墨线边框只给可点击的东西；架构图里被选中的那一块用青色，因为它是"内容里被挑出的条目"；全页没有粉色，因为这里没有主操作。

来源

- [github.com/botiverse/raft-design](https://github.com/botiverse/raft-design)（本页基于 commit f2675b8）
- [raft-design.botiverse.build](https://raft-design.botiverse.build) · [llms.txt](https://raft-design.botiverse.build/llms.txt)
- [Design Tokens Community Group 格式 2025.10](https://www.designtokens.org/tr/2025.10/)