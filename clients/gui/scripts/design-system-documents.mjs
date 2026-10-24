import assert from "node:assert/strict";
import { join } from "node:path";

export async function runDesignDocuments(page, origin, scratch, checks, samples) {
  const entry = `${origin}/design-system.html`;
  const open = async path => {
    await page.goto(`${entry}?docs=${encodeURIComponent(path)}`);
    await page.getByRole("article", { name: "设计文档正文", exact: true }).waitFor();
  };
  const follow = async href => {
    const currentPath = new URL(page.url()).searchParams.get("docs");
    const expected = new URL(href, `https://design.invalid/${currentPath}`).href;
    const links = page.getByRole("article", { name: "设计文档正文", exact: true }).locator("a[title], button[title]");
    await page.waitForFunction(({ base, expected }) => [...document.querySelectorAll("article a[title], article button[title]")].some(element => new URL(element.title, base).href === expected), { base: `https://design.invalid/${currentPath}`, expected });
    const index = await links.evaluateAll((elements, { base, expected }) => elements.findIndex(element => new URL(element.title, base).href === expected), { base: `https://design.invalid/${currentPath}`, expected });
    assert.ok(index >= 0, `设计文档包含链接 ${href}`);
    await links.nth(index).click();
  };
  await open("design/README.md");
  const article = page.getByRole("article", { name: "设计文档正文", exact: true });
  const knowledgeMap = article.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "回答的问题", exact: true }) });
  await knowledgeMap.waitFor();
  assert.deepEqual((await knowledgeMap.getByRole("columnheader").allTextContents()).map(value => value.trim()), ["目录", "回答的问题", "维护边界"]);
  assert.equal(await knowledgeMap.getByRole("row").count(), 9);
  await follow("content/README.md");
  assert.equal(new URL(page.url()).searchParams.get("docs"), "design/content/README.md");
  await page.goBack();
  await follow("products/README.md");
  await follow("workbench/README.md");
  await page.reload();
  await page.getByRole("heading", { name: "桌面工作台", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "桌面工作台", exact: true }).count(), 1);
  await open("design/README.md");
  await follow("products/workbench/README.md#预览与真实路径分别核对");
  const fragment = page.getByRole("heading", { name: "预览与真实路径分别核对", exact: true });
  await fragment.waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "预览与真实路径分别核对");
  assert.ok(await fragment.evaluate(el => el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < innerHeight));
  await page.reload();
  await page.waitForFunction(() => document.activeElement?.id === "预览与真实路径分别核对");
  await open("design/components/controls.md");
  await follow("../../clients/gui/renderer/src/components/ui/action-button.md");
  await follow("./action-button.tsx");
  const feedback = page.getByRole("status").filter({ hasText: "此文件未收录" });
  await feedback.waitFor();
  assert.ok((await feedback.innerText()).includes("clients/gui/renderer/src/components/ui/action-button.tsx"));
  await follow("../../../design-system.html#controls");
  await page.getByRole("region", { name: "公共控件", exact: true }).waitFor();
  assert.equal(new URL(page.url()).hash, "#controls");
  await page.getByRole("link", { name: "返回来源设计说明", exact: true }).click();
  assert.equal(new URL(page.url()).searchParams.get("docs"), "clients/gui/renderer/src/components/ui/action-button.md");
  await follow("../../../design-system.html#controls");
  await page.goBack();
  assert.equal(new URL(page.url()).searchParams.get("docs"), "clients/gui/renderer/src/components/ui/action-button.md");
  checks.push("设计地图、内容、工作台和控件合同可导航；中文片段定位、深链重载、浏览器返回和示例来源返回可用；源码链接明确显示未收录的当前仓库路径");

  for (const theme of ["light", "dark"]) {
    await open("design/components/controls.md");
    await page.setViewportSize({ width: 420, height: 900 });
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector(".design-document").scrollWidth <= innerWidth);
    await page.screenshot({ path: join(scratch, `documents-${theme}-420.png`), fullPage: true, animations: "disabled" });
    samples.push({ documents: { theme, width: 420 } });
  }
  for (const [path, heading, fragment] of [
    ["../renderer/src/settings/SettingsPageParts.md#settingspage", "SettingsPage", "settingspage"],
    ["../renderer/src/DecisionCard.md#decisioncard", "DecisionCard", "decisioncard"],
    ["../renderer/src/CollapsibleText.md", "CollapsibleText 合同", ""],
    ["../renderer/src/Messages.md#messages", "Messages", "messages"],
  ]) {
    await open("clients/gui/design-system/base.md");
    await follow(path);
    await page.getByRole("heading", { name: heading, exact: true }).waitFor();
    if (fragment) await page.waitForFunction(id => document.activeElement?.id === id, fragment);
    assert.equal(await page.getByRole("alert").count(), 0, "就近合同已收录且可定位");
  }
  await follow("../../design-system/base-evidence.md#e-conversation");
  await page.getByRole("heading", { name: "E-CONVERSATION", exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "e-conversation");
  checks.push("Base四份就近组合合同与证据索引可实际导航，标题锚点可定位且无未收录反馈");
  await page.goto(`${entry}?docs=design/not-collected.md`);
  await page.getByRole("alert").filter({ hasText: "未收录此设计文档" }).waitFor();
  assert.ok((await page.getByRole("alert").innerText()).includes("design/not-collected.md"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${entry}#controls`);
  const controls = page.getByRole("region", { name: "公共控件", exact: true });
  const toggle = controls.getByRole("switch", { name: "显示底部面板", exact: true });
  await toggle.focus();
  await toggle.press("Space");
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  const select = controls.getByRole("combobox", { name: "关闭窗口前确认", exact: true });
  await select.focus();
  await select.press("Enter");
  await page.getByRole("option", { name: "始终", exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "option");
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.activeElement?.textContent === "始终");
  await page.keyboard.press("Enter");
  await select.getByText("始终", { exact: true }).waitFor();
  assert.equal(await select.innerText(), "始终");
  const refresh = controls.getByRole("button", { name: "刷新状态", exact: true });
  const refreshFeedback = page.getByRole("region", { name: "Composer 预览", exact: true }).getByRole("status");
  assert.equal(await refreshFeedback.count(), 0);
  await refresh.focus();
  await refresh.press("Enter");
  await refreshFeedback.waitFor();
  assert.equal(await refreshFeedback.innerText(), "状态已刷新。");
  await page.getByLabel("状态", { exact: true }).selectOption("busy");
  assert.equal(await refresh.isDisabled(), true);
  assert.equal(await refresh.getAttribute("aria-busy"), "true");
  await page.getByLabel("状态", { exact: true }).selectOption("failed");
  assert.equal(await page.getByTestId("toast").getByRole("alert").innerText(), "操作未受理，请检查后重试。");
  await controls.getByRole("button", { name: "触发操作失败提醒", exact: true }).click();
  const operationToast = page.getByTestId("toast");
  await operationToast.filter({ hasText: "示例操作失败，输入已保留。" }).waitFor();
  assert.equal(await controls.getByTestId("feedback-notice").count(), 0, "consumed operation notices leave no persistent error card");
  await operationToast.waitFor({ state: "hidden", timeout: 8000 });
  await controls.getByRole("button", { name: "触发操作失败提醒", exact: true }).click();
  await operationToast.filter({ hasText: "示例操作失败，输入已保留。" }).waitFor();
  await page.getByLabel("状态", { exact: true }).selectOption("unknown");
  assert.equal(await controls.getByRole("status").innerText(), "结果待核对，保留当前内容。");
  const approval = page.getByRole("region", { name: "工具审批", exact: true });
  await approval.getByRole("button", { name: "允许一次", exact: true }).click();
  await approval.getByRole("button", { name: "核对待审批状态", exact: true }).waitFor();
  assert.equal(await approval.getByRole("button", { name: "允许一次", exact: true }).count(), 0);
  checks.push("420px 明暗文档无横向溢出；未知文档明确反馈；现有按钮、开关、选择器键盘可用，忙碌、失败、未知反馈和审批防重复提交保留");
}
