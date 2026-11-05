import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";

// 真实 Renderer、桌面投影和 Core/Runtime；仅外部模型与 preload 传输使用隔离夹具。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
for (const key of ["NO_PROXY", "no_proxy"]) {
  process.env[key] = [process.env[key], "127.0.0.1", "localhost"].filter(Boolean).join(",");
}
const scratch = await makeTempDir("areal-history-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user"));
await writeFile(join(workspace, "fixture.txt"), "Retained history fixture.\n");
const binary = process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const binarySha256 = createHash("sha256")
  .update(await readFile(binary))
  .digest("hex");
const checks = [],
  errors = [],
  events = [],
  requests = [],
  cases = [];
let activeCase,
  browser,
  page,
  passed = false;
let publishing = Promise.resolve();
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const summary = body.messages?.some(
      (message) =>
        typeof message.content === "string" &&
        message.content.startsWith("Summarize this session prefix"),
    );
    requests.push({ case: activeCase.name, summary });
    response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const finish = (reason) => {
      send({}, reason);
      response.end("data: [DONE]\n\n");
    };
    if (summary) {
      send({ content: "Fixture file inspected. Preserve the exact original task and continue." });
      finish("stop");
      return;
    }
    const round = ++activeCase.rounds;
    if (round === 1) {
      send({
        content: `${activeCase.name}_EARLY\n${"Original commentary must remain readable. ".repeat(360)}`,
      });
      send({
        tool_calls: [
          {
            index: 0,
            id: `read-${activeCase.name}`,
            type: "function",
            function: { name: "fs_read", arguments: JSON.stringify({ path: "fixture.txt" }) },
          },
        ],
      });
      finish("tool_calls");
    } else if (round === 2) {
      send({ content: `${activeCase.name}_PARTIAL` });
      activeCase.finish = () => finish(activeCase.name === "failed" ? "length" : "stop");
    } else {
      send({ content: `${activeCase.name}_FINAL` });
      finish("stop");
    }
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
const config = join(scratch, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[limits]\ncontext_window_bytes=8000\ncontext_recent_bytes=256\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      { id: "fixture", revision: "v1", displayName: "Fixture", instructions: "Complete the task" },
    ],
  }),
);
const backend = new CoreBackend({
  binary,
  home: join(scratch, "desktop"),
  harnessHome: join(scratch, "registry"),
  userHome: join(scratch, "user"),
  config,
  desktopConfig: deployment,
  defaultProfile: { id: "fixture", revision: "v1" },
  onChange: () => {
    if (!page || page.isClosed()) return;
    const snapshot = backend.snapshot();
    publishing = publishing
      .then(() =>
        page.isClosed()
          ? undefined
          : page.evaluate((snapshot) => window.applyHistoryState?.(snapshot), snapshot),
      )
      .catch((error) => errors.push(error.message));
  },
});
const dist = join(gui, "renderer/dist");
const assets = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://fixture").pathname);
    const path = resolve(dist, pathname === "/" ? "index.html" : `.${pathname}`);
    if (!path.startsWith(dist + sep)) throw new Error("invalid asset path");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
      }[extname(path)] || "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => assets.listen(0, "127.0.0.1", resolve));
