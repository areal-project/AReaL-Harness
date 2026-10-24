import assert from "node:assert/strict";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { captureConversationMotion } from "./conversation-motion.mjs";

// Scenario for migration-smoke's real Electron/Core/Runtime launcher. Only the
// external model is deterministic; no renderer state or execution is injected.
export function conversationJourney(scratch, workspace, { motion = false, stage2 = false, production = false } = {}) {
  const events = [], held = new Map();
  const projectOf = snapshot => snapshot.projects.find(project => project.root === workspace);
  let processId, parentStage = 0, firstOutputRead = false, toolRound = 0;
  const mark = (kind, data = {}) => events.push({ id: events.length + 1, kind, hostTime: Date.now(), ...data });
  const paragraph = n => `### ${n}. 水果记录\n\n苹果十二个，梨七个。另一组苹果四个，梨九个。合计苹果十六个，梨十六个，共三十二个。每一项都可以回到原始记录核对；这段合成内容只用于检查历史阅读位置和持续输出。\n\n`;
  const finish = (send, res, text) => { if (text) send({ content: text }); send({}, "stop"); res.end("data: [DONE]\n\n"); };
  const tools = (send, res, calls) => {
    const round = ++toolRound;
    send({ tool_calls: calls.map(([name, args], index) => ({ index, id: `e1-${round}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
    send({}, "tool_calls"); res.end("data: [DONE]\n\n");
  };
  const findProcess = value => {
    if (typeof value === "string") { try { return findProcess(JSON.parse(value)); } catch { return undefined; } }
    if (!value || typeof value !== "object") return undefined;
    if (typeof value.processId === "string") return value.processId;
    for (const child of Object.values(value)) { const id = findProcess(child); if (id) return id; }
  };
  function model(text, messages, send, res) {
    // image_read adds a synthetic multimodal user message; route by the actual scenario input.
    const scenario = messages.filter(message => message.role === "user").map(message => typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("\n")).findLast(value => /^E1_/.test(value));
    if (scenario) text = scenario;
    if (!text.includes("E1_")) return false;
    mark("model", { text, parentStage, toolResults: messages.filter(m => m.role === "tool") });
    if (text.includes("E1_HISTORY")) { finish(send, res, Array.from({ length: 22 }, (_, n) => paragraph(n + 1)).join("")); return true; }
    if (text.includes("E1_CHILD")) {
      send({ content: "独立子任务正在核对：12 + 4 = 16，7 + 9 = 16。" });
      held.set("child", () => finish(send, res, "\n\n子任务核对完成，共 32 个水果。")); return true;
    }
    if (text.includes("E1_RECOVERY")) {
      send({ content: "恢复检查已开始。" });
      held.set("recovery", () => finish(send, res, "\n\nE1_RECOVERED：后台完成，重开后只读取历史。")); return true;
    }
    if (text.includes("E1_STOP")) {
      if (!messages.slice(messages.findLastIndex(m => m.role === "user" && !(typeof m.content === "string" && m.content.startsWith("AReaL runtime context"))) + 1).some(m => m.role === "tool")) tools(send, res, [["run_command", { argv: ["/bin/sh", "-c", "printf started > e1-stop-started; while :; do sleep 1; done"], timeoutMs: 120000, yieldMs: 10000 }]]);
      else { send({ content: "停止变体仍在执行。" }); held.set("stop", () => finish(send, res)); }
      return true;
    }
    if (text.includes("E1_MAIN")) {
      if (parentStage === 0) {
        parentStage++;
        const dispatch = () => {
        send({ content: "我会运行分批输出的命令，并让独立子任务核对水果数量。" });
        tools(send, res, [["run_command", { argv: ["/bin/sh", "-c", "printf 'Apples: 16\\n'; printf started > e1-command-started; while [ ! -f e1-command-release ]; do sleep 0.1; done; printf 'Pears: 16\\nFruit: 32\\n'; printf finished > e1-command-finished"], timeoutMs: 120000, yieldMs: 150 }], ["agent_spawn", { prompt: "E1_CHILD：独立核对水果数量", intent: "inspect", delivery: "report" }], ["image_read", { path: "fruit.png" }]]);
        };
        if (stage2) held.set("dispatch", dispatch); else dispatch();
      } else if (parentStage === 1) {
        processId = findProcess(messages.filter(m => m.role === "tool"));
        assert.ok(processId, "run_command must return an actual opaque processId");
        if (!firstOutputRead) {
          firstOutputRead = true;
          tools(send, res, [["read_process", { processId, waitMs: 10000, view: "raw" }]]);
          return true;
        }
        send({ content: "命令与子任务已启动；查看图片时它们仍保持各自状态。" });
        held.set("parent", () => { parentStage++; tools(send, res, [["read_process", { processId, waitMs: 10000, view: "raw" }]]); });
      } else if (parentStage >= 3) {
        finish(send, res, "### 汇总结果\n\n命令输出与独立子代理一致：苹果 16 个，梨 16 个，共 32 个。\n\nE1_FINAL_END：已消费子任务结果，原命令与子对话可重访。");
      } else {
        send({ content: "E1_FINAL_BEGIN\n\n" + Array.from({ length: 14 }, (_, n) => paragraph(n + 1)).join("") });
        let chunk = 14;
        if (motion) held.set("drip", async () => {
          const section = ++chunk, text = paragraph(section);
          for (let offset = 0; offset < text.length; offset += 10) {
            send({ content: text.slice(offset, offset + 10) });
            await new Promise(r => setTimeout(r, 55));
          }
          return section;
        });
        held.set("grow", () => { send({ content: paragraph(++chunk) }); return chunk; });
        held.set("complete", () => { parentStage++; finish(send, res, "\n\nE1_FINAL_END：等待合并子任务的权威结果。"); });
      }
      return true;
    }
    return false;
  }
  async function run({ app: getApp, page: getPage, state, call, until, button, launch, quit, received, checks }) {
    let page = getPage();
    const input = () => page.locator('[data-testid="chat-input"]');
    const main = () => page.locator('[data-testid="chat-view"]');
    const messages = () => main().locator(".messages");
    const latest = () => messages().locator('[data-latest-turn="true"]');
    const waitFile = async name => { const end = Date.now() + 30000; while (Date.now() < end) { try { await access(join(workspace, name)); return; } catch {} await new Promise(r => setTimeout(r, 80)); } throw Error("Missing runtime proof " + name); };
    const waitHeld = async key => { const end = Date.now() + 30000; while (!held.has(key) && Date.now() < end) await new Promise(r => setTimeout(r, 80)); assert.ok(held.has(key), `model barrier ${key}`); };
    const release = key => { assert.ok(held.has(key), key); mark("release", { key }); return held.get(key)(); };
    const capture = async (id, action) => {
      // Stage2 compares settled layouts; original video retains the transition.
      if (stage2) await page.waitForFunction(() => !document.querySelector('.work-surface')?.hasAttribute('data-panel-transition'));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const metrics = await messages().evaluate(el => ({ top: el.scrollTop, height: el.clientHeight, full: el.scrollHeight, gap: el.scrollHeight - el.clientHeight - el.scrollTop, now: performance.now(), width: innerWidth, viewportHeight: innerHeight, dpr: devicePixelRatio, theme: document.documentElement.classList.contains("dark") ? "dark" : "light", focus: document.activeElement?.getAttribute("aria-label"), turns: [...el.querySelectorAll("[data-turn-id]")].map(t => ({ id: t.dataset.turnId, status: t.dataset.turnStatus, text: t.textContent.length })) }));
      if (id === "e1-pause") {
        const layout = await latest().locator(".turn-stop-heading").evaluate(el => {
          const rect = e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height, scrollTop: e.scrollTop, scrollHeight: e.scrollHeight, overflow: getComputedStyle(e).overflowY }; };
          const ancestors = []; for (let p = el.parentElement; p; p = p.parentElement) ancestors.push({ tag: p.tagName, class: p.className, ...rect(p) });
          return { heading: rect(el), composer: rect(document.querySelector(".composer-dock")), ancestors, windowScrollY: scrollY };
        });
        mark("pause-layout", layout);
        const native = await getApp().evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString("base64"));
        await writeFile(join(scratch, "e1-pause-native.png"), Buffer.from(native, "base64"));
        assert.ok(layout.heading.bottom > 44 && layout.heading.top < layout.composer.bottom && layout.composer.bottom <= 949, "pause cause and composer stay inside the actual window");
      }
      await page.screenshot({ path: join(scratch, `${id}.png`), scale: "css", animations: "allow" });
      await writeFile(join(scratch, `${id}.aria.txt`), await page.locator("body").ariaSnapshot());
      mark("checkpoint", { id, action, metrics, screenshot: `${id}.png`, state: await state() });
      await writeFile(join(scratch, "journey-events.json"), JSON.stringify(events, null, 2));
      return metrics;
    };
    const send = async text => {
      const before = Object.values(projectOf(await state()).state.threads).reduce((sum, t) => sum + (t.turns?.length || 0), 0);
      if (stage2) { await input().fill(""); await input().click(); await page.keyboard.insertText(text); }
      else await input().fill(text);
      if (stage2 && text.includes("E1_MAIN")) await capture("s2-01-draft", "same draft, attachment and selected model before UI Send");
      mark("send", { text }); await button("发送").click();
      await until(s => Object.values(projectOf(s).state.threads).reduce((sum, t) => sum + (t.turns?.length || 0), 0) > before, "UI send admitted");
      if (stage2 && text.includes("E1_MAIN")) {
        await waitHeld("dispatch");
        await latest().locator('[data-testid="turn-activity"]').waitFor();
        assert.match(await latest().locator('[data-testid="turn-activity"]').innerText(), /Thinking/);
        await capture("s2-02-accepted", "Core accepted the message while the model response barrier is held; no completion inferred");
        release("dispatch");
      }
    };
    const settled = async () => until(s => Object.values(projectOf(s).state.threads).some(t => t.id === mainId && t.turns?.at(-1)?.status === "completed"), "parent complete");
    let mainId, recording;
    const segment = async (name, action, hold) => recording ? recording.segment(name, action, hold) : action();
    try {
      if (stage2) {
        const ready = await until(s => s.projects.some(project => project.root === workspace && project.state?.connected), 'stage2 exact workspace ready');
        await page.waitForFunction(id => document.querySelector('[data-testid="areal-workbench"]')?.getAttribute('data-project-id') === id, projectOf(ready).id);
      }
      await getApp().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1509, 949));
      const host = await getApp().evaluate(({ app, BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const p = w.webContents.getLastWebPreferences(); return { pid: process.pid, version: process.versions, userData: app.getPath("userData"), bounds: w.getBounds(), contentBounds: w.getContentBounds(), preferences: { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration } }; });
      await writeFile(join(scratch, "journey-host.json"), JSON.stringify(host, null, 2));
      mark("run-start", { host, video: await page.video()?.path() });
      if (motion) recording = await captureConversationMotion(page, join(scratch, "motion"), {
        main: '[data-testid="chat-view"] .messages', surface: '.work-surface', side: '.workspace-side-panel',
        composer: '.composer-dock', progress: '[data-latest-turn="true"] .turn-progress-body',
        summary: '[data-latest-turn="true"] .tool-summary-row', command: '[data-latest-turn="true"] .command-motion-panel', pane: '[data-testid="chat-view"]', dialog: '.image-inspection-dialog',
        overlay: '[data-slot="dialog-overlay"]', image: '.image-inspection-canvas img',
        thinking: '.turn-thinking', latest: '.scroll-to-bottom',
      });
      await button("设置").click(); await button("外观").click();
      await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
      await page.getByRole("option", { name: "深色", exact: true }).click();
      await button("返回应用").click();
      await send("E1_HISTORY：保留一段可回看的既有历史。");
      mainId = await page.locator('[data-testid="areal-workbench"]').getAttribute("data-thread-id");
      await settled();
      await capture("e1-00-history", "completed synthetic history through actual UI Send");
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAA8AAAAIcCAIAAAC2P1AsAAARBElEQVR4nO3WMRGAAAADMazhgBk52MAGAjHQvR1yFw//x/XcAAz63hOAQUe9EABE9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQGWiAUfVCABAZaIBR9UIAEBlogFH1QgAQ/UKuMEDU/2auAAAAAElFTkSuQmCC", "base64");
      await writeFile(join(workspace, "fruit.png"), png);
      await page.locator('input[type="file"]').setInputFiles({ name: "fruit.png", mimeType: "image/png", buffer: png });
      await page.locator('[data-testid="composer-attachment"]').waitFor();
      await send("E1_MAIN：运行命令，与子代理并行核对水果数量，并保留图片供查看。参考 https://example.invalid/a https://example.invalid/b https://example.invalid/c");
      await waitFile("e1-command-started"); await waitHeld("parent"); await waitHeld("child");
      const projectId = projectOf(await state()).id;
      const children = (await call("manage", { projectId, parentThreadId: mainId, operation: "agents", limit: 30 })).data;
      assert.equal(children.length, 1); const childId = children[0].id;
      const activityGroup = latest().locator('[data-testid="turn-execution"] .areal-activity-group').first();
      await activityGroup.getByRole("button").first().waitFor();
      assert.equal(await activityGroup.getByRole("button").first().getAttribute("aria-expanded"), "false", "production activities start collapsed");
      await activityGroup.getByRole("button").first().click();
      const commandItem = projectOf(await state()).state.threads[mainId].turns.at(-1).items.find(item => item.type === "dynamicToolCall" && item.tool === "run_command");
      const command = () => latest().locator(`[data-tool-id="${commandItem.id}"]`);
      await command().locator(".tool-summary-row").first().click();
      await command().getByLabel("工具结果", { exact: true }).waitFor();
      assert.match(await command().getByLabel("工具结果", { exact: true }).innerText(), /Apples: 16/, "first stdout observed before command exit");
      const allTools = await latest().locator(".tool-event").count();
      const childTrigger = latest().getByRole("button", { name: `打开 ${childId} 子对话`, exact: true });
      assert.equal(await childTrigger.locator(".agent-spawn-title").innerText(), "E1_CHILD：独立核对水果数量", "child task is identifiable before opening its conversation");
      assert.equal(await childTrigger.locator(".agent-spawn-status").innerText(), "已创建", "a creation receipt is not an unknown operation or a live status claim");
      mark("parallel-identities", { parent: mainId, child: childId, processId, allTools });
      await capture("e1-01-parallel", "actual Runtime command and Core child both in progress");
      if (motion) {
        const toggle = command().locator(".tool-summary-row").first();
        await segment("command-close", () => toggle.click());
        await segment("command-open-reverse", async () => { await toggle.click(); await page.waitForTimeout(50); await toggle.click(); });
        await segment("command-reopen", () => toggle.click());
        await command().getByLabel("工具结果", { exact: true }).waitFor();
      }
      const toolImage = latest().getByRole("button", { name: "已查看 1 张图片", exact: true });
      await toolImage.waitFor();
      assert.equal(await toolImage.getAttribute("aria-expanded"), "false", "tool image is initially collapsed");
      await toolImage.click();
      const toolImagePreview = latest().getByRole("button", { name: "预览图片 工具图片", exact: true });
      await toolImagePreview.click();
      await page.getByRole("dialog").waitFor();
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(await toolImagePreview.evaluate(el => el === document.activeElement), true);
      const imageTrigger = latest().getByRole("button", { name: "预览图片 消息图片", exact: true });
      await segment("image-open", () => imageTrigger.click());
      const dialog = page.getByRole("dialog"); await dialog.waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] img')].some(el => el.complete && el.naturalWidth > 0));
      const parentNode = await messages().elementHandle();
      const parentTop = await messages().evaluate(el => el.scrollTop);
      await capture("e1-02-image", "sent image loaded via actual Core media; command/child remain running");
      const imageWidth = await dialog.locator("img").evaluate(el => el.getBoundingClientRect().width);
      await segment("image-zoom", () => dialog.getByRole("button", { name: "放大图片", exact: true }).click());
      assert.ok(await dialog.locator("img").evaluate(el => el.getBoundingClientRect().width) > imageWidth);
      await capture("e1-02b-image-zoom", "Core media zoom increases displayed image size");
      await dialog.getByRole("button", { name: "实际大小 100%", exact: true }).click();
      assert.equal(await dialog.getByLabel("图片缩放比例", { exact: true }).innerText(), "100%");
      await segment("image-close", () => page.keyboard.press("Escape")); await dialog.waitFor({ state: "hidden" });
      if (motion) {
        await segment("image-reopen-reverse", async () => {
          await imageTrigger.click(); await page.waitForTimeout(50); await page.keyboard.press("Escape");
        });
        await dialog.waitFor({ state: "hidden" });
      }
      assert.equal(await imageTrigger.evaluate(el => el === document.activeElement), true, "image close returns focus to original trigger");
      assert.equal(await messages().evaluate((el, node) => el === node, parentNode), true);
      assert.equal(await messages().evaluate(el => el.scrollTop), parentTop, "image return preserves reading position");
      let returnAnchor;
      const resourceTrigger = button("任务资源");
      assert.equal(await page.getByLabel("任务资源面板", { exact: true }).isVisible(), false, "context card starts closed");
      await resourceTrigger.click();
      const contextCard = page.getByRole("complementary", { name: "任务上下文", exact: true });
      await contextCard.waitFor();
      await contextCard.getByRole("button", { name: /Changes/ }).waitFor();
      await contextCard.getByRole("button", { name: "折叠来源", exact: true }).click();
      await contextCard.getByRole("button", { name: "展开来源", exact: true }).click();
      await contextCard.getByRole("button", { name: "查看全部来源（4）", exact: true }).click();
      await contextCard.getByRole("region", { name: "全部输入来源", exact: true }).getByRole("button", { name: /example.invalid\/c/ }).waitFor();
      await contextCard.getByRole("button", { name: "返回来源概览", exact: true }).click();
      await capture("production-context", "top-controlled production card, three sources and explicit all-sources return");
      await contextCard.getByRole("button", { name: /查看全部子代理/ }).click();
      const agentList = page.getByRole("region", { name: "子代理面板", exact: true });
      await agentList.getByRole("heading", { name: /Active/ }).waitFor();
      await agentList.getByText("还没有已完成的子任务", { exact: true }).waitFor();
      await capture("production-agent-list", "real Core child list before opening selected history");
      const childRow = agentList.locator(`[data-agent-id="${childId}"]`);
      await childRow.click();
      await page.locator(`[data-agent-conversation="${childId}"] [data-turn-status="inProgress"]`).waitFor();
      await agentList.getByRole("button", { name: "返回子代理列表", exact: true }).click();
      assert.equal(await childRow.evaluate(el => el === document.activeElement), true, "history returns to original child row");
      const beforeListClose = received.length;
      await agentList.getByRole("button", { name: "关闭子代理面板", exact: true }).click();
      await contextCard.waitFor();
      assert.equal(received.length, beforeListClose, "reading list/history does not submit or replay");
      await page.keyboard.press("Escape");
      await contextCard.waitFor({ state: "hidden" });
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "任务资源");
      assert.equal(await resourceTrigger.evaluate(el => el === document.activeElement), true, "card closes to top trigger");
      const originalBounds = await getApp().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      await getApp().evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 760));
      await resourceTrigger.click(); await contextCard.waitFor();
      const cardBounds = await contextCard.evaluate(el => { const box = el.getBoundingClientRect(); return { left: box.left, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, overflow: el.scrollWidth - el.clientWidth }; });
      assert.ok(cardBounds.left >= 0 && cardBounds.right <= cardBounds.width && cardBounds.bottom <= cardBounds.height && cardBounds.overflow <= 1, "production card stays within a narrow desktop window");
      await capture("production-context-narrow", "same production card in a 1000px desktop content viewport");
      await page.keyboard.press("Escape"); await contextCard.waitFor({ state: "hidden" });
      await getApp().evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), originalBounds);
      const stage2Draft = "继续核对命令和子代理，暂不发送。";
      if (stage2) {
        await input().click(); await page.keyboard.insertText(stage2Draft);
        await page.waitForFunction(text => Object.values(localStorage).some(value => value === text), stage2Draft);
        await childTrigger.scrollIntoViewIfNeeded();
        returnAnchor = await childTrigger.evaluate(el => el.getBoundingClientRect().top);
      }
      await segment("child-open", () => latest().getByRole("button", { name: `打开 ${childId} 子对话`, exact: true }).click());
      const childPane = () => page.locator(`[data-agent-conversation="${childId}"]`);
      await childPane().locator('[data-turn-status="inProgress"]').waitFor();
      assert.equal(await childTrigger.locator(".agent-spawn-status").innerText(), "执行中", "loaded child state replaces creation receipt");
      await capture("e1-03-child", "independent child conversation opened while parent remains active");
      if (stage2) {
        mark("stage2-child-heading", {title: await childPane().locator('.agent-conversation-heading strong').innerText()});
        if (process.env.AREAL_CONVERSATION_BASELINE !== "1") {
          assert.match(await childPane().locator('.agent-conversation-heading strong').innerText(), /独立核对水果数量/);
          assert.equal(await command().locator('.command-heading [role="status"]').innerText(), "执行中");
        }
      }

      if (motion) {
        await segment("child-close-reverse", async () => {
          await button("关闭面板").click(); await page.waitForTimeout(50);
          await latest().getByRole("button", { name: `打开 ${childId} 子对话`, exact: true }).click();
        });
        await childPane().locator('[data-turn-status="inProgress"]').waitFor();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === "true");
        await segment("reduced-child-close", () => button("关闭面板").click());
        await segment("reduced-child-open", () => latest().getByRole("button", { name: `打开 ${childId} 子对话`, exact: true }).click());
        assert.equal(await page.locator('.work-surface').getAttribute('data-panel-transition'), null);
        await segment("reduced-command-close", () => command().locator(".tool-summary-row").first().click());
        await segment("reduced-command-open", () => command().locator(".tool-summary-row").first().click());
        await segment("reduced-image-open", () => imageTrigger.click());
        await segment("reduced-image-close", () => page.keyboard.press("Escape"));
        assert.equal(await imageTrigger.evaluate(el => el === document.activeElement), true);
        await segment("reduced-wait", () => Promise.resolve(), 700);
        const reducedLoops = await page.evaluate(() => document.getAnimations().filter(a => a.playState === "running" && ["spin", "turn-thinking-shimmer"].includes(a.animationName)).map(a => a.animationName));
        assert.deepEqual(reducedLoops, [], "reduced motion stops both transcript and task-list waiting loops");
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === "false");
      }
      await writeFile(join(workspace, "e1-command-release"), "release"); await waitFile("e1-command-finished"); release("parent");
      await waitHeld("grow");
      await page.waitForFunction(id => document.querySelector(`[data-tool-id="${id}"] [aria-label="工具结果"]`)?.textContent.includes("Fruit: 32"), commandItem.id);
      assert.equal(await latest().locator(`[data-tool-id="${commandItem.id}"]`).count(), 1);
      assert.equal(await latest().locator('[data-tool-id]').count(), allTools, "process read is merged into its original command card");
      assert.equal((await readFile(join(workspace, "e1-command-finished"), "utf8")), "finished");
      await capture("e1-04-command-done", "command completed while child still running and parent streams final");
      release("child"); await childPane().locator('[data-turn-status="completed"]').waitFor();
      assert.equal(await childTrigger.locator(".agent-spawn-status").innerText(), "已完成");
      await capture("e1-05-child-done", "child complete independently; parent still active");
      await segment("child-close", () => button("关闭面板").click());
      if (stage2) {
        await page.locator('.workspace-side-panel').waitFor({state:'hidden'});
        await page.waitForFunction(() => !document.querySelector('.work-surface')?.hasAttribute('data-panel-transition'));
        await page.waitForFunction(text => document.querySelector('[data-testid="chat-input"]')?.textContent?.includes(text), stage2Draft);
        assert.equal(await childTrigger.evaluate(el => el === document.activeElement),true,'child panel close restores invocation focus');
        assert.equal(await messages().evaluate((el,node)=>el===node,parentNode),true,'return keeps original parent transcript mounted');
        const returned = await childTrigger.evaluate(el=>el.getBoundingClientRect().top);
        mark('stage2-return',{before:returnAnchor,after:returned,delta:returned-returnAnchor,draft:await input().innerText()});
        await capture('s2-03-panel-return','actual child closes; parent identity, unsent draft and invocation focus retained');
      }
      // Exercise a real reader departure; never write the follow flag or expected scrollTop.
      await messages().hover(); await page.mouse.wheel(0, -1000);
      await page.getByRole("button", { name: "滚动到底部", exact: true }).waitFor();
      const anchor = messages().locator(".conversation-markdown p").filter({ hasText: "苹果十二个" });
      const visible = await anchor.evaluateAll(els => els.findIndex(el => { const r = el.getBoundingClientRect(), c = el.closest(".messages").getBoundingClientRect(); return r.top > c.top + 10 && r.bottom < c.bottom - 10; }));
      assert.ok(visible >= 0, "visible history paragraph available"); const tracked = anchor.nth(visible);
      const top = await tracked.evaluate(el => el.getBoundingClientRect().top);
      mark("reading-anchor", { paragraphIndex: visible, top, owner: await tracked.evaluate(el => ({ turnId: el.closest("[data-turn-id]").dataset.turnId, itemId: el.closest("[data-side-item-id]").dataset.sideItemId, fingerprint: el.textContent.slice(0, 90) })) });
      await capture("e1-06-reading", "wheel up during generation; select visible paragraph anchor");
      for (let i = 1; i <= 2; i++) {
        await recording?.mark("growth-reading:before");
        const section = motion && i === 1 ? await held.get("drip")() : release("grow");
        await latest().getByRole("heading", { name: `${section}. 水果记录`, exact: true }).waitFor();
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        const observedTop = await tracked.evaluate(el => el.getBoundingClientRect().top);
        mark("reading-anchor-growth", { ordinal: i, expectedTop: top, observedTop, delta: observedTop - top });
        assert.ok(Math.abs(observedTop - top) <= 1, "reader anchor stays stable on output growth");
        await capture(`e1-07-reading-growth-${i}`, "output grew while same visible anchor remains stable");
      }
      await segment("return-to-latest", () => page.getByRole("button", { name: "滚动到底部", exact: true }).click());
      for (let i = 1; i <= 2; i++) { const section = release("grow"); await latest().getByRole("heading", { name: `${section}. 水果记录`, exact: true }).waitFor(); const m = await capture(`e1-08-following-${i}`, "explicit return to latest resumes following on next output"); assert.ok(m.gap <= 2); }
      await recording?.mark("completion:before"); release("complete"); await settled();
      if (motion) await segment("completion-stable", () => Promise.resolve());
      await latest().locator(".assistant-message-final").getByText(/E1_FINAL_END/).waitFor();
      await capture("e1-09-completed", "final answer remains readable after process convergence");
      assert.equal(await latest().locator(".turn-progress-summary").getAttribute("aria-expanded"), "false");
      const beforeRevisit = received.length;
      await latest().locator(".turn-progress-summary").click();
      assert.equal(await activityGroup.getByRole("button").first().getAttribute("aria-expanded"), "true", "manual activity choice survives completion");
      assert.equal(await toolImage.getAttribute("aria-expanded"), "true", "manual image choice survives parent convergence");
      await latest().getByRole("button", { name: `打开 ${childId} 子对话`, exact: true }).click();
      await childPane().locator('[data-turn-status="completed"]').waitFor();
      await capture("e1-10-revisit", "completed process and actual child are revisitable without execution replay");
      await button("关闭面板").click();
      checks.push("E1 main: UI Send → real Runtime command/Core child → image return → live history anchor → return-to-latest → independent completion/revisit");
      if (stage2) {
        await page.waitForFunction(() => !document.querySelector('.work-surface')?.hasAttribute('data-panel-transition'));
        await capture('s2-04-final-return','completed task revisited and closed; no repeated execution or extra submission');
        assert.equal(await input().innerText(),stage2Draft);
        assert.equal(received.length,beforeRevisit);
        await writeFile(join(scratch,'stage2-final-state.json'),JSON.stringify(await state(),null,2));
        if (process.env.AREAL_CONVERSATION_BASELINE !== '1') {
          assert.match(await latest().locator('.turn-progress-summary').innerText(),/Working for/);
          assert.equal(await latest().locator('.turn-progress-summary .conversation-disclosure-action').innerText(),'收起');
        }
        checks.push('Stage2 interaction families: actual send acceptance, command execution/output polling, independent Core child, draft/focus/parent identity return, complete/revisit without replay');
        return;
      }
      // The prior explicit history revisit intentionally leaves us reading above the tail.
      const toLatest = page.getByRole("button", { name: "滚动到底部", exact: true });
      if (await toLatest.isVisible()) await toLatest.click();
      // Separate stop variant, with real process entry proof.
      await send("E1_STOP：运行一个可停止命令。"); await waitFile("e1-stop-started");
      await segment("pause", () => button("暂停执行").click());
      const pausedState = await until(s => { const turn = projectOf(s).state.threads[mainId].turns.at(-1); return turn.interruption === "userPause" && ["interrupted", "failed"].includes(turn.status); }, "Core pause terminal receipt");
      const pausedTurn = projectOf(pausedState).state.threads[mainId].turns.at(-1);
      await latest().locator(".turn-stop-heading").getByText(/执行已暂停/).waitFor();
      await capture("e1-pause", "separate variant: authoritative userPause cause; inspect UNKNOWN only when Core reports it");
      if (pausedTurn.status === "failed") {
        const unknown = pausedTurn.items.find(item => item.execution?.outcome === "unknown");
        assert.ok(unknown, "failed pause must retain its exact UNKNOWN tool outcome");
        const beforeInspection = received.length;
        const proof = await readFile(join(workspace, "e1-stop-started"), "utf8");
        assert.equal(proof, "started");
        await page.getByRole("button", { name: "核查 UNKNOWN", exact: true }).click();
        const inspection = page.getByRole("dialog");
        await inspection.getByLabel("核查说明", { exact: true }).fill("已读取本隔离工作区 e1-stop-started=started。该合成命令只写启动标记，未重新执行。此核查不将进程终态或原 UNKNOWN 改写为成功。");
        await inspection.getByRole("checkbox", { name: "已核查实际文件或进程", exact: true }).check();
        await inspection.getByRole("button", { name: "确认已核查", exact: true }).click();
        await inspection.waitFor({ state: "hidden" });
        await until(s => projectOf(s).state.threads[mainId].turns.at(-1).items.some(item => item.id === unknown.id && item.execution?.inspection), "inspection persisted");
        const preserved = projectOf(await state()).state.threads[mainId].turns.at(-1).items.find(item => item.id === unknown.id);
        assert.equal(preserved.execution.outcome, "unknown");
        assert.equal(received.length, beforeInspection, "inspection must not replay or submit to model");
        await capture("e1-unknown-inspected", "read actual synthetic file; UI acknowledgement preserves UNKNOWN and makes no model request");
        checks.push("E1 pause exception: failed UNKNOWN retains userPause cause; actual-file inspection is recorded through UI without replay");
      } else checks.push("E1 pause: actual Core interruption preserves userPause cause");
      if (motion) {
        await recording.stop(); recording = undefined;
        const observed = JSON.parse(await readFile(join(scratch, "motion/motion.json"), "utf8"));
        const interval = name => {
          const marks = observed.marks.filter(m => m.name.startsWith(name + ":"));
          return observed.samples.filter(s => s.t >= marks[0].t && s.t <= marks.at(-1).t);
        };
        const opened = interval("command-reopen").map(s => s.elements.command?.height ?? 0);
        const maximum = Math.max(...opened);
        assert.ok(maximum > 0 && opened.some(h => h > 1 && h < maximum - 2), "disclosure has actually presented intermediate heights");
        const reverse = interval("command-open-reverse").map(s => s.elements.command?.height ?? 0);
        const peak = Math.max(...reverse), peakIndex = reverse.indexOf(peak);
        assert.ok(peak > 10 && reverse.slice(peakIndex).some(h => h < peak / 2), "rapid reverse closes from a presented intermediate height");
        assert.ok(interval("reduced-wait").every(s => !s.animations.some(a => ["spin", "turn-thinking-shimmer"].includes(a.name))), "reduced waiting stays static across frames");
        for (const sample of observed.samples) {
          const composer = sample.elements.composer;
          if (composer) assert.ok(composer.y >= -1 && composer.y + composer.height <= observed.viewport[1] + 1, "composer remains inside window throughout the journey");
          if (sample.elements.pane) assert.equal(sample.elements.pane.scrollTop, 0, "conversation chrome never becomes another scroll owner");
        }
        assert.deepEqual(observed.errors, []);
        checks.push("E2: intermediate disclosure geometry/reversal, static reduced waiting, in-window composer and sole transcript scroll owner across continuous samples");
        return;
      }
      if (production) {
        // Page adoption does not change quit policy. The original full journey below
        // keeps its separate active-quit/background-completion contract.
        const beforeReload = received.length;
        const turnsBeforeReload = projectOf(await state()).state.threads[mainId].turns.length;
        await page.reload();
        await page.getByTestId("areal-workbench").waitFor();
        await until(s => projectOf(s)?.state?.threads[mainId]?.turns.length === turnsBeforeReload, "production history restored");
        await latest().locator(".turn-stop-heading").getByText(/执行已暂停/).waitFor();
        assert.equal(received.length, beforeReload, "history reload must not submit or replay model work");
        await capture("production-history-restored", "renderer reload restores authoritative paused history without model replay");
        checks.push("Production adoption: top card/source controls, child list/history/return, narrow desktop, manual activity/image state, actual pause and renderer history reload without replay");
        return;
      }
      // Separate recovery run: same private Core/session, new Electron process.
      await send("E1_RECOVERY：关闭 GUI 后完成，再重开读取。"); await waitHeld("recovery");
      const before = received.length, turns = projectOf(await state()).state.threads[mainId].turns.length;
      await capture("e1-recovery-before", "separate variant: active turn before GUI close");
      await quit(); release("recovery"); await launch(); page = getPage();
      await until(s => projectOf(s)?.state?.threads[mainId]?.turns.at(-1)?.status === "completed", "reopened history completed");
      assert.equal(projectOf(await state()).state.threads[mainId].turns.length, turns);
      assert.equal(received.length, before, "reopening history must not replay provider submission");
      await capture("e1-recovery-after", "new Electron process restores authoritative history without replay");
      checks.push("E1 recovery: GUI close/reopen reads completed Core history without extra model request");
    } finally {
      await recording?.stop();
      await writeFile(join(scratch, "journey-events.json"), JSON.stringify(events, null, 2));
      await writeFile(join(scratch, "journey-model-requests.json"), JSON.stringify(received, null, 2));
    }
  }
  return { model, run, frames: () => events.filter(event => event.kind === "checkpoint").map(event => event.screenshot) };
}
