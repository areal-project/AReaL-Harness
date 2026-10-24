import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Browser acceptance across the production process projection, resource dialog,
// child pane and reading owners. No provider or Core is substituted inside them.
export async function runConversationExercise(page, scratch, gui, report) {
  Object.assign(report, {
    id: "conversation-flow",
    questionId: "Q-CONVERSATION-COMPOSITE-06",
    inputSnapshot: "d817751e",
    candidateVersion: JSON.parse(await readFile(join(gui, "design-system/registry.json"), "utf8"))
      .baseCandidate.version,
    briefSha256: createHash("sha256")
      .update(await readFile(join(gui, "design-system/surfaces/conversation-flow.json")))
      .digest("hex"),
    gaps: [
      "authored fixture arrival, no Core or real commands",
      "reference and implementation are distinct runs; state comparison is not pixel equivalence",
      "no Electron/native/provider/package/reconnect acceptance",
    ],
    events: [],
  });
  page.setDefaultTimeout(10000);
  // Modal intentionally hides the background from AX; telemetry still reads
  // the mounted parent DOM while user actions remain scoped to the dialog.
  const region = page.locator("#conversation-flow-exercise");
  const main = region.locator(".design-preview-flow-chat");
  const messages = main.locator(".messages");
  const latest = () => messages.locator('[data-latest-turn="true"]');
  const command = () => latest().locator('[data-tool-id="flow-command"]');
  const image = () => latest().locator('[data-tool-id="flow-image"]');
  const child = () => region.locator('[data-agent-conversation="fixture-summary"]');
  const final = () => latest().locator('[data-side-item-id="flow-final"]');
  const advance = async (step) => {
    await region.getByRole("button", { name: "下一事件", exact: true }).click();
    await page.waitForFunction(
      (n) =>
        document.querySelector("#conversation-flow-exercise").dataset.scenarioStep === String(n),
      step,
    );
  };
  const expandActivities = async () => {
    for (const button of await latest()
      .locator(".areal-activity-group > .areal-disclosure > button")
      .all())
      if ((await button.getAttribute("aria-expanded")) === "false") await button.click();
  };
  const snapshot = async (id, action, reference = null) => {
    // Hold only after the caller's semantic predicate, so video states are
    // readable. This delay never establishes that an action completed.
    await page.waitForTimeout(450);
    const metrics = await messages.evaluate((el) => ({
      top: el.scrollTop,
      height: el.clientHeight,
      full: el.scrollHeight,
      gap: el.scrollHeight - el.clientHeight - el.scrollTop,
      width: el.clientWidth,
      contentFont: getComputedStyle(el.querySelector(".assistant-message")).fontSize,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      reducedMotion: document.documentElement.dataset.reducedMotion,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      now: performance.now(),
      running: !!el.querySelector("[data-latest-turn=true][data-turn-status=inProgress]"),
      text: el.querySelector('[data-side-item-id="flow-final"]')?.textContent?.length ?? 0,
    }));
    const state = await region.evaluate((el) => ({
      step: Number(el.dataset.scenarioStep),
      playing: el.dataset.playing,
      command: el.querySelector('[data-tool-id="flow-command"]')?.getAttribute("data-tool-status"),
      child: el.querySelector(".agent-conversation-heading [role=status]")?.textContent,
      panel: !!el.querySelector("[data-agent-conversation]"),
    }));
    await page.screenshot({ path: join(scratch, `${id}.png`), animations: "disabled" });
    report.events.push({ id, action, reference, hostTime: Date.now(), metrics, state });
    const coverage = await region.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth
        ? "captured"
        : "partial";
    });
    report.steps.push({
      id,
      action,
      screenshot: { path: `${id}.png`, status: coverage },
      metrics,
      state,
    });
    await writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(report, null, 2));
    return metrics;
  };
  const send = async () => {
    await region.getByRole("button", { name: "发送", exact: true }).click();
    await latest().locator('[data-tool-id="flow-read"]').waitFor();
  };
  const reset = async () => {
    await region.getByRole("button", { name: "重置题目", exact: true }).click();
    await region.getByRole("button", { name: "发送", exact: true }).waitFor();
  };
  await page.getByLabel("主题", { exact: true }).selectOption("dark");
  await page.getByRole("checkbox", { name: "减少动态效果", exact: true }).uncheck();
  await region.getByRole("button", { name: "暂停演示", exact: true }).click();
  await snapshot("00-ready", "fresh fixture, meaningful task prefilled");
  await send();
  assert.equal(await main.getByRole("button", { name: "停止演示任务", exact: true }).count(), 1);
  assert.ok(
    await messages.locator(".message-response-space").evaluate((el) => el.clientHeight > 0),
  );
  await snapshot(
    "01-accepted",
    "accepted through production composer; read starts",
    "run2/01-sent.png",
  );
  await advance(2);
  await expandActivities();
  await command().locator(".tool-summary-row").first().click();
  await command().getByRole("button", { name: "展开完整命令", exact: true }).click();
  await latest().getByRole("button", { name: "打开 fixture-summary 子对话", exact: true }).click();
  await child().waitFor();
  assert.equal(
    await child().locator(".agent-conversation-heading [role=status]").innerText(),
    "执行中",
  );
  assert.equal(await command().getAttribute("data-tool-status"), "执行中");
  const parentNode = await messages.elementHandle();
  await snapshot(
    "02-parallel",
    "open actual child pane while parent command runs",
    "run2/02-live.png + run2/08-subagent.png (distinct reference states)",
  );
  await advance(3);
  assert.ok(
    (await command().getByLabel("工具结果", { exact: true }).innerText()).includes("Apples: 12"),
  );
  assert.equal(
    await command().getByRole("button", { name: "收起完整命令", exact: true }).count(),
    1,
  );
  await snapshot(
    "03-command-output",
    "first process output page arrives without new command card",
    "run2/09-command.png (terminal reference; live page ordering is authored)",
  );
  assert.equal(
    await latest().locator('[data-tool-id="flow-output-1"]').count(),
    0,
    "poll belongs to its process, not a second command",
  );
  await advance(4);
  await region.getByRole("button", { name: "返回主对话", exact: true }).click();
  assert.equal(await image().getByText("已查看 1 张图片", { exact: true }).isVisible(), true);
  const imageToggle = image().getByRole("button", { name: "已查看 1 张图片", exact: true });
  assert.equal(await imageToggle.getAttribute("aria-expanded"), "false", "tool image starts collapsed independently of its group");
  await imageToggle.click();
  const imagePreview = image().getByRole("button", { name: "预览图片 工具图片", exact: true });
  await imagePreview.waitFor();
  const imageRecord = image().getByRole("button", { name: "查看工具原始记录", exact: true });
  assert.equal(await imageRecord.getAttribute("aria-expanded"), "false");
  await imageRecord.click();
  assert.equal(await imageRecord.getAttribute("aria-expanded"), "true");
  assert.match(await image().getByLabel("工具参数", { exact: true }).innerText(), /inspect_image/);
  await imageRecord.click();
  assert.equal(await imageRecord.getAttribute("aria-expanded"), "false");
  assert.equal(
    await imagePreview.isVisible(),
    true,
    "image preview remains available when its raw record is collapsed",
  );
  await region.getByRole("button", { name: "继续演示", exact: true }).click();
  await imagePreview.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(
    await dialog.locator("img").evaluate((el) => el.complete && el.naturalWidth === 960),
    true,
  );
  const inspection = dialog.getByRole("region", { name: "图片查看区域", exact: true });
  const scale = dialog.getByLabel("图片缩放比例", { exact: true });
  await scale.waitFor();
  const initialImageWidth = await dialog.locator("img").evaluate(el => el.getBoundingClientRect().width);
  await dialog.getByRole("button", { name: "放大图片", exact: true }).click();
  assert.ok(await dialog.locator("img").evaluate(el => el.getBoundingClientRect().width) > initialImageWidth);
  await dialog.getByRole("button", { name: "实际大小 100%", exact: true }).click();
  assert.equal(await scale.innerText(), "100%");
  assert.equal(Math.round(await dialog.locator("img").evaluate(el => el.getBoundingClientRect().width)), 960);
  for (let i = 0; i < 5; i++) await dialog.getByRole("button", { name: "放大图片", exact: true }).click();
  assert.equal(await inspection.evaluate(el => el.scrollWidth > el.clientWidth), true, "large image remains scrollable rather than clipped");
  await inspection.hover();
  const beforePan = await inspection.evaluate(el => el.scrollLeft);
  await page.mouse.wheel(180, 0);
  await page.waitForFunction(left => document.querySelector('[aria-label="图片查看区域"]').scrollLeft > left, beforePan);
  await snapshot("04b-image-zoomed", "zoomed image pans within its own scroll owner");
  await dialog.getByRole("button", { name: "适应窗口", exact: true }).click();
  assert.equal(await inspection.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1), true);
  await snapshot("04-image-open", "production media adapter, fit/actual scale/zoom/pan and image dialog", "run2/06-image.png");
  await page.waitForFunction(
    () => Number(document.querySelector("#conversation-flow-exercise").dataset.scenarioStep) >= 5,
  );
  await dialog.getByRole("button", { name: "关闭图片预览", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await command().getAttribute("data-tool-status"), "已完成");
  assert.equal(
    await messages.evaluate((el, node) => el === node, parentNode),
    true,
    "parent reading owner stays mounted",
  );
  assert.equal(
    await imagePreview.evaluate((el) => el === document.activeElement),
    true,
    "closing image restores trigger focus",
  );
  await region.getByRole("button", { name: "暂停演示", exact: true }).click();
  await region.getByRole("button", { name: "打开子代理面板", exact: true }).click();
  assert.equal(
    await child().locator(".agent-conversation-heading [role=status]").innerText(),
    "执行中",
    "command completion does not finish child",
  );
  assert.ok(
    (await command().getByLabel("工具结果", { exact: true }).innerText()).includes("Fruit: 32"),
  );
  await snapshot(
    "05-command-done-child-working",
    "command exit0, child still running; resource return preserved parent",
  );
  await advance(6);
  await child().locator(".assistant-message-final").waitFor();
  assert.equal(
    await child().locator(".agent-conversation-heading [role=status]").innerText(),
    "已完成",
  );
  assert.equal(
    await latest().locator(".assistant-message-final").count(),
    0,
    "child completion is separate from parent final",
  );
  await snapshot(
    "06-child-completed",
    "child final rendered in independent production conversation",
    "run2/08-subagent.png",
  );
  await region.getByRole("button", { name: "返回主对话", exact: true }).click();
  await advance(7);
  await final().waitFor();
  await messages.hover({ position: { x: 50, y: 50 } });
  const oldVisible = () => {
    const el = document.querySelector(".design-preview-flow-chat .messages"),
      r = el.getBoundingClientRect();
    return [...el.querySelectorAll('[data-side-item-id="flow-history"] p')].some((p) => {
      const b = p.getBoundingClientRect();
      return b.top > r.top + 10 && b.bottom < r.bottom - 10;
    });
  };
  for (let i = 0; i < 8 && !(await page.evaluate(oldVisible)); i++) {
    const before = await messages.evaluate((el) => el.scrollTop);
    await page.mouse.wheel(0, -700);
    await page.waitForFunction(
      (top) => document.querySelector(".design-preview-flow-chat .messages").scrollTop < top - 1,
      before,
    );
  }
  assert.equal(await page.evaluate(oldVisible), true);
  const anchor = await messages.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const p = [...el.querySelectorAll('[data-side-item-id="flow-history"] p')].find((p) => {
      const b = p.getBoundingClientRect();
      return b.top > r.top + 10 && b.bottom < r.bottom - 10;
    });
    return { text: p.textContent, top: p.getBoundingClientRect().top - r.top };
  });
  const lengths = [];
  for (const step of [8, 9]) {
    await advance(step);
    const m = await snapshot(
      `07-history-${step}`,
      "same visible history while parent final grows",
      "dynamic/retry2 (separate reference run)",
    );
    const top = await messages.evaluate(
      (el, text) =>
        [...el.querySelectorAll('[data-side-item-id="flow-history"] p')]
          .find((p) => p.textContent === text)
          .getBoundingClientRect().top - el.getBoundingClientRect().top,
      anchor.text,
    );
    assert.ok(Math.abs(top - anchor.top) <= 2);
    assert.equal(m.running, true);
    lengths.push(m.text);
    report.events.push({ id: `anchor-${step}`, text: anchor.text, top });
  }
  assert.ok(lengths[1] > lengths[0]);
  await main.getByRole("button", { name: "滚动到底部", exact: true }).click();
  const atBottom = () => {
    const el = document.querySelector(".design-preview-flow-chat .messages");
    return el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
  };
  await page.waitForFunction(atBottom);
  let followedLength = await final()
    .innerText()
    .then((text) => text.length);
  for (const step of [10, 11]) {
    await advance(step);
    await page.waitForFunction(atBottom);
    const sample = await snapshot(
      `08-following-${step}`,
      "explicit latest then further final increments follow",
    );
    assert.ok(sample.text > followedLength);
    followedLength = sample.text;
  }
  await advance(12);
  await latest().locator(".turn-progress-body[hidden]").waitFor({ state: "attached" });
  assert.equal(await latest().locator(".assistant-message-final").isVisible(), true);
  assert.equal(await latest().locator(".turn-progress-body .assistant-message-final").count(), 0);
  assert.ok((await final().innerText()).includes("共 32 个水果"));
  const total = () => latest().getByRole("button", { name: "执行过程：Working for 36s", exact: true });
  // Frame the settled disclosure through the real reading owner. A DOM jump
  // can be counteracted by response-space layout and is not a reader action.
  await messages.hover({ position: { x: 40, y: 40 } });
  for (let i = 0; i < 6; i++) {
    if (await total().evaluate(el => { const r = el.getBoundingClientRect(), box = el.closest('.messages').getBoundingClientRect(); return r.top >= box.top && r.bottom < box.bottom - 150; })) break;
    const before = await messages.evaluate(el => el.scrollTop);
    await page.mouse.wheel(0, -180);
    await page.waitForFunction(top => document.querySelector('.design-preview-flow-chat .messages').scrollTop < top - 1, before);
  }
  assert.equal(await total().evaluate(el => { const r = el.getBoundingClientRect(), box = el.closest('.messages').getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; }), true, "completed aggregate is visibly framed with its final");
  await snapshot(
    "09-completed-collapsed",
    "all activities settle; parent final stays independent",
    "run2/11-final-overview.png",
  );
  await total().click();
  await expandActivities();
  assert.equal(
    await command().getByRole("button", { name: "收起完整命令", exact: true }).isVisible(),
    true,
  );
  await command().scrollIntoViewIfNeeded();
  await snapshot(
    "10-completed-expanded",
    "reopen same command after process aggregation and parent convergence",
    "run2/04-completed-expanded.png + run2/09-command.png",
  );
  await latest().getByRole("button", { name: "打开 fixture-summary 子对话", exact: true }).click();
  await child().locator(".assistant-message-final").waitFor();
  await snapshot(
    "11-revisit-child",
    "revisit completed child without execution",
    "run2/08-subagent.png",
  );
  await region.getByRole("button", { name: "返回主对话", exact: true }).click();
  await total().click();
  await region.locator(".design-preview-flow-diagnostics summary").click();
  assert.ok(
    (await region.getByLabel("本地调用记录", { exact: true }).innerText())
      .split(", ")
      .every((name) => /^(open|media):/.test(name) || name === "feedback:status"),
    "inspection only reads child/media and feedback availability",
  );
  report.checks.push(
    "one continuous composite run: command pages aggregate; parent/child run independently; image modal and child pane work; parent identity and command disclosure survive return and completion",
  );
  report.checks.push(
    "real wheel reaches stable visible history anchor while final grows; explicit latest resumes following; final remains outside settled process",
  );
  for (const scenario of ["失败", "未知", "未结算"]) {
    await region.getByRole("button", { name: `${scenario}反例`, exact: true }).click();
    await latest().locator(".turn-progress-body").waitFor();
    assert.equal(
      await command().getAttribute("data-tool-status"),
      scenario === "失败" ? "失败" : "结果待确认",
    );
    assert.equal(await latest().locator(".turn-progress-body").isVisible(), true);
    assert.equal(await latest().locator(".areal-activity-status").filter({ hasText: scenario === "失败" ? "工具失败" : "结果待确认" }).first().isVisible(), true, "exception remains discoverable outside the collapsed group");
    await expandActivities();
    await command().scrollIntoViewIfNeeded();
    await snapshot(`12-${scenario}`, "independent exception does not silently converge");
  }
  await region.getByRole("button", { name: "未知反例", exact: true }).click();
  await region.getByRole("button", { name: "核查 UNKNOWN", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "刷新原记录", exact: true }).click();
  await page.getByText(/刷新失败，仍显示上次记录/).waitFor();
  await page.getByRole("button", { name: "取消核查", exact: true }).click();
  const unknownCalls = (
    await region.getByLabel("本地调用记录", { exact: true }).innerText()
  ).split(", ");
  const parentReads = unknownCalls.filter((name) => name.startsWith("open:"));
  assert.equal(parentReads.length, 1, "unknown refresh reads the original parent once");
  assert.match(parentReads[0], /^open:flow-preview-\d+$/);
  assert.ok(
    unknownCalls.every((name) =>
      name === parentReads[0] ||
      name === `media:${parentReads[0].slice(5)}` ||
      name === "feedback:status"),
    "unknown inspection only reads the parent, its image and feedback availability, never resubmits",
  );
  assert.equal(await command().getAttribute("data-tool-status"), "结果待确认");
  report.checks.push("UNKNOWN inspection read failure preserves original result without resubmission");
  for (const [theme, font, width] of [
    ["light", "14", "wide"],
    ["dark", "18", "narrow"],
  ]) {
    await reset();
    await page.setViewportSize({ width: 1509, height: width === "narrow" ? 1200 : 949 });
    await page.getByLabel("主题", { exact: true }).selectOption(theme);
    await page.getByLabel("字号", { exact: true }).selectOption(font);
    await page.getByLabel("面板宽度", { exact: true }).selectOption(width);
    await page.getByRole("checkbox", { name: "减少动态效果", exact: true }).check();
    await send();
    await advance(2);
    await region.getByRole("button", { name: "打开子代理面板", exact: true }).click();
    await child().waitFor();
    assert.equal(await messages.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    assert.equal(await child().evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    await snapshot(
      `13-${theme}-${font}-${width}-child`,
      "representative panel layout and font conditions",
    );
    await region.getByRole("button", { name: "返回主对话", exact: true }).click();
    await region.getByRole("button", { name: "投影完成", exact: true }).click();
    await latest().locator(".turn-progress-body[hidden]").waitFor({ state: "attached" });
    await total().focus();
    await page.keyboard.press("Enter");
    assert.equal(await total().getAttribute("aria-expanded"), "true");
    await expandActivities();
    await command().locator(".tool-summary-row").first().click();
    assert.equal(
      await command().getByRole("button", { name: "展开完整命令", exact: true }).count(),
      1,
      "fresh run has fresh command disclosure",
    );
    assert.equal(
      await messages.evaluate(
        (el) => getComputedStyle(el.querySelector(".assistant-message")).fontSize,
      ),
      `${font}px`,
    );
    assert.equal(await messages.evaluate((el) => el.scrollWidth > el.clientWidth + 1), false);
    await snapshot(
      `14-${theme}-${font}-${width}-complete`,
      "independent completion, keyboard and no horizontal overflow",
    );
  }
  report.checks.push(
    "failed/unknown/unsettled counterexamples; fresh disclosure; light14 wide and dark18 narrow reduced-motion; child panel return and keyboard disclosure",
  );
  await reset();
  await page.setViewportSize({ width: 1509, height: 949 });
  await page.getByLabel("字号", { exact: true }).selectOption("14");
  await page.getByLabel("面板宽度", { exact: true }).selectOption("wide");
  await region.getByRole("button", { name: "继续演示", exact: true }).click();
  await send();
  await page.waitForFunction(
    () => Number(document.querySelector("#conversation-flow-exercise").dataset.scenarioStep) >= 3,
  );
  await region.getByRole("button", { name: "暂停演示", exact: true }).click();
  assert.equal(await region.getAttribute("data-playing"), "false");
  await main.getByRole("button", { name: "停止演示任务", exact: true }).click();
  assert.equal(await latest().getAttribute("data-turn-status"), "interrupted");
  await snapshot("15-autoplay-stopped", "timer-driven arrivals and explicit fixture stop");
  report.checks.push(
    "automatic arrival reaches parallel execution; pause and stop do not submit Core work",
  );
  await writeFile(join(scratch, "exercise-steps.json"), JSON.stringify(report, null, 2));
}
