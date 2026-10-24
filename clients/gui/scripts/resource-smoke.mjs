import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const resourcePath = "resource-brief.md";
export const resourceMarkdown = "# 项目资源简报\n\n" + Array.from({ length: 40 }, (_, index) =>
  `## 资源段落 ${index + 1}\n\n本段记录项目需求与交付依据，文件内容应与已批准的工具回执一致。保留对话上下文，再检查本轮文件及历史变更。\n\n`
).join("");
export const resourceReply = workspace => "# 项目阅读简报\n\n" + Array.from({ length: 48 }, (_, index) =>
  `【资源第${String(index + 1).padStart(2, "0")}段】项目以清晰的任务边界组织协作。阅读这一段时，请保留当前任务、已经阅读的需求和下一条草稿。可以打开[项目资源简报](${workspace}/${resourcePath})核对已写入文件，再继续从这一段阅读。\n\n`
).join("") + `故障验证入口：[缺失资源](${workspace}/missing-resource.md)。此路径特意不存在，用于验证读取失败后的返回。`;

export async function verifyResourceSlice({ app, page, state, project, until, received, visualEvidence, checks, fullShot, setThread, workspace }) {
  const button = name => page.getByRole("button", { name, exact: true });
  const input = () => page.getByTestId("chat-input");
  await input().fill("resource: 请生成项目资源简报，并保留可核验的文件结果。");
  await page.getByTestId("chat-send-button").click();
  await page.getByRole("region", { name: "工具审批", exact: true }).waitFor();
  await button("允许一次").click();
  const completed = await until(snapshot => Object.values(project(snapshot).state.threads).some(thread => thread.turns?.at(-1)?.status === "completed"), "resource write completed");
  const thread = Object.values(project(completed).state.threads).find(thread => thread.turns?.length);
  setThread(thread.id);
  const turn = thread.turns.at(-1);
  const receipts = turn.items.filter(item => item.type === "dynamicToolCall" && item.tool === "fs_create");
  assert.equal(receipts.length, 1, "approved task has exactly one real file write");
  const receipt = receipts[0];
  assert.equal(receipt.success, true, "real Core confirms approved resource write");
  assert.equal(await readFile(join(workspace, resourcePath), "utf8"), resourceMarkdown, "real file bytes match requested resource");
  const expectedSha256 = createHash("sha256").update(resourceMarkdown).digest("hex");
  const result = receipt.contentItems.map(part => { try { return JSON.parse(part.text); } catch { return null; } }).find(part => part?.sha256);
  assert.equal(result.sha256, expectedSha256, "Core receipt hash identifies the real file");
  assert.equal(result.path, `workspace://repo/${resourcePath}`, "Core receipt path identifies the resource");
  const draft = "资源阅读后的未发送草稿：继续讨论交付安排。";
  await input().fill(draft);
  const requestCount = () => received.filter(request => request.messages?.some(message => message.role === "user" && typeof message.content === "string" && message.content.startsWith("resource:"))).length;
  const requests = requestCount();
  assert.equal(requests, 2, "approved write uses one task tool request and one continuation");
  const owner = { projectId: project(completed).id, threadId: thread.id, turnId: turn.id };
  const readView = () => page.evaluate(() => {
    const viewport = document.querySelector(".messages"), box = viewport.getBoundingClientRect();
    const paragraph = [...viewport.querySelectorAll(".assistant-message .conversation-markdown p")].find(element => element.getBoundingClientRect().bottom > box.top && element.getBoundingClientRect().top < box.bottom);
    return { paragraph: paragraph?.textContent?.match(/【资源第\d+段】/)?.[0], offset: paragraph ? paragraph.getBoundingClientRect().top - box.top : null,
      remaining: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      projectId: document.querySelector('[data-testid="areal-workbench"]').dataset.projectId,
      threadId: document.querySelector('[data-testid="areal-workbench"]').dataset.threadId };
  });
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const assertUnchanged = async () => {
    const snapshot = await state();
    assert.equal(project(snapshot).state.threads[thread.id].turns.length, 1, "resource navigation creates no turn");
    assert.equal(project(snapshot).state.threads[thread.id].turns[0].items.filter(item => item.type === "dynamicToolCall" && item.tool === "fs_create").length, 1, "resource navigation never replays the file write");
    assert.equal(requestCount(), requests, "resource navigation sends no additional task model request");
    assert.equal(await input().innerText(), draft, "resource return preserves unsent Chinese draft");
  };
  const close = async (origin, name, label) => {
    await button(name).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector('.side-panel[data-open="true"]'));
    await settle();
    const returned = await origin.evaluate(element => element === document.activeElement);
    visualEvidence.push({ stage: label, ...owner, returned, taskRequests: requestCount() });
    await fullShot(label);
    assert.equal(returned, true, `${label} restores the original conversation trigger`);
    await assertUnchanged();
  };
  const summary = page.getByTestId("turn-file-summary");
  const origin = summary.getByRole("button", { name: `打开 ${resourcePath}`, exact: true });
  await origin.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("workspace-file-preview").waitFor();
  await page.getByTestId("workspace-file-preview").getByRole("heading", { name: "项目资源简报", exact: true }).waitFor();
  await fullShot("resource-file-open");
  visualEvidence.push({ stage: "resource-file-identity", ...owner, receipt: result });
  await close(origin, "关闭面板", "resource-file-return");
  const reviewOrigin = summary.getByRole("button", { name: "查看变更", exact: true });
  await reviewOrigin.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("workspace-review").waitFor();
  await page.waitForFunction(turnId => document.querySelector('[aria-label="改动范围"]')?.title === turnId, turn.id);
  assert.equal(await page.getByTestId("workspace-review").getAttribute("data-review-source"), "history", "result Diff uses historical turn comparison");
  const comparison = await page.evaluate(async params => {
    const result = await window.arealDesktop.command("workspace", { ...params, operation: "turnReview" });
    if (!result.ok) throw Error(result.error.message);
    return result.value;
  }, owner);
  assert.equal(comparison.turnId, turn.id, "read-only Core comparison belongs to the result turn");
  assert.deepEqual(comparison.files.map(file => file.path), [resourcePath], "turn Diff excludes unrelated pre-existing dirty hello.ts");
  await page.getByTestId("workspace-review").getByText(resourcePath, { exact: true }).first().waitFor();
  visualEvidence.push({ stage: "resource-review-identity", ...owner, files: comparison.files.map(({ path, additions, deletions }) => ({ path, additions, deletions })) });
  await fullShot("resource-review-open");
  await button("跳转到文件").focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("workspace-file-preview").waitFor();
  await close(reviewOrigin, "展开侧边面板", "resource-review-file-header-return");
  for (const condition of [
    { name: "light-wide-14-14", dark: false, width: 1440, ui: 14, content: 14 },
    { name: "dark-wide-18-18", dark: true, width: 1440, ui: 18, content: 18 },
    { name: "dark-narrow-18-24", dark: true, width: 980, ui: 18, content: 24 },
    { name: "light-narrow-18-18", dark: false, width: 980, ui: 18, content: 18 },
  ]) {
    await button("设置").click();
    await button("外观").click();
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), condition.width);
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: condition.dark ? "深色" : "浅色", exact: true }).click();
    await page.getByRole("spinbutton", { name: "界面字号", exact: true }).fill(String(condition.ui));
    const content = page.getByRole("spinbutton", { name: "内容字号", exact: true });
    if (!await content.isVisible()) await page.locator("summary").filter({ hasText: "阅读与代码" }).click();
    await content.fill(String(condition.content));
    await button("返回应用").click();
    await page.waitForFunction(condition => document.documentElement.classList.contains("dark") === condition.dark
      && getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() === `${condition.ui}px`
      && getComputedStyle(document.documentElement).getPropertyValue("--content-font-size").trim() === `${condition.content}px`, condition);
    const viewport = page.locator(".messages"), box = await viewport.boundingBox();
    const paragraph = page.locator(".assistant-message .conversation-markdown p").filter({ hasText: "【资源第24段】" });
    const target = await paragraph.evaluate(element => element.getBoundingClientRect().top);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, target - box.y - 40);
    await page.waitForFunction(() => { const element = document.querySelector(".messages"); return element.scrollTop > 0 && element.scrollHeight - element.scrollTop - element.clientHeight > 500; });
    const readingOrigin = paragraph.getByRole("button", { name: "项目资源简报", exact: true });
    await readingOrigin.focus();
    await settle();
    const before = await readView();
    await page.keyboard.press("Enter");
    const preview = page.getByTestId("workspace-file-preview");
    await preview.waitFor();
    await preview.getByRole("heading", { name: "项目资源简报", exact: true }).waitFor();
    const geometry = await preview.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { width: innerWidth, x: bounds.x, right: bounds.right, file: element.querySelector('[aria-label="文件路径"]').title, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.equal(geometry.width, condition.width, "resource capture uses supported requested window width");
    assert.equal(geometry.documentOverflow, false, "resource layout keeps the window inside its horizontal bounds");
    assert.ok(geometry.x >= 0 && geometry.right <= condition.width + 1, "resource preview remains reachable inside the window");
    assert.ok(geometry.file.endsWith(`/${resourcePath}`), "source link retains the correct file identity");
    await fullShot(`resource-${condition.name}-open`);
    await close(readingOrigin, "关闭面板", `resource-${condition.name}-return`);
    const after = await readView();
    assert.equal(after.projectId, before.projectId, "resource return preserves project");
    assert.equal(after.threadId, before.threadId, "resource return preserves task");
    assert.equal(after.paragraph, before.paragraph, "resource return preserves earlier reading paragraph");
    assert.ok(Math.abs(after.offset - before.offset) <= 2, "resource return preserves reading paragraph offset");
    assert.ok(after.remaining > 120, "resource return preserves reading intent away from tail");
    visualEvidence.push({ stage: "resource-reading-return", condition, before, after, geometry });
  }
  await button("滚动到底部").click();
  const missingOrigin = button("缺失资源");
  await missingOrigin.focus();
  await page.keyboard.press("Enter");
  const missing = page.getByTestId("workspace-file-preview");
  await missing.waitFor();
  await missing.getByRole("status").filter({ hasText: /(?:不存在|not found|No such file|ENOENT|NOT_FOUND)/i }).waitFor();
  assert.ok((await missing.getByRole("navigation", { name: "文件路径" }).getAttribute("title")).endsWith("/missing-resource.md"), "missing-file error retains the requested resource identity");
  await fullShot("resource-missing-file-error");
  await close(missingOrigin, "展开侧边面板", "resource-missing-file-return");
  await origin.focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("workspace-file-preview").waitFor();
  await page.getByTestId("workspace-file-preview").getByRole("heading", { name: "项目资源简报", exact: true }).waitFor();
  await close(origin, "关闭面板", "resource-after-error-return");
  await button("展开侧边面板").focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("workspace-file-preview").waitFor();
  await button("新聊天").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="areal-workbench"]').dataset.threadId === "");
  await button("展开侧边面板").focus();
  await page.keyboard.press("Enter");
  if (await button("展开侧边面板").getAttribute("aria-pressed") === "true") {
    await button("关闭面板").focus();
    await page.keyboard.press("Enter");
  }
  await settle();
  assert.equal(await page.locator(".messages").count(), 0, "resource return does not move focus into the previous task after switching to a fresh draft");
  assert.equal(requestCount(), requests, "task switch and panel return do not resubmit the previous task");
  await fullShot("resource-switched-task-return");
  checks.push("real approved file bytes and receipt identify the resource; result Diff uses its exact historical turn and excludes unrelated Git dirt");
  checks.push("keyboard pane/header return, Diff-to-file navigation, reading anchors and unsent draft survive light/dark, independent font sizes and 1440/980 widths");
  checks.push("an explicit nonexistent source-link fault retains resource identity, returns to its origin, and allows a successful file reopen; fresh task return does not resubmit or enter the old conversation");
}
