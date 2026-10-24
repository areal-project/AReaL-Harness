import assert from "node:assert/strict";

export const appearanceReply = "# 项目阅读简报\n\n" + Array.from({ length: 48 }, (_, index) =>
  `【第${String(index + 1).padStart(2, "0")}段】项目以清晰的任务边界组织协作。阅读这一段时，请保留正在思考的需求、当前项目和下一条草稿。界面字号影响导航与控件，内容字号影响正文阅读。调整外观之后，应继续从同一段阅读，并且无需重复发送任务。\n\n`
).join("") + "## 下一步\n\n继续讨论项目需求，确认后再执行。";

export async function verifyAppearanceSlice({ app, page, state, project, until, received, visualEvidence, checks, fullShot, setThread }) {
  const input = () => page.getByTestId("chat-input");
  const button = name => page.getByRole("button", { name, exact: true });
  const draft = "下一条草稿：请保留阅读位置，再讨论项目的交付安排。";
  const openAppearance = async () => {
    await button("设置").click();
    await button("外观").click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).waitFor();
  };
  const setAppearance = async condition => {
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: condition.dark ? "深色" : "浅色", exact: true }).click();
    await page.getByRole("spinbutton", { name: "界面字号", exact: true }).fill(String(condition.ui));
    const content = page.getByRole("spinbutton", { name: "内容字号", exact: true });
    if (!await content.isVisible()) await page.locator("summary").filter({ hasText: "阅读与代码" }).click();
    await content.fill(String(condition.content));
    await page.waitForFunction(expected => {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      return root.classList.contains("dark") === expected.dark && style.getPropertyValue("--ui-font-size").trim() === `${expected.ui}px` && style.getPropertyValue("--content-font-size").trim() === `${expected.content}px`;
    }, condition);
    return page.evaluate(() => {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const navigation = document.querySelector(".settings-navigation-item span");
      const preview = document.querySelector(".appearance-reading-preview");
      return { dark: root.classList.contains("dark"), ui: style.getPropertyValue("--ui-font-size").trim(), content: style.getPropertyValue("--content-font-size").trim(), navigationSize: navigation && getComputedStyle(navigation).fontSize, previewSize: preview && getComputedStyle(preview).fontSize, savedTheme: localStorage.getItem("areal-gui:theme"), savedUi: localStorage.getItem("areal-gui:font-size"), savedContent: JSON.parse(localStorage.getItem("areal-gui:application-preferences") ?? "{}").contentSize };
    });
  };
  const readView = () => page.evaluate(() => {
    const viewport = document.querySelector(".messages");
    const box = viewport.getBoundingClientRect();
    const paragraphs = [...viewport.querySelectorAll(".assistant-message .conversation-markdown p")];
    const anchor = paragraphs.find(element => element.getBoundingClientRect().bottom > box.top && element.getBoundingClientRect().top < box.bottom);
    return { paragraph: anchor?.textContent?.match(/【第\d+段】/)?.[0], offset: anchor ? anchor.getBoundingClientRect().top - box.top : null, scrollTop: viewport.scrollTop, remaining: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight, fontSize: anchor && getComputedStyle(anchor).fontSize, projectId: document.querySelector('[data-testid="areal-workbench"]').dataset.projectId, threadId: document.querySelector('[data-testid="areal-workbench"]').dataset.threadId };
  });
  await input().fill("appearance: 请生成项目阅读简报，按段落说明任务安排。");
  await page.getByTestId("chat-send-button").click();
  const completed = await until(snapshot => Object.values(project(snapshot).state.threads).some(thread => thread.turns?.at(-1)?.status === "completed"), "appearance reply completed");
  const thread = Object.values(project(completed).state.threads).find(thread => thread.turns?.length);
  setThread(thread.id);
  await page.locator(".assistant-message .conversation-markdown p").filter({ hasText: "【第48段】" }).waitFor();
  await input().fill(draft);
  await openAppearance();
  const baseline = { name: "light-wide-14-14", dark: false, width: 1440, ui: 14, content: 14 };
  visualEvidence.push({ stage: "appearance-baseline-settings", condition: baseline, settings: await setAppearance(baseline) });
  await fullShot("appearance-baseline-settings");
  await button("返回应用").click();
  const viewport = page.locator(".messages");
  const box = await viewport.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const target = await page.locator(".assistant-message .conversation-markdown p").filter({ hasText: "【第24段】" }).evaluate(element => element.getBoundingClientRect().top);
  await page.mouse.wheel(0, target - box.y - 80);
  await page.waitForFunction(() => document.querySelector(".messages").scrollTop > 0);
  await page.waitForFunction(() => document.querySelector(".messages").scrollHeight - document.querySelector(".messages").scrollTop - document.querySelector(".messages").clientHeight > 500);
  await fullShot("appearance-baseline-reading");
  let before = await readView();
  assert.ok(before.paragraph && before.remaining > 500, "reader starts inside numbered long Markdown");
  const requests = received.length;
  const turns = thread.turns.length;
  for (const condition of [
    { name: "light-wide-14-18", dark: false, width: 1440, ui: 14, content: 18 },
    { name: "dark-wide-18-18", dark: true, width: 1440, ui: 18, content: 18 },
    { name: "dark-narrow-18-24", dark: true, width: 980, ui: 18, content: 24 },
    { name: "light-narrow-18-14", dark: false, width: 980, ui: 18, content: 14 },
    { name: "light-narrow-18-14-repeat", dark: false, width: 980, ui: 18, content: 14 },
  ]) {
    if (condition.content === 14 && before.fontSize === "24px") {
      const paragraph = page.locator(".assistant-message .conversation-markdown p").filter({ hasText: before.paragraph });
      const height = await paragraph.evaluate(element => element.getBoundingClientRect().height);
      const box = await viewport.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, before.offset + height - 8);
      await page.waitForFunction(({ text, offset }) => {
        const viewport = document.querySelector(".messages").getBoundingClientRect();
        const paragraph = [...document.querySelectorAll(".assistant-message .conversation-markdown p")].find(element => element.textContent.startsWith(text));
        return Math.abs(paragraph.getBoundingClientRect().top - viewport.top - offset) < 2;
      }, { text: before.paragraph, offset: 8 - height });
      before = await readView();
      assert.ok(before.offset < -100, "large-text reader is deep enough within the paragraph to exercise downsizing");
      await fullShot("appearance-before-paragraph-downsize");
    }
    await openAppearance();
    await app.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960), condition.width);
    const settings = await setAppearance(condition);
    visualEvidence.push({ stage: "appearance-settings", condition, settings });
    assert.equal(settings.previewSize, `${condition.content}px`, "actual reading preview applies content size immediately while settings stay open");
    assert.equal(settings.navigationSize, `${condition.ui}px`, "actual settings navigation applies interface size immediately");
    assert.equal(settings.savedContent, condition.content, "content preference persists through its real owner");
    assert.equal(settings.savedUi, String(condition.ui), "interface preference persists through its real owner");
    await fullShot(`appearance-${condition.name}-settings`);
    const back = button("返回应用");
    await back.focus();
    await page.keyboard.press("Enter");
    await input().waitFor();
    assert.equal(await button("设置").evaluate(element => element === document.activeElement), true, "keyboard return restores focus to settings trigger");
    await page.waitForFunction(() => !!document.querySelector(".assistant-message .conversation-markdown p"));
    const after = await readView();
    visualEvidence.push({ stage: "appearance-return", condition, before, after, requests: received.length });
    await fullShot(`appearance-${condition.name}-return`);
    assert.equal(after.projectId, before.projectId, "appearance return preserves project");
    assert.equal(after.threadId, before.threadId, "appearance return preserves thread");
    assert.equal(await input().innerText(), draft, "appearance return preserves unsent Chinese draft");
    assert.equal(project(await state()).state.threads[thread.id].turns.length, turns, "appearance changes create no turn");
    assert.equal(received.length, requests, "appearance changes send no model request");
    assert.equal(after.fontSize, `${condition.content}px`, "actual conversation applies content size");
    assert.equal(after.paragraph, before.paragraph, "appearance return preserves visible numbered reading paragraph");
    const anchorHeight = await page.locator(".assistant-message .conversation-markdown p").filter({ hasText: before.paragraph }).evaluate(element => element.getBoundingClientRect().height);
    assert.ok(Math.abs(after.offset - Math.max(1 - anchorHeight, before.offset)) <= 2, "appearance return preserves reading paragraph viewport offset within resized paragraph");
    assert.ok(after.remaining > 120, "appearance return preserves reading intent away from tail");
    before = after;
  }
  await button("滚动到底部").click();
  await page.waitForFunction(() => { const element = document.querySelector(".messages"); return element.scrollHeight - element.scrollTop - element.clientHeight < 2; });
  await openAppearance();
  await setAppearance(baseline);
  await button("返回应用").click();
  assert.ok((await readView()).remaining < 2, "tail following survives settings return separately from history reading");
  await openAppearance();
  const persisted = { name: "light-narrow-18-24", dark: false, width: 980, ui: 18, content: 24 };
  await setAppearance(persisted);
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await openAppearance();
  assert.equal(await page.getByRole("spinbutton", { name: "界面字号", exact: true }).inputValue(), "18", "interface size survives reload");
  const content = page.getByRole("spinbutton", { name: "内容字号", exact: true });
  if (!await content.isVisible()) await page.locator("summary").filter({ hasText: "阅读与代码" }).click();
  assert.equal(await content.inputValue(), "24", "content size survives reload");
  assert.equal(await page.getByRole("combobox", { name: "界面主题", exact: true }).innerText(), "浅色", "theme survives reload");
  await fullShot("appearance-persisted-settings");
  await button("返回应用").click();
  assert.equal(await input().innerText(), draft, "unsent draft survives reload");
  assert.equal(received.length, requests, "reload and settings do not resend task");
  checks.push("real appearance settings immediately apply theme and independent sizes, persist after reload, preserve task, Chinese draft, semantic reading anchor and separate tail intent");
}