async function until(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
}
function observe(project) {
  project.client.onNotification((method, params) => {
    if (["areal/context/compacted", "turn/completed"].includes(method))
      events.push({ method, params });
  });
}
async function assertBubbles(thread) {
  const turnIds = thread.turns.map((turn) => turn.id);
  await page.waitForFunction(
    (ids) => ids.every((id) => document.querySelector(`[data-turn-id="${id}"]`)),
    turnIds,
  );
  for (const turn of thread.turns)
    for (const item of turn.items) {
      if (item.type !== "userMessage" && !(item.type === "agentMessage" && item.text.trim()))
        continue;
      const row = page.locator(`[data-turn-id="${turn.id}"] [data-side-item-id="${item.id}"]`);
      await row.waitFor({ state: "attached" });
      // 终态会由 React effect 收起过程；等其提交后通过真实展开入口检查正文。
      await until(async () => {
        if (await row.isVisible()) return true;
        for (const toggle of await page
          .locator(".turn-progress-summary[aria-expanded=false]")
          .all())
          await toggle.click();
        return row.isVisible();
      }, `bubble visible: ${item.id}`);
      assert.equal(await row.count(), 1, "同一消息只展示一次");
      const text =
        item.type === "userMessage"
          ? item.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : item.text;
      assert.equal((await row.locator(".conversation-markdown").textContent()).trim(), text.trim());
    }
}
console.log("History evidence:", scratch);
try {
  await backend.init();
  const projectId = await backend.addProject(workspace);
  const project = backend.projects.get(projectId);
  observe(project);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.AREAL_GUI_TEST_BROWSER
      ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
      : { channel: "chrome" }),
  });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  const origin = `http://127.0.0.1:${assets.address().port}`;
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("historySnapshot", () => backend.snapshot());
  await page.exposeFunction("historyCommand", async (name, params) => {
    try {
      return { ok: true, value: await backend.command(name, params) };
    } catch (error) {
      return { ok: false, error: { message: error.message, code: error.code } };
    }
  });
  await page.addInitScript(() => {
    window.arealDesktop = {
      snapshot: () => window.historySnapshot(),
      command: (name, params) => window.historyCommand(name, params),
      onState: (listener) => {
        window.applyHistoryState = listener;
        return () => {
          window.applyHistoryState = undefined;
        };
      },
      theme: async () => ({ platform: "darwin", dark: false, id: "light" }),
      onTheme: () => () => {},
      presentReady: async () => {},
      preview: async () => ({}),
    };
  });
  await page.goto(origin);
  await page.getByTestId("areal-workbench").waitFor();
  for (const name of ["completed", "interrupted", "failed"]) {
    activeCase = { name, rounds: 0 };
    const { threadId } = await backend.command("create", { projectId });
    await selectConversation(page, threadId);
    await page.getByTestId("chat-input").fill(`${name}_USER`);
    await page.getByTestId("chat-send-button").click();
    await until(() => activeCase.finish, "compaction and partial reply");
    const current = () => project.model.state.threads[threadId];
    assert.ok(
      events.some(
        (event) => event.method === "areal/context/compacted" && event.params.threadId === threadId,
      ),
      "真实 Core 在同一轮内压缩",
    );
    await assertBubbles(current());
    if (name === "completed") {
      const old = project.client;
      old.socket.terminate();
      await until(
        () => project.client !== old && project.model.state.connected,
        "observer reconnect",
      );
      observe(project);
      assert.equal(activeCase.rounds, 2, "断线恢复不重发模型请求");
      await assertBubbles(current());
      await backend.command("steer", {
        projectId,
        threadId,
        expectedTurnId: current().turns.at(-1).id,
        text: "completed_STEER",
      });
      activeCase.finish();
    } else if (name === "interrupted") {
      await backend.command("stop", {
        projectId,
        threadId,
        turnId: current().turns.at(-1).id,
        requestId: randomUUID(),
      });
      activeCase.finish();
    } else activeCase.finish();
    await until(() => current().turns.at(-1).status === name, `${name} settlement`);
    const terminal = events.findLast(
      (event) => event.method === "turn/completed" && event.params.threadId === threadId,
    );
    assert.ok(terminal);
    assert.equal(
      terminal.params.turn.items.some(
        (item) =>
          item.type === "userMessage" && item.content.some((part) => part.text === `${name}_USER`),
      ),
      false,
      "终态事件确实省略已归档的原始提问",
    );
    const authoritative = (
      await project.client.request("thread/read", { threadId, includeTurns: true })
    ).thread;
    assert.deepEqual(
      JSON.parse(JSON.stringify(current().turns)),
      authoritative.turns,
      "事件投影与完整冷历史回取一致",
    );
    await assertBubbles(current());
    await page.screenshot({ path: join(scratch, `${name}.png`), animations: "disabled" });
    cases.push({ name, threadId, turns: authoritative.turns });
    checks.push(
      `${name}: real compaction, user/agent text, same-turn input, and authoritative history agree`,
    );
  }
  for (const value of cases) {
    await selectConversation(page, value.threadId);
    await backend.command("open", { projectId, threadId: value.threadId });
    await assertBubbles({ turns: value.turns });
  }
  const continued = cases[0];
  await selectConversation(page, continued.threadId);
  activeCase = { name: "followup", rounds: 2 };
  await page.getByTestId("chat-input").fill("FOLLOWUP_USER");
  await page.getByTestId("chat-send-button").click();
  const conversation = () => project.model.state.threads[continued.threadId];
  await until(
    () => conversation().turns.length === 2 && conversation().turns.at(-1).status === "completed",
    "a new turn preserves the compacted previous turn",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(conversation().turns[0])), continued.turns[0]);
  const full = (
    await project.client.request("thread/read", {
      threadId: continued.threadId,
      includeTurns: true,
    })
  ).thread;
  assert.deepEqual(JSON.parse(JSON.stringify(conversation().turns)), full.turns);
  continued.turns = full.turns;
  await assertBubbles(continued);
  checks.push("a new user/agent turn retains the complete prior compacted turn");
  await page.reload();
  await page.getByTestId("areal-workbench").waitFor();
  await selectConversation(page, continued.threadId);
  await assertBubbles(continued);
  checks.push(
    "switching conversations, observer reconnect, authoritative reopen, and renderer reload preserve every bubble",
  );
  assert.deepEqual(errors, []);
  assert.equal(
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    binarySha256,
  );
  passed = true;
} catch (error) {
  errors.push(error.stack);
  if (page) await captureSmokeFailure(page, scratch, error);
  process.exitCode = 1;
} finally {
  await publishing;
  await browser?.close();
  for (const project of backend.projects.values()) {
    try {
      await project.client?.request("areal/server/drain", { strategy: "cancel", timeoutMs: 10000 });
    } catch (error) {
      errors.push(`drain: ${error.message}`);
    }
  }
  await backend.shutdown().catch((error) => errors.push(`shutdown: ${error.message}`));
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  model.closeAllConnections();
  assets.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => model.close(resolve)),
    new Promise((resolve) => assets.close(resolve)),
  ]);
  const manifest = {
    passed,
    binary,
    binarySha256,
    scope:
      "built React renderer in Chrome + real desktop CoreBackend/Core/Runtime; deterministic SSE model; preload transport fixture, no Electron IPC or installation acceptance",
    checks,
    errors,
    requests,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(scratch, "history.json"), JSON.stringify({ events, cases }, null, 2));
  console.log(JSON.stringify({ ...manifest, evidence: scratch }));
}
