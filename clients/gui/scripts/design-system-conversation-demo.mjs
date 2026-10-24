import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Same fixed parent fixture as the existing catalog. Actual production controls
// own disclosure, resources and reading; no Core or provider is connected.
export async function runConversationDemo(page, scratch, checks) {
  page.setDefaultTimeout(10000);
  const states = [];
  const capture = async id => {
    await page.screenshot({ path: join(scratch, id + ".png") });
    const facts = await page.locator("#conversation-timeline").evaluate(el => {
      const r = el.getBoundingClientRect();
      const input = el.querySelector('[data-testid="timeline-composer"]');
      return { state: el.getAttribute("data-demo-state"), width: r.width, height: r.height, viewport: [innerWidth, innerHeight], theme: document.documentElement.classList.contains("dark") ? "dark" : "light", draft: input?.textContent };
    });
    states.push({ id, wall: Date.now(), facts });
    await writeFile(join(scratch, "demo-states.json"), JSON.stringify(states, null, 2));
  };
  const timeline = page.getByRole("region", { name: "对话时间线预览", exact: true });
  await capture("01-completed");
  const earlier = timeline.locator('[data-side-item-id="timeline-progress"]');
  // CONV-GROUP-01统一完成过程；原先“phased短过程始终外露”的预期已被新合同替换。
  const aggregate = timeline.getByRole("button", { name: "执行过程：Working for 19s", exact: true });
  assert.equal(await aggregate.getAttribute("aria-expanded"), "false");
  assert.equal(await earlier.isVisible(), false, "normal completed commentary follows the aggregate default");
  assert.equal(await timeline.locator('[data-side-item-id="timeline-final"]').isVisible(), true);
  assert.equal(await timeline.locator('.turn-progress-body [data-side-item-id="timeline-final"]').count(), 0);
  await aggregate.click();
  assert.equal(await earlier.isVisible(), true, "aggregate restores original short commentary");
  const longProgress = timeline.locator('[data-side-item-id="timeline-long-progress"]');
  assert.equal(await longProgress.locator(".collapsible-text-viewport").count(), 0, "commentary stays fully readable in the process group");
  assert.equal(await longProgress.getByRole("button", { name: "展开全文", exact: true }).count(), 0);
  assert.ok((await longProgress.innerText()).includes("检查记录 10"));
  const activity = timeline.locator(".areal-activity-group > .areal-disclosure > button").first();
  if (await activity.getAttribute("aria-expanded") !== "true") await activity.click();
  const imageToggle = timeline.getByRole("button", { name: "已查看 1 张图片", exact: true });
  assert.equal(await imageToggle.isVisible(), true, "image records are discoverable after opening their activity group");
  await imageToggle.click();
  await timeline.getByRole("button", { name: "预览图片 工具图片", exact: true }).waitFor();
  await timeline.getByRole("button", { name: "预览图片 工具图片", exact: true }).click();
  await page.getByRole("button", { name: "关闭图片预览", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await imageToggle.waitFor();
  const child = timeline.getByRole("button", { name: "打开 preview-child 子对话", exact: true });
  assert.ok((await child.innerText()).includes("检查消息投影"));
  assert.ok((await child.innerText()).includes("已完成"));
  await capture("02-expanded");
  const draft = timeline.getByTestId("timeline-composer");
  await draft.fill("保留未发送草稿");
  const parentMessages = timeline.locator('.design-preview-flow-chat .messages').first();
  const parentNode = await parentMessages.elementHandle();
  await child.scrollIntoViewIfNeeded();
  const priorAnchor = await child.boundingBox();
  await child.click();
  await timeline.locator('[data-agent-conversation="preview-child"]').waitFor();
  await timeline.getByText("已核对消息投影：过程、工具结果和最终回答分别保留。此处为固定演示内容。", { exact: true }).waitFor();
  await capture("03-child");
  await timeline.getByRole("button", { name: "返回主对话", exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '打开 preview-child 子对话');
  assert.equal(await child.evaluate(el => el === document.activeElement), true);
  assert.equal(await parentMessages.evaluate((el, prior) => el === prior, parentNode), true, "resource return keeps parent Messages mounted");
  const returnedAnchor = await child.boundingBox();
  assert.ok(Math.abs(priorAnchor.y - returnedAnchor.y) < 1, "resource return preserves the visible parent entry");
  assert.equal(await draft.innerText(), "保留未发送草稿");
  assert.equal(await timeline.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
  if (await activity.getAttribute("aria-expanded") !== "true") await activity.click();
  const command = timeline.locator('[data-tool-id="timeline-command"]');
  await command.getByRole("button").click();
  await command.getByLabel("工具结果", { exact: true }).waitFor();
  assert.ok((await command.getByLabel("工具结果", { exact: true }).innerText()).includes("类型检查通过"));
  const scrollOwners = await command.locator(".command-card").evaluate(el => ({
    output: getComputedStyle(el.querySelector(".command-output")).overflowY,
    group: getComputedStyle(el.closest(".areal-activity-list")).overflowY,
  }));
  assert.equal(scrollOwners.output, "auto");
  assert.equal(scrollOwners.group, "auto", "expanded groups retain the approved bounded vertical activity list");
  await capture("04-command");
  const fileSummary = timeline.getByTestId("turn-file-summary");
  assert.equal(await fileSummary.isVisible(), true);
  assert.ok((await fileSummary.innerText()).includes("7 个文件已更改"));
  assert.equal(await timeline.getByRole("region", { name: "本轮文件", exact: true }).isVisible(), true);
  await timeline.getByLabel("合计新增 7 行，删除 7 行", { exact: true }).waitFor();
  assert.equal(await timeline.getByLabel("合计新增 7 行，删除 7 行", { exact: true }).count(), 1);
  await timeline.getByRole("button", { name: "查看变更", exact: true }).click();
  await timeline.getByRole("region", { name: "文件变更预览", exact: true }).waitFor();
  await timeline.getByRole("button", { name: "返回主对话", exact: true }).click();
  for (const toggle of await timeline.locator(".areal-activity-group > .areal-disclosure > button").all())
    if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
  await timeline.locator('[data-tool-id="timeline-write"]').getByRole("button", { name: "打开 src/conversation.tsx", exact: true }).click();
  await timeline.getByRole("region", { name: "文件内容预览", exact: true }).waitFor();
  await capture("05-file");
  await timeline.getByRole("button", { name: "返回主对话", exact: true }).click();
  await timeline.getByRole("button", { name: "显示执行中", exact: true }).click();
  assert.equal(await timeline.getByTestId("turn-file-summary").count(), 0, "running turns do not claim completed file totals");
  assert.equal(await timeline.locator('[data-side-item-id="timeline-stream"] .collapsible-text').count(), 0, "public reasoning after the current streamed reply does not fold that reply");
  await capture("06-running");
  await timeline.getByRole("button", { name: "显示已完成", exact: true }).click();
  assert.equal(await longProgress.getByRole("button", { name: "展开全文", exact: true }).count(), 0, "completion retains full commentary");
  assert.ok((await longProgress.innerText()).includes("检查记录 10"));
  assert.ok((await timeline.locator('[data-side-item-id="timeline-final"]').innerText()).includes("最终回答保留完整内容"));
  checks.push("phased timeline groups completed progress, preserves full commentary, and exposes collapsed images, named agents, command output and verified file totals with bounded vertical activity scrolling");
  assert.equal(await draft.innerText(), "保留未发送草稿");
  for (const theme of ["light", "dark"]) {
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page.getByLabel("面板宽度", { exact: true }).selectOption("narrow");
    await child.click();
    await timeline.locator('[data-agent-conversation="preview-child"]').waitFor();
    const pane = timeline.getByRole("complementary", { name: "对话详情面板", exact: true });
    assert.equal(await pane.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await capture(`07-narrow-${theme}`);
    await timeline.getByRole("button", { name: "返回主对话", exact: true }).click();
    assert.equal(await draft.innerText(), "保留未发送草稿");
  }
  await page.getByLabel("面板宽度", { exact: true }).selectOption("wide");
  checks.push("conversation demo mounts real child/file/diff panels, restores focus/draft, and keeps narrow light/dark returns reachable without submission");
}
