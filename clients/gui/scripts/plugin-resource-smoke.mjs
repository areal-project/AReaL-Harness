import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const pluginResourceReply = "# 插件管理前的阅读记录\n\n" + Array.from({ length: 48 }, (_, index) =>
  `【插件第${String(index + 1).padStart(2, "0")}段】这一段记录项目协作的上下文。打开插件资源、筛选目录和管理启用范围后，应当回到当前任务的相同阅读位置，保留尚未发送的中文草稿。\n\n`
).join("");

export async function verifyPluginResourceSlice({ app, page, state, until, pluginState, projectId, scratch, requests, checks }) {
  const events = [];
  const button = name => page.getByRole("button", { name, exact: true });
  const row = () => button("查看插件 hello@gui-p0");
  const search = () => page.getByRole("searchbox", { name: "搜索插件包", exact: true });
  const shot = async name => {
    await page.screenshot({ path: join(scratch, `${name}.png`), animations: "disabled" });
    await writeFile(join(scratch, `${name}.aria.txt`), await page.locator("body").ariaSnapshot());
    events.push({ name, at: new Date().toISOString() });
  };
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const personal = async () => {
    await page.getByRole("navigation", { name: "应用导航", exact: true }).getByRole("button", { name: "插件", exact: true }).click();
    const tab = page.getByRole("tablist", { name: "市场范围", exact: true }).getByRole("tab", { name: "个人", exact: true });
    if (await tab.count()) await tab.click();
    else await button("返回插件列表").click();
    await row().waitFor();
  };
  const readPosition = () => page.evaluate(() => {
    const viewport = document.querySelector(".messages");
    const bounds = viewport.getBoundingClientRect();
    const paragraph = [...viewport.querySelectorAll(".assistant-message .conversation-markdown p")].find(element => element.getBoundingClientRect().bottom > bounds.top && element.getBoundingClientRect().top < bounds.bottom);
    const owner = document.querySelector('[data-testid="areal-workbench"]');
    return { paragraph: paragraph?.textContent?.match(/【插件第\d+段】/)?.[0], offset: paragraph ? paragraph.getBoundingClientRect().top - bounds.top : null,
      projectId: owner.dataset.projectId, threadId: owner.dataset.threadId, remaining: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight };
  });
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("areal-core:command");
    const control = globalThis.pluginResourceControl = { original, rules: [], events: [], releases: [] };
    ipcMain.removeHandler("areal-core:command");
    ipcMain.handle("areal-core:command", async (event, name, params) => {
      if (name !== "manage") return original(event, name, params);
      const entry = { operation: params.operation, requestId: params.requestId, id: params.id, scope: params.scope, enabled: params.enabled, expectedRevision: params.expectedRevision, at: Date.now() };
      control.events.push(entry);
      const rule = control.rules.find(candidate => candidate.operation === params.operation && !candidate.used);
      if (!rule) return original(event, name, params);
      rule.used = true;
      entry.injection = rule.kind;
      if (rule.kind === "read-failure") return { ok: false, error: { message: `RESOURCE_OPTIONAL_${params.operation}_FAILED` } };
      if (rule.kind === "read-block") await new Promise(resolve => control.releases.push(resolve));
      const result = await original(event, name, rule.kind === "stale" ? { ...params, expectedRevision: Number.MAX_SAFE_INTEGER } : params);
      entry.completed = Date.now();
      entry.ok = result.ok;
      entry.error = result.error;
      if (rule.kind === "mutation-block") await new Promise(resolve => control.releases.push(resolve));
      if (rule.kind === "response-loss" && result.ok) return { ok: false, error: { message: "RESOURCE_CONFIGURE_RESPONSE_LOST", submissionUnknown: true, requestId: params.requestId } };
      return result;
    });
  });
  const arm = (operation, kind) => app.evaluate((_electron, rule) => globalThis.pluginResourceControl.rules.push(rule), { operation, kind });
  const release = () => app.evaluate(() => { for (const resolve of globalThis.pluginResourceControl.releases.splice(0)) resolve(); });
  const boundaryEvents = () => app.evaluate(() => globalThis.pluginResourceControl.events);
  const refreshReady = () => page.waitForFunction(() => document.querySelector('button[aria-label="刷新市场"]')?.disabled === false);
  const waitBoundary = (operation, kind, completed = false) => {
    const deadline = Date.now() + 20000;
    return (async () => {
      while (Date.now() < deadline) {
        const event = (await boundaryEvents()).findLast(event => event.operation === operation && event.injection === kind && (!completed || event.completed));
        if (event) return event;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw Error(`Boundary barrier was not reached for ${operation} ${kind}`);
    })();
  };
  try {
    await button("设置").click();
    await button("常规").click();
    await page.getByRole("switch", { name: "预测下一条提示词", exact: true }).uncheck();
    await button("返回应用").click();
    await page.getByTestId("chat-input").fill("请生成插件管理前的完整阅读记录。");
    await page.getByTestId("chat-send-button").click();
    await page.getByTestId("chat-view").getByText("【插件第48段】", { exact: false }).waitFor();
    const original = await until(snapshot => Object.values(snapshot.projects.find(project => project.id === projectId).state.threads).some(thread => thread.turns?.at(-1)?.status === "completed"), "original resource conversation completed");
    const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
    const turns = original.projects.find(project => project.id === projectId).state.threads[threadId].turns.length;
    const taskRequests = requests.length;
    const draft = "插件管理后继续讨论的中文草稿，暂时不要发送。";
    await page.getByTestId("chat-input").fill(draft);
    await personal();
    await search().fill("hello");
    await row().waitFor();
    await search().fill("does-not-exist-resource-slice");
    await page.getByText("没有匹配的插件", { exact: true }).waitFor();
    assert.equal(await row().count(), 0, "unmatched plugin search hides the catalog row");
    await button("清除插件搜索").focus();
    await page.keyboard.press("Enter");
    await row().waitFor();
    assert.equal(await search().inputValue(), "", "clear search restores the personal plugin catalog");
    await search().fill("hello");
    await arm("plugins", "read-block");
    await button("刷新市场").click();
    await waitBoundary("plugins", "read-block");
    await shot("resource-plugin-blocked-read");
    assert.equal(await page.locator('.plugin-center[aria-busy="true"], .plugin-center [aria-busy="true"]').count() > 0, true, "blocked plugin catalog read exposes a busy resource region");
    assert.equal(await page.getByRole("status").filter({ hasText: /加载|刷新/ }).isVisible(), true, "blocked plugin catalog read exposes meaningful loading status");
    await release();
    await page.waitForFunction(() => !document.querySelector('.plugin-center[aria-busy="true"], .plugin-center [aria-busy="true"]'));
    await row().waitFor();
    assert.equal(await search().inputValue(), "hello", "refresh preserves personal query");
    checks.push("personal plugin search, empty results, keyboard clear, visible blocked loading and query-preserving refresh");
    for (const operation of ["pluginMcp", "pluginHooks"]) {
      await refreshReady();
      await arm(operation, "read-failure");
      await button("刷新市场").click();
      await page.getByText(`RESOURCE_OPTIONAL_${operation}_FAILED`, { exact: false }).waitFor();
      assert.equal(await row().isVisible(), true, "optional plugin read failure keeps installed catalog visible");
      assert.equal(await search().inputValue(), "hello", "optional read failure preserves query context");
      await shot(`resource-plugin-${operation}-failure`);
      await button("刷新市场").click();
      await page.getByText(`RESOURCE_OPTIONAL_${operation}_FAILED`, { exact: false }).waitFor({ state: "hidden" });
      await refreshReady();
      await row().waitFor();
    }
    checks.push("optional MCP and hook read errors retain catalog identity and recover through refresh");
    const position = await row().boundingBox();
    await row().focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("plugin-detail-page").waitFor();
    await page.getByTestId("plugin-detail-page").getByRole("heading", { name: "Hello Plugin", exact: true }).waitFor();
    await button("管理").waitFor();
    await button("返回插件列表").focus();
    await page.keyboard.press("Enter");
    await row().waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "查看插件 hello@gui-p0");
    assert.equal(await row().evaluate(element => element === document.activeElement), true, "return from installed detail focuses its original plugin row");
    assert.equal(await search().inputValue(), "hello", "detail return preserves query");
    assert.ok(Math.abs((await row().boundingBox()).y - position.y) <= 2, "detail return retains plugin list position");
    await shot("resource-plugin-list-return");
    await row().press("Enter");
    await button("管理").click();
    await button("管理启用范围").click();
    await button("资源范围").click();
    await page.getByRole("menuitemradio", { name: "当前项目", exact: true }).click();
    await arm("pluginConfigure", "mutation-block");
    await button("在项目范围停用").click();
    const disabled = await waitBoundary("pluginConfigure", "mutation-block", true);
    assert.equal(disabled.scope, "project", "configure uses explicit project scope");
    assert.equal(disabled.ok, true, "real Core committed the blocked disable mutation");
    await pluginState(plugin => plugin?.enabled === false, "real project disable committed");
    assert.equal(await button("在项目范围启用").isDisabled(), true, "pending disable blocks duplicate and opposite mutations");
    assert.equal(await button("在项目范围停用").isDisabled(), true, "pending disable prevents duplicate click");
    await shot("resource-plugin-configure-pending");
    await release();
    await button("在项目范围启用").waitFor();
    await page.waitForFunction(() => !document.querySelector('.plugin-status-panel[aria-busy="true"]'));
    assert.equal((await boundaryEvents()).filter(event => event.operation === "pluginConfigure").length, 1, "pending mutation submits once");
    await arm("pluginConfigure", "response-loss");
    await button("在项目范围启用").click();
    const lost = await waitBoundary("pluginConfigure", "response-loss", true);
    await button("核对插件提交").waitFor();
    await shot("resource-plugin-configure-unknown");
    await button("核对插件提交").focus();
    await page.keyboard.press("Enter");
    await page.getByText("原提交已确认完成，未重新执行。", { exact: true }).waitFor();
    await pluginState(plugin => plugin?.enabled === true, "real project enable recovered");
    const recovered = await boundaryEvents();
    assert.equal(recovered.filter(event => event.operation === "pluginConfigure" && event.requestId === lost.requestId).length, 1, "unknown configure reconciles original receipt without mutation replay");
    assert.ok(recovered.some(event => event.operation === "pluginSubmission" && event.requestId === lost.requestId), "receipt recovery reads the original configure request identity");
    await shot("resource-plugin-configure-recovered");
    await arm("pluginConfigure", "stale");
    await button("在项目范围停用").click();
    const stale = await waitBoundary("pluginConfigure", "stale", true);
    assert.equal(stale.ok, false, "real Core rejects the stale revision");
    assert.equal(stale.error.submissionUnknown, true, "admitted stale mutation requires original receipt reconciliation");
    await button("核对插件提交").waitFor();
    await shot("resource-plugin-stale-unknown");
    await button("核对插件提交").click();
    await page.getByTestId("plugin-detail-page").getByRole("alert").waitFor();
    const staleReceipt = await boundaryEvents();
    assert.equal(staleReceipt.filter(event => event.operation === "pluginConfigure" && event.requestId === stale.requestId).length, 1, "stale failure reconciliation never repeats the mutation");
    assert.ok(staleReceipt.some(event => event.operation === "pluginSubmission" && event.requestId === stale.requestId), "stale failure reads the original admitted request");
    assert.ok((await page.getByTestId("plugin-detail-page").getByRole("alert").innerText()).trim(), "stale configure exposes the rejected operation error");
    assert.equal(await page.getByTestId("plugin-detail-page").getByRole("heading", { name: "Hello Plugin", exact: true }).isVisible(), true, "stale mutation retains the exact plugin detail identity");
    await pluginState(plugin => plugin?.enabled === true, "stale disable has no effect");
    await shot("resource-plugin-stale-revision");
    checks.push("project disable and enable cross real Main/Core; blocked response prevents duplicates; lost response reconciles original receipt; real stale revision retains plugin identity");
    await button("返回原任务").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("chat-input").waitFor();
    for (const condition of [{ name: "light-wide-14", dark: false, width: 1440, font: 14 }, { name: "dark-narrow-18", dark: true, width: 980, font: 18 }]) {
      await button("设置").click();
      await button("外观").click();
      await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), condition.width);
      await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
      await page.getByRole("option", { name: condition.dark ? "深色" : "浅色", exact: true }).click();
      await page.getByRole("spinbutton", { name: "界面字号", exact: true }).fill(String(condition.font));
      const content = page.getByRole("spinbutton", { name: "内容字号", exact: true });
      if (!await content.isVisible()) await page.locator("summary").filter({ hasText: "阅读与代码" }).click();
      await content.fill(String(condition.font));
      await button("返回应用").click();
      await page.getByTestId("chat-input").waitFor();
      await page.waitForFunction(condition => document.documentElement.classList.contains("dark") === condition.dark
        && getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() === `${condition.font}px`
        && getComputedStyle(document.documentElement).getPropertyValue("--content-font-size").trim() === `${condition.font}px`, condition);
      const viewport = page.locator(".messages");
      const bounds = await viewport.boundingBox();
      const paragraph = page.locator(".assistant-message .conversation-markdown p").filter({ hasText: "【插件第24段】" });
      const top = await paragraph.evaluate(element => element.getBoundingClientRect().top);
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.wheel(0, top - bounds.y - 40);
      await page.waitForFunction(() => { const viewport = document.querySelector(".messages"); return viewport.scrollTop > 0 && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 500; });
      await settle();
      const before = await readPosition();
      assert.ok(before.paragraph && before.remaining > 500, "resource origin identifies an earlier numbered reading paragraph");
      await shot(`resource-plugin-${condition.name}-task-before`);
      await personal();
      await row().focus();
      await page.keyboard.press("Enter");
      await page.getByTestId("plugin-detail-page").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "plugin detail fits representative viewport and production font size");
      await shot(`resource-plugin-${condition.name}-detail`);
      await button("返回原任务").focus();
      await page.keyboard.press("Enter");
      await page.getByTestId("chat-input").waitFor();
      await settle();
      const after = await readPosition();
      assert.equal(after.projectId, projectId, "resource return preserves project identity");
      assert.equal(after.threadId, threadId, "resource return preserves original task identity");
      assert.equal(after.paragraph, before.paragraph, "resource return preserves numbered reading paragraph");
      assert.ok(Math.abs(after.offset - before.offset) <= 2, "resource return preserves reading paragraph offset");
      assert.equal(await page.getByTestId("chat-input").innerText(), draft, "resource return preserves exact unsent Chinese draft");
      assert.equal(requests.length, taskRequests, "plugin management never sends a model request");
      const current = await state();
      assert.equal(current.projects.find(project => project.id === projectId).state.threads[threadId].turns.length, turns, "plugin navigation creates no task turn");
      assert.equal(await page.getByTestId("chat-input").evaluate(element => element === document.activeElement || element.contains(document.activeElement)), true, "resource return restores Composer focus");
      events.push({ condition, before, after });
      await shot(`resource-plugin-${condition.name}-task-return`);
    }
    checks.push("keyboard task return preserves original project, task, numbered paragraph and unsent Chinese draft at light wide 14 and dark narrow 18 production preferences");
  } finally {
    await release();
    const boundary = await boundaryEvents();
    await app.evaluate(({ ipcMain }) => {
      const control = globalThis.pluginResourceControl;
      control.rules.length = 0;
      ipcMain.removeHandler("areal-core:command");
      ipcMain.handle("areal-core:command", control.original);
      delete globalThis.pluginResourceControl;
    });
    await writeFile(join(scratch, "resource-plugin-events.json"), JSON.stringify({ events, boundary, mainHandlerRestored: true }, null, 2));
  }
}
