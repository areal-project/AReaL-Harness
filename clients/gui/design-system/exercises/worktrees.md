# Worktree 的参考对照与验收

本题核对[Worktree 规范](../worktrees.md)的生产组合，沿 P-DETAIL、P-STATUS、P-SETTINGS 与原对话阅读合同，不改变 Base 准入。参考为用户提供的 WT-R01～09 静态截图；未提供参考 viewport、DPR 或动态录制，比较结构、状态、层级和对齐，不声明像素相等。

## 可重复入口与边界

从仓库根执行。已有锁定依赖和匹配 Core 是前提，不连接用户现有窗口、真实账号或供应商。

```sh
pnpm --dir clients/gui build
AREAL_CHROMIUM_BIN=/absolute/path/to/chromium node clients/gui/scripts/worktree-ui-smoke.mjs
AREAL_CORE_BIN=/absolute/path/to/areal node clients/gui/scripts/worktree-environment-smoke.mjs
```

[组件题](../../scripts/worktree-ui-smoke.mjs)挂载生产组件，仅替换服务响应与初始投影。覆盖 9 组检查及 56 个 PNG / ARIA 状态帧，包含明暗、14 / 18 UI 字号、1100 / 390 宽、减弱动效、平台独立切换、未保存保护、Actions 与 UNKNOWN 恢复。Messages 使用只读嵌入宿主核对历史归属，不代表完整会话视觉。

[桌面题](../../scripts/worktree-environment-smoke.mjs)启动隔离 Electron、真实 Core、Git 和受管 shell。7 条路径通过。模型 HTTP 服务、原生目录选择器与退出确认是声明的 fixture；实际配置保存、重载、脚本执行、首条发送、取消与安全拒删走原产品接口。测试实例服务已退出，Core 二进制与被测生产源保持不变。

## 按参考与状态核对

| 参考 / 状态 | 代表证据 ID | 结论 |
| --- | --- | --- |
| WT-R09 主菜单关 / 开 | picker-off、picker-on、picker-configured、桌面 picker-acceptance | 齿轮在上下文条尾部；三行 label / value，环境关态禁用；配置不创建或发送 |
| WT-R08 分支与环境子页 | picker-branches、picker-branch-search-empty、picker-environments | 单浮层替换，搜索、选中勾、返回与焦点恢复；列表有界。只用已提交来源；宿主没有本地 / 远端类型字段时不猜分组 |
| WT-R01 项目入口 | settings-environment-projects、settings-environment-list | 项目先行；列表与编辑分层。添加项目复用原宿主入口，其原生目录窗口不在物理输入验收范围 |
| WT-R02、07 编辑 | settings-editor-actions-empty、settings-platform-independent、settings-action-editor、桌面 environment-platforms-restored | 独立编辑页、面包屑、变量说明、各脚本独立的平台标签；代码输入有单层边框与语义表面；保存不执行脚本 |
| WT-R03 General / 目录 | settings-general、settings-directory-details、settings-delete-blocked、桌面 dirty-worktree-delete-rejected | 四行设置同组，高级前缀披露，按项目的紧凑目录。真实脏目录拒删，原文件保留 |
| WT-R05 准备与日志 | state-creating、state-creating-log-details、桌面 setup-progress / setup-progress-details | Prompt 在前，日志默认关闭，人工展开跨输出保留；取消与不用 Worktree 在同一控制区；真实 Setup 完成前模型请求为零 |
| WT-R04 已创建 / 等待 | state-created、state-settingUp、桌面 setup-progress | 已创建与等待绑定 / Setup 分开，Composer 等待且不重复展示输入 |
| WT-R06 ready / 侧栏 | state-ready、sidebar-identity、桌面 ready-with-sidebar-badge | 成功收敛为轻量事实，侧栏只有具名分叉图标；创建记录在原本地 Prompt 后 |
| 取消 / failed / UNKNOWN | state-cancelling / cancelled / failed / unknown、桌面 setup-cancelled-draft-preserved / setup-failed-draft-preserved / explicit-original-checkout | 静态异常形态与交互分别验证；真实取消确认后脚本 PID 已退出；改用原目录只发送一次，取消目录保留；UNKNOWN fixture 不自动重放 |
| 继承 / 分页历史 | messages-inherited-first-own、messages-partial-history、messages-complete-first-own | 先复现误挂到祖先 Prompt，修复后仅完整本地历史首轮有一份记录；不完整历史不误挂到后来可见的 Prompt |
| Actions / 保存可达 | workspace-action-*、settings-actions-full、settings-*-footer | 运行 / 成功 / 失败 / UNKNOWN 分开；真实 Action 写入目标文件；窄窗可滚动到保存、放弃与删除 |

## 证据登记与保留差异

本地证据 ID `WT-UI-RENDERER` 对应 `.scratch/worktree-ui-20261024/renderer-4`，包括 manifest、每帧 PNG / ARIA、九组 contact sheet 和截图索引。`WT-UI-DESKTOP` 对应 `.scratch/worktree-ui-20261024/electron/run-2J5VSj`，包括 manifest、源码 / Core 校验和、模型请求、清理结果与 15 张截图。原参考在本地 `worktree-design-20261024/reference-index.json` 按 WT-R01～09 关联。用户原图、合成运行文件和临时目录不迁入源码。

先看总览，再核对菜单、编辑器、准备过程与 ready 原图。首次暗色采集缺少真实页面壳，已作为采集失败保留并重采；脚本输入边界不足与历史错误归属经过一次修正并复验。空编辑器的 DOM 换行按空白文本核对，不把换行当作 Prompt 副本。macOS 的临时路径别名会触发原 Worktree 符号链接保护，公开检查使用 `TMPDIR=/private/tmp` 重跑后通过，没有放宽保护。

保留 AReaL 字体、图标、色彩与字号偏好，以及高级分支前缀、安全删除和恢复语义。参考的 Windows、脏文件复制、删除前恢复快照未采用。未覆盖安装包、真实供应商、原生输入法 / 物理键鼠、Linux 实机、自动保留清理和成功删除前的 Cleanup；不能由本题提升这些范围。
