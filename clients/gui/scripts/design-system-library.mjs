import assert from "node:assert/strict";
import { join } from "node:path";

export async function runUiLibrary(page, scratch, checks) {
  const library = page.getByRole("region", { name: "UI包设计系统", exact: true });
  await library.waitFor();
  const manifest = await page.evaluate(async () => (await fetch("/components.json")).json());
  assert.equal(manifest.name, "@areal/ui");
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.components.map(({ title, status, entry, layer }) => [title, status, entry, layer]), [
  [
    "ActionButton",
    "stable",
    "index",
    "core"
  ],
  [
    "ActivityGroup",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "AttachmentCard",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "Button",
    "stable",
    "index",
    "core"
  ],
  [
    "Card",
    "experimental",
    "wip",
    "core"
  ],
  [
    "CodeViewer",
    "experimental",
    "wip",
    "core"
  ],
  [
    "CollapsibleText",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "Command",
    "experimental",
    "wip",
    "core"
  ],
  [
    "CommandDetails",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "ComposerSurface",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "ComposerToolbar",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "ContextMenu",
    "stable",
    "index",
    "core"
  ],
  [
    "ControlHintTooltip",
    "stable",
    "index",
    "core"
  ],
  [
    "DecisionCard",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "Dialog",
    "experimental",
    "wip",
    "core"
  ],
  [
    "DiffViewer",
    "experimental",
    "wip",
    "core"
  ],
  [
    "Disclosure",
    "experimental",
    "wip",
    "core"
  ],
  [
    "DropdownMenu",
    "stable",
    "index",
    "core"
  ],
  [
    "FeedbackNotice",
    "experimental",
    "wip",
    "core"
  ],
  [
    "ImageDisclosure",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "Input",
    "stable",
    "index",
    "core"
  ],
  [
    "InputGroup",
    "experimental",
    "wip",
    "core"
  ],
  [
    "MarkdownBlockquote",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "MarkdownUnorderedList",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "MarkdownSurface",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "MarkdownTable",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "Attachments",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "MessageCodeBlock",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "NativeContent",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "NotificationToast",
    "experimental",
    "wip",
    "core"
  ],
  [
    "Popover",
    "stable",
    "index",
    "core"
  ],
  [
    "QuestionCard",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "ResourceScope",
    "experimental",
    "wip",
    "workbench"
  ],
  [
    "ScheduledWorkspace",
    "experimental",
    "wip",
    "workbench"
  ],
  [
    "Select",
    "stable",
    "index",
    "core"
  ],
  [
    "SettingsDialog",
    "experimental",
    "wip",
    "settings"
  ],
  [
    "SettingsDisclosure",
    "experimental",
    "wip",
    "core"
  ],
  [
    "SettingsGroupCard",
    "experimental",
    "wip",
    "settings"
  ],
  [
    "SettingsNavigation",
    "experimental",
    "wip",
    "workbench"
  ],
  [
    "SettingsPage",
    "experimental",
    "wip",
    "settings"
  ],
  [
    "SettingsRow",
    "experimental",
    "wip",
    "settings"
  ],
  [
    "SettingsSearchInput",
    "experimental",
    "wip",
    "settings"
  ],
  [
    "SettingsSection",
    "experimental",
    "wip",
    "settings"
  ],
  [
    "SettingsSegmentedTabs",
    "experimental",
    "wip",
    "settings"
  ],
  [
    "SettingsSelect",
    "experimental",
    "wip",
    "settings"
  ],
  [
    "SidePaneFrame",
    "experimental",
    "wip",
    "workbench"
  ],
  [
    "SidePaneLauncher",
    "experimental",
    "wip",
    "workbench"
  ],
  [
    "Spinner",
    "experimental",
    "wip",
    "core"
  ],
  [
    "SubagentPanel",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "Switch",
    "stable",
    "index",
    "core"
  ],
  [
    "Tabs",
    "stable",
    "index",
    "core"
  ],
  [
    "TaskContext",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "MemoTaskItem",
    "experimental",
    "wip",
    "workbench"
  ],
  [
    "TaskTitleOverflowText",
    "experimental",
    "wip",
    "workbench"
  ],
  [
    "Textarea",
    "stable",
    "index",
    "core"
  ],
  [
    "ThinkingStatus",
    "experimental",
    "wip",
    "conversation"
  ],
  [
    "Tooltip",
    "stable",
    "index",
    "core"
  ],
  [
    "WorkbenchShell",
    "experimental",
    "wip",
    "workbench"
  ],
  [
    "WorktreeDirectory",
    "experimental",
    "wip",
    "worktree"
  ],
  [
    "WorktreePicker",
    "experimental",
    "wip",
    "worktree"
  ],
  [
    "WorktreeSettings",
    "experimental",
    "wip",
    "worktree"
  ],
  [
    "WorktreeStatus",
    "experimental",
    "wip",
    "worktree"
  ],
  [
    "WorktreeWorkspace",
    "experimental",
    "wip",
    "worktree"
  ]
]);
  assert.ok(manifest.components.find(component => component.title === "Button").api.includes("declare function Button"));
  for (const id of ["action-button", "activity-group", "attachment-card", "card", "code-viewer", "collapsible-text", "command", "command-details", "composer-surface", "composer-toolbar", "context-menu", "control-hint-tooltip", "decision-card", "dialog", "diff-viewer", "dropdown-menu", "feedback-notice", "image-disclosure", "input", "input-group", "markdown-blockquote", "markdown-list", "markdown-surface", "markdown-table", "message-attachments", "message-code-block", "native-content", "notification-toast", "popover", "question-card", "resource-controls", "select", "settings-dialog", "settings-disclosure", "settings-group-card", "settings-navigation", "settings-page", "settings-row", "settings-search-input", "settings-section", "settings-segmented-tabs", "settings-select", "side-pane-frame", "side-pane-launcher", "spinner", "subagent-panel", "switch", "tabs", "task-context", "task-list-item", "task-title-overflow", "textarea", "thinking-status", "tooltip", "workbench-shell", "worktree-directory", "worktree-picker", "worktree-settings", "worktree-status", "worktree-workspace"]) {
    const document = await page.evaluate(async id => (await fetch(`/docs/ui/${id}.md`)).text(), id);
    assert.ok(document.includes(`id: ${id}`), `raw contract for ${id}`);
    const component = manifest.components.find(component => component.id === id);
    await library.locator("article").filter({ has: page.getByRole("heading", { name: component.title, exact: true }) }).getByRole("link", { name: "阅读组件合同", exact: true }).click();
    await page.getByRole("heading", { name: new RegExp(`^${component.title} `) }).waitFor();
    const metadata = page.getByRole("region", { name: "组件元数据", exact: true });
    await metadata.getByRole("rowheader", { name: "related", exact: true }).waitFor();
    await metadata.getByRole("link", { name: "查看 Markdown 原文", exact: true }).waitFor();
    const live = page.frameLocator(`iframe[title="${component.title} 独立示例"]`);
    if (id === "thinking-status") {
      await live.getByRole("button", { name: "更新模型摘要", exact: true }).click();
      await live.getByRole("status").filter({ hasText: "对比上下文卡片与资源面板" }).waitFor();
      await live.getByRole("button", { name: "回退 Thinking", exact: true }).click();
      await live.getByRole("status").filter({ hasText: "Thinking" }).waitFor();
      await page.screenshot({ path: join(scratch, "thinking-document-example.png"), fullPage: true });
      await metadata.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(scratch, "thinking-document-metadata.png"), fullPage: true });
      await page.getByLabel("主题", { exact: true }).selectOption("dark");
      await page.setViewportSize({ width: 420, height: 900 });
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
      await page.screenshot({ path: join(scratch, "thinking-document-narrow.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    if (id === "composer-surface") {
      const input = live.getByRole("textbox", { name: "示例任务输入", exact: true });
      const send = live.getByRole("button", { name: "发送样例", exact: true });
      assert.equal(await send.isEnabled(), false, "empty input cannot submit");
      await input.fill("保留的Composer草稿");
      await send.click();
      await live.getByRole("status").filter({ hasText: "本地发送动作 1 次" }).waitFor();
      await live.getByLabel("Composer状态", { exact: true }).selectOption("blocked");
      await live.getByRole("status").filter({ hasText: "所选模型暂不可用" }).waitFor();
      assert.equal(await send.isEnabled(), false);
      assert.equal(await input.inputValue(), "保留的Composer草稿");
      assert.equal(await input.isEnabled(), true, "blocked model leaves the draft editable");
      await live.getByLabel("Composer状态", { exact: true }).selectOption("sending");
      assert.equal(await input.isEnabled(), false);
      await live.getByLabel("Composer状态", { exact: true }).selectOption("ready");
      await live.getByRole("button", { name: "添加示例引用", exact: true }).click();
      await live.getByRole("button", { name: "移除 设计引用 1.md", exact: true }).click();
      assert.equal(await input.inputValue(), "保留的Composer草稿");
      await live.getByRole("button", { name: "填入长草稿", exact: true }).click();
      const bounds = await input.evaluate(el => { const editor = el.closest(".composer-editor"); return { full: editor.scrollHeight, visible: editor.clientHeight, overflow: getComputedStyle(editor).overflowY }; });
      assert.ok(bounds.full > bounds.visible && bounds.overflow === "auto", "long draft uses the editor's vertical scroll owner");
      await live.getByLabel("Composer布局", { exact: true }).selectOption("compact");
      await live.getByLabel("Composer状态", { exact: true }).selectOption("running");
      await live.getByRole("button", { name: "停止运行样例", exact: true }).click();
      assert.ok((await input.inputValue()).includes("请核对活动"));
    }
    if (id === "settings-page") {
      const settings = live.getByRole("region", { name: "设置布局样例", exact: true });
      const value = settings.getByRole("textbox", { name: "示例工作区名称", exact: true });
      await value.fill("尚未保存的名称");
      await live.getByLabel("设置反馈状态", { exact: true }).selectOption("pending");
      assert.equal(await value.isEnabled(), false, "host disables actual controls while saving");
      await live.getByLabel("设置反馈状态", { exact: true }).selectOption("unknown");
      await settings.getByRole("status").filter({ hasText: "保存结果待核对" }).waitFor();
      assert.equal(await value.inputValue(), "尚未保存的名称");
      assert.equal(await settings.getByRole("button", { name: "保存样例", exact: true }).isEnabled(), false);
      await live.getByLabel("设置反馈状态", { exact: true }).selectOption("error");
      await settings.getByRole("alert").filter({ hasText: "保存失败" }).waitFor();
      await live.getByLabel("设置反馈状态", { exact: true }).selectOption("ready");
      await settings.getByRole("button", { name: "保存样例", exact: true }).click();
      await settings.getByRole("status").filter({ hasText: "本地样例已保存：尚未保存的名称" }).waitFor();
      await settings.getByRole("button", { name: "查看设置边界", exact: true }).click();
      await settings.getByText("配置值、导航守卫与保存回执仍归宿主。", { exact: true }).waitFor();
      assert.equal(await settings.getByRole("checkbox", { name: "锁定的示例选项", exact: true }).isEnabled(), false);
      const scroll = await settings.locator(".settings-workspace").evaluate(el => ({ overflow: getComputedStyle(el).overflowY, full: el.scrollHeight, height: el.clientHeight }));
      assert.ok(scroll.overflow === "auto" && scroll.full > scroll.height, "settings page owns vertical reading");
      await page.screenshot({ path: join(scratch, "settings-document-example.png"), fullPage: true });
      await page.setViewportSize({ width: 420, height: 900 });
      await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
      assert.equal(await value.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const columns = await settings.locator(".settings-field-layout-wide").first().evaluate(el => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      assert.equal(columns, 1, "narrow group stacks label and control");
      await page.screenshot({ path: join(scratch, "settings-document-narrow.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    if (id === "worktree-picker") {
      await live.getByRole("button", { name: "选择起始分支", exact: true }).click();
      const search = live.getByRole("textbox", { name: "搜索示例分支", exact: true });
      await search.fill("feature/");
      const options = live.getByRole("listbox", { name: "示例分支", exact: true });
      const first = options.getByRole("option").first();
      await first.focus(); await first.press("End");
      assert.equal(await options.getByRole("option").last().evaluate(el => document.activeElement === el), true);
      await options.getByRole("option").last().press("Enter");
      await live.getByRole("status").filter({ hasText: "所选分支：feature/" }).waitFor();
      await live.getByLabel("Worktree选项状态", { exact: true }).selectOption("error");
      await live.getByRole("alert").filter({ hasText: "无法读取示例选项" }).waitFor();
      assert.equal(await live.getByRole("button", { name: "选择起始分支", exact: true }).isEnabled(), false);
      await live.getByRole("button", { name: "重试示例选项", exact: true }).click();
      assert.equal(await live.getByRole("button", { name: "选择起始分支", exact: true }).isEnabled(), true);
    }
    if (id === "worktree-status") {
      await live.getByRole("button", { name: "查看创建详情", exact: true }).click();
      await live.getByRole("log", { name: "示例准备输出", exact: true }).waitFor();
      await live.getByLabel("Worktree准备状态", { exact: true }).selectOption("unknown");
      await live.getByRole("status").filter({ hasText: "准备结果待核对" }).waitFor();
      await live.getByRole("button", { name: "收起创建详情", exact: true }).click();
      await live.getByRole("status").filter({ hasText: "准备结果待核对" }).waitFor();
      assert.equal(await live.getByRole("log", { name: "示例准备输出", exact: true }).count(), 0);
      await live.getByLabel("Worktree准备状态", { exact: true }).selectOption("ready");
      assert.equal(await live.getByRole("button", { name: "取消准备样例", exact: true }).count(), 0);
    }
    if (id === "worktree-directory") {
      await live.getByRole("button", { name: "查看目录 示例任务", exact: true }).click();
      await live.getByText("/workspace/worktrees/long-directory/示例任务", { exact: true }).waitFor();
      await live.getByRole("button", { name: "删除目录 示例任务", exact: true }).click();
      await live.getByRole("alert").filter({ hasText: "示例删除受阻" }).waitFor();
      await live.getByRole("button", { name: "查看目录 示例任务", exact: true }).click();
      await live.getByRole("alert").filter({ hasText: "示例删除受阻" }).waitFor();
    }
    if (id === "worktree-settings") {
      await live.getByRole("button", { name: "配置项目 示例项目", exact: true }).click();
      await live.getByRole("button", { name: "编辑环境 本地开发", exact: true }).click();
      const input = live.getByRole("textbox", { name: "示例Setup脚本", exact: true });
      await input.fill("echo keep default");
      await live.getByLabel("示例脚本平台", { exact: true }).selectOption("macos");
      await input.fill("echo keep macOS");
      await live.getByLabel("示例脚本平台", { exact: true }).selectOption("default");
      assert.equal(await input.inputValue(), "echo keep default");
      await live.getByLabel("环境保存状态", { exact: true }).selectOption("saving");
      assert.equal(await input.isEnabled(), false);
      await live.getByLabel("环境保存状态", { exact: true }).selectOption("error");
      assert.equal(await input.inputValue(), "echo keep default");
      await live.getByRole("alert").filter({ hasText: "示例保存失败" }).waitFor();
    }
    if (id.startsWith("worktree-")) {
      await live.locator("body").screenshot({ path: join(scratch, `${id}-example.png`) });
      await page.setViewportSize({ width: 420, height: 900 });
      assert.equal(await live.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await live.locator("body").screenshot({ path: join(scratch, `${id}-narrow.png`) });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    if (id === "notification-toast") {
      await page.clock.install();
      const colors = new Set();
      for (const label of ["普通", "警告", "成功"]) {
        await live.getByRole("button", { name: `触发${label}提示`, exact: true }).click();
        colors.add(await live.locator(".areal-notification-toast").evaluate(el => getComputedStyle(el).borderColor));
      }
      await live.getByRole("button", { name: "触发错误提示", exact: true }).click();
      await live.getByRole("alert").filter({ hasText: "删除失败" }).waitFor();
      await page.screenshot({ path: join(scratch, "notification-toast-error.png"), fullPage: true });
      assert.equal(await live.locator(".areal-notification-toast").getAttribute("data-tone"), "error");
      colors.add(await live.locator(".areal-notification-toast").evaluate(el => getComputedStyle(el).borderColor));
      assert.equal(colors.size, 4, "four levels have distinct rendered semantic colors");
      await live.getByRole("button", { name: "关闭示例提示", exact: true }).click();
      assert.equal(await live.locator(".areal-notification-toast").count(), 0);
      await live.getByRole("button", { name: "触发成功提示", exact: true }).click();
      await live.getByRole("status").filter({ hasText: "设置已保存" }).waitFor();
      await live.locator(".areal-notification-toast").hover();
      await page.clock.fastForward(6000);
      assert.equal(await live.locator(".areal-notification-toast").isVisible(), true, "hover pauses expiry");
      await live.getByRole("button", { name: "触发普通提示", exact: true }).hover();
      await page.clock.fastForward(5100);
      await live.locator(".areal-notification-toast").waitFor({ state: "hidden", timeout: 1000 });
    }
    if (id === "task-context") {
      const toggle = live.getByRole("button", { name: "任务上下文", exact: true });
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await toggle.click();
      await live.getByRole("region", { name: "输入来源", exact: true }).waitFor();
    }
    await verifyMigratedExample(id, live);
    if (["input", "dialog", "markdown-table", "code-viewer", "workbench-shell", "settings-navigation", "decision-card", "attachment-card"].includes(id)) {
      await live.locator("body").screenshot({ path: join(scratch, `${id}-migrated.png`) });
      await page.setViewportSize({ width: 420, height: 900 });
      assert.equal(await frameFits(live), true, `${id} fits narrow independent container`);
      await live.locator("body").screenshot({ path: join(scratch, `${id}-migrated-narrow.png`) });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await page.goBack(); await library.waitFor();
  }
  const llms = await page.evaluate(async () => (await fetch("/llms.txt")).text());
  assert.ok(llms.includes("@areal/ui/wip"));
  const guide = await page.evaluate(async () => (await fetch("/docs/ui/agent-guide.md")).text());
  assert.ok(guide.includes("Agent 使用入口"));
  const frame = page.frameLocator('iframe[title="独立UI包示例"]');
  await frame.getByRole("button", { name: "执行示例", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "已触发 1 次本地动作" }).waitFor();
  const control = frame.getByRole("button", { name: "执行示例", exact: true });
  assert.equal(await control.evaluate(element => element.getBoundingClientRect().height), 28);
  const disclosure = frame.getByRole("button", { name: "查看组件职责", exact: true });
  assert.equal(await disclosure.getAttribute("aria-expanded"), "false");
  await disclosure.press("Enter");
  await frame.getByText("基础交互与外观由包内实现负责。业务状态、执行与持久化由宿主提供。", { exact: true }).waitFor();
  assert.equal(await control.evaluate(() => typeof window.arealDesktop), "undefined");
  assert.equal(await control.evaluate(() => [...document.styleSheets].some(sheet => [...sheet.cssRules].some(rule => rule.cssText.includes(".tool-file-diff")))), false);
  await page.screenshot({ path: join(scratch, "ui-library-light.png"), fullPage: true });
  await page.getByLabel("主题", { exact: true }).selectOption("dark");
  await page.getByLabel("字号", { exact: true }).selectOption("18");
  await frame.locator("html.dark").waitFor();
  await page.waitForFunction(() => document.querySelector("iframe").contentDocument?.documentElement.style.getPropertyValue("--ui-font-size") === "18px");
  assert.equal(await control.evaluate(element => element.getBoundingClientRect().height), 32);
  assert.equal(await control.evaluate(() => getComputedStyle(document.body).backgroundColor), "rgb(24, 24, 24)");
  await page.setViewportSize({ width: 420, height: 900 });
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth);
  assert.equal(await frameFits(frame), true, "combined independent examples fit after resize");
  await page.screenshot({ path: join(scratch, "ui-library-dark-narrow.png"), fullPage: true });
  checks.push("组件索引、API、llms与Agent原文由包构建输出；MD元数据、原文链接、关联组件及独立示例可导航操作，窄窗无横向溢出");
  checks.push("独立iframe仅消费包与Tailwind（含迁入包的工作台样式），未加载renderer业务样式；按钮动作、28/32px字号响应、Disclosure键盘、明暗默认主题与420px布局通过");
  const group = frame.getByRole("button", { name: "读取文件、运行命令 · 30 项活动", exact: true });
  assert.equal(await group.getAttribute("aria-expanded"), "false");
  await group.press("Enter");
  const list = frame.getByRole("region", { name: "分组活动列表", exact: true });
  assert.equal(await list.getByRole("listitem").count(), 30);
  assert.equal(await list.evaluate(element => element.scrollHeight > element.clientHeight && element.scrollWidth <= element.clientWidth), true);
  const detail = list.getByRole("button", { name: "查看首条命令", exact: true });
  await detail.click(); await group.click(); await group.click();
  assert.equal(await detail.getAttribute("aria-expanded"), "true");
  assert.equal(await list.evaluate(element => element.scrollWidth <= element.clientWidth), true, "long command wraps inside the package component");
  await frame.getByRole("button", { name: "显示待核对状态", exact: true }).click();
  await group.click();
  await frame.getByRole("status").filter({ hasText: "退出结果待核对" }).waitFor();
  const image = frame.getByRole("button", { name: "已查看图片 · 本地示例", exact: true });
  assert.equal(await image.getAttribute("aria-expanded"), "false");
  await image.click();
  await frame.getByRole("img", { name: "本地界面参考", exact: true }).waitFor();
  await frame.getByRole("button", { name: "切换图片可用性", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "图片暂不可用" }).waitFor();
  assert.equal(await image.getAttribute("aria-expanded"), "true", "availability updates keep reading choice");
  const sources = frame.getByRole("region", { name: "输入来源", exact: true });
  assert.equal(await sources.getByRole("button", { name: /^查看来源：/ }).count(), 3);
  await sources.getByRole("button", { name: "查看全部来源（5）", exact: true }).click();
  await frame.getByRole("heading", { name: "全部来源", exact: true }).waitFor();
  assert.equal(await frame.getByRole("button", { name: /^查看来源：/ }).count(), 5);
  await frame.getByRole("button", { name: "返回任务上下文", exact: true }).click();
  await sources.getByRole("button", { name: "折叠来源", exact: true }).click();
  assert.equal(await sources.getByRole("button", { name: /^查看来源：/ }).count(), 0);
  await sources.getByRole("button", { name: "添加来源", exact: true }).click();
  await frame.getByRole("status").filter({ hasText: "已加入草稿" }).waitFor();
  checks.push("实验对话组件从包独立消费：活动纵向滚动/子展开保留、收起可见异常、图片可用性、来源三项/全部/折叠/草稿动作通过");
  await frame.getByRole("button", { name: "查看子代理", exact: true }).click();
  const agents = frame.getByRole("region", { name: "子代理面板", exact: true });
  await agents.getByRole("button", { name: /独立交互检查.*运行中/ }).click();
  await agents.getByRole("region", { name: "子代理历史对话", exact: true }).getByText("本地子任务历史样例：已读取规范并核对组件接口。", { exact: true }).waitFor();
  await agents.getByRole("button", { name: "返回子代理列表", exact: true }).click();
  await agents.getByRole("button", { name: "关闭子代理面板", exact: true }).click();
}

async function verifyMigratedExample(id, live) {
  const fields = ["input", "textarea", "switch", "select", "tabs", "settings-search-input", "settings-segmented-tabs", "settings-select"];
  if (fields.includes(id)) {
    const input = live.getByRole("textbox", { name: "包内单行输入", exact: true });
    await input.fill("迁移后保留草稿");
    await live.getByRole("checkbox", { name: "禁用实例控件", exact: true }).check();
    assert.equal(await input.isEnabled(), false);
    assert.equal(await input.inputValue(), "迁移后保留草稿");
    await live.getByRole("checkbox", { name: "禁用实例控件", exact: true }).uncheck();
    const select = live.getByRole("combobox", { name: "包内单选", exact: true });
    await select.click();
    await live.getByRole("option", { name: "第二项", exact: true }).click();
    await live.getByRole("status").filter({ hasText: "当前选项：second" }).waitFor();
    await live.getByRole("button", { name: "清除包内搜索", exact: true }).click();
    assert.equal(await input.inputValue(), "");
  }
  if (["popover", "dialog", "dropdown-menu"].includes(id)) {
    const trigger = live.getByRole("button", { name: "打开包内浮层", exact: true });
    await trigger.click();
    if (id === "dropdown-menu") {
      await live.getByRole("menuitem", { name: "执行本地菜单项", exact: true }).press("Enter");
      await live.getByRole("status").filter({ hasText: "本地动作 1 次" }).waitFor();
    } else {
      const input = live.getByRole("textbox", { name: id === "dialog" ? "对话框输入" : "浮层输入", exact: true });
      await input.fill("浮层编辑"); await input.press("Escape");
      await input.waitFor({ state: "hidden" });
    }
    await trigger.and(live.locator(":focus")).waitFor();
    assert.equal(await trigger.evaluate(el => el === document.activeElement), true, `${id} restores trigger focus`);
  }
  if (id === "context-menu") {
    await live.getByText("在此区域打开右键菜单", { exact: true }).click({ button: "right" });
    await live.getByRole("menuitem", { name: "执行本地菜单项", exact: true }).click();
    await live.getByRole("status").filter({ hasText: "本地动作 1 次" }).waitFor();
  }
  if (id === "command") {
    const search = live.getByRole("combobox"); await search.fill("执行"); await search.press("ArrowDown"); await search.press("Enter");
    await live.getByRole("status").filter({ hasText: "本地动作 1 次" }).waitFor();
  }
  if (id === "action-button") {
    const action = live.getByRole("button", { name: "本地动作 0", exact: true }); await action.click();
    await live.getByRole("button", { name: "切换处理中", exact: true }).click();
    assert.equal(await live.getByRole("button", { name: /本地动作 1/ }).isEnabled(), false);
  }
  if (id === "settings-dialog") {
    await live.getByRole("button", { name: "打开设置编辑", exact: true }).click();
    const input = live.getByRole("textbox", { name: "设置编辑字段", exact: true });
    await input.fill("未提交草稿");
    await live.getByRole("button", { name: "切换保存中", exact: true }).click();
    const close = live.getByRole("button", { name: "关闭设置编辑", exact: true });
    assert.equal(await close.count(), 0, "saving hides the close affordance");
    await input.press("Escape"); assert.equal(await input.inputValue(), "未提交草稿");
    await live.getByRole("button", { name: "切换保存中", exact: true }).click(); await close.click();
    await input.waitFor({ state: "hidden" });
  }
  if (id === "decision-card") {
    await live.getByRole("button", { name: "批准本地样例", exact: true }).click();
    await live.getByRole("status").filter({ hasText: "仅表达意图；等待宿主结果。" }).waitFor();
    assert.equal(await live.getByRole("button", { name: /批准本地样例/ }).isEnabled(), false);
  }
  if (id === "attachment-card") {
    await live.getByRole("button", { name: "移除包内引用", exact: true }).click();
    await live.getByRole("status").filter({ hasText: "已从本地草稿移除" }).waitFor();
  }
  if (id === "settings-navigation") {
    const search = live.getByRole("searchbox", { name: "搜索设置样例", exact: true }); await search.fill("外观");
    await live.getByRole("button", { name: "外观", exact: true }).click();
    await live.getByRole("status").filter({ hasText: "当前分类 two" }).waitFor();
  }
  if (id === "task-list-item") {
    await live.getByTestId("task-item-sample").press("Enter");
    await live.getByRole("status").filter({ hasText: "本地动作 1" }).waitFor();
  }
  if (id === "code-viewer" || id === "diff-viewer") {
    await live.locator("diffs-container").first().locator("pre").waitFor();
    assert.ok((await live.locator("diffs-container").first().evaluate(el => el.shadowRoot?.textContent || "")).includes(id === "code-viewer" ? "AReaL" : "const value"));
  }
  if (id === "markdown-surface") await live.getByRole("heading", { name: "包内正文", exact: true }).waitFor();
  if (id === "markdown-table") await live.getByRole("cell", { name: "Input", exact: true }).waitFor();
}

async function frameFits(frame) {
  return frame.locator("html").evaluate(() => new Promise(resolve => {
    const deadline = performance.now() + 1500;
    const inspect = () => {
      if (document.documentElement.scrollWidth <= innerWidth) resolve(true);
      else if (performance.now() > deadline) resolve(false);
      else requestAnimationFrame(inspect);
    };
    requestAnimationFrame(inspect);
  }));
}
