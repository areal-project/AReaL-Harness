import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureSmokeFailure,
  createProjectConversation,
  selectConversation,
} from "./smoke-navigation.mjs";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  readFixtureHost,
  settleFixtureHostAfterQuit,
} from "./application-cleanup.mjs";
import { openProjectInDesktop, sendReady } from "./support/journey-fixture.mjs";
import { readCoreThread, withCore } from "./support/core-observation.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

// 真实 Renderer、Host、Core 和 Runtime，模型由隔离 SSE fixture 提供。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
for (const key of ["NO_PROXY", "no_proxy"]) {
  process.env[key] = [process.env[key], "127.0.0.1", "localhost"].filter(Boolean).join(",");
}
const scratch = await makeTempDir("areal-history-");
const workspace = join(scratch, "demo");
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
  application,
  electronPid,
  originalHost,
  stopReceipt,
  page,
  passed = false;
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
    const title = body.messages?.[0]?.content?.startsWith(
      "Generate a concise semantic session title",
    );
    assert.ok(activeCase || title, "synthetic model request belongs to a selected scenario");
    requests.push({ case: activeCase?.name, summary, title: !!title });
    response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const finish = (reason) => {
      send({}, reason);
      response.end("data: [DONE]\n\n");
    };
    if (title) {
      send({ content: "History fixture" });
      finish("stop");
      return;
    }
    if (summary) {
      send({ content: "Fixture file inspected. Preserve the exact original task and continue." });
      finish("stop");
      return;
    }
    const round = ++activeCase.rounds;
    if (round === 1) {
      await activeCase.observed.promise;
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
      activeCase.finish =
        activeCase.name === "failed"
          ? () =>
              response.end(
                `data: ${JSON.stringify({ error: { type: "invalid_request_error", message: "Compacted history fixture rejected" } })}\n\n`,
              )
          : () => finish("stop");
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
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[limits]\ncontext_window_bytes=8000\ncontext_recent_bytes=256\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) && key !== "ELECTRON_RUN_AS_NODE",
  ),
);
Object.assign(env, {
  HOME: join(scratch, "user"),
  AREAL_CORE_BIN: binary,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "configuration"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_CONFIG: config,
});
const read = (threadId) => readCoreThread({ binary, env, gui, workspace, threadId });
async function until(predicate, label) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timeout: ${label}`);
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
      const turnRow = page.locator(`[data-turn-id="${turn.id}"]`);
      const row = turnRow.locator(`[data-side-item-id="${item.id}"]`);
      // 重开终态对话时，过程项要在展开后才挂载。
      await until(async () => {
        if (await row.isVisible()) return true;
        for (const toggle of await turnRow
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
      assert.equal((await row.locator(".conversation-markdown").innerText()).trim(), text.trim());
    }
}
console.log("History evidence:", scratch);
try {
  application = await electron.launch({
    executablePath: require("electron"),
    args: [
      join(gui, "app"),
      ...(process.platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : []),
    ],
    env,
    timeout: 120000,
  });
  electronPid = application.process().pid;
  page = await application.firstWindow();
  page.setDefaultTimeout(30000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  originalHost = await readFixtureHost(env);
  assert.ok(originalHost?.pid > 1);
  await application.context().addInitScript(() => {
    const preferences = "areal-gui:application-preferences";
    localStorage.setItem(
      preferences,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(preferences) ?? "{}"),
        locale: "zh-CN",
        followUp: "steer",
        nextPromptSuggestions: false,
      }),
    );
    const subscriptions = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function (bytes) {
      if (typeof bytes === "string") {
        try {
          const request = JSON.parse(bytes);
          if (request.method === "session.open")
            subscriptions.push({ socket: this, threadId: request.params.threadId });
        } catch {}
      }
      return send.call(this, bytes);
    };
    window.historyTransport = {
      disconnect(threadId) {
        const target = subscriptions.findLast((entry) => entry.threadId === threadId);
        if (!target || target.socket.readyState !== WebSocket.OPEN)
          throw new Error("Original Renderer Host socket is unavailable");
        target.socket.close();
        return subscriptions.length;
      },
      reconnected(threadId, previous) {
        const original = subscriptions
          .slice(0, previous)
          .findLast((entry) => entry.threadId === threadId);
        return subscriptions
          .slice(previous)
          .some(
            (entry) =>
              entry.threadId === threadId &&
              entry.socket !== original.socket &&
              entry.socket.readyState === WebSocket.OPEN,
          );
      },
    };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]').waitFor();
  await openProjectInDesktop(application, page, workspace);
  const workbench = page.getByTestId("areal-workbench");
  const input = page.getByTestId("chat-input");
  const send = page.getByTestId("chat-send-button");
  for (const name of ["completed", "interrupted", "failed"]) {
    if (cases.length > 0) await createProjectConversation(page, "demo");
    await page.getByRole("button", { name: "选择模型", exact: true }).click();
    await page.getByRole("radio", { name: "fixture", exact: true }).click();
    activeCase = { name, rounds: 0, observed: Promise.withResolvers() };
    const previous = await workbench.getAttribute("data-thread-id");
    await input.fill(`${name}_USER`);
    await sendReady(page);
    await send.click();
    await page.waitForFunction((previous) => {
      const id = document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId;
      return id && id !== previous;
    }, previous);
    const threadId = await workbench.getAttribute("data-thread-id");
    await withCore({ binary, env, gui, workspace, threadId }, async (observer) => {
      observer.onNotification((method, params) => {
        if (
          params.threadId === threadId &&
          ["areal/context/compacted", "turn/completed"].includes(method)
        )
          events.push({ method, params });
      });
      await observer.request("areal/thread/observe", { threadId });
      activeCase.observed.resolve();
      await until(() => activeCase.finish, "compaction and partial reply");
      await until(
        () =>
          events.some(
            (event) =>
              event.method === "areal/context/compacted" && event.params.threadId === threadId,
          ),
        "真实 Core 在同一轮内压缩",
      );
      await page.getByText(`${name}_PARTIAL`, { exact: true }).waitFor();
      const original = await read(threadId);
      await assertBubbles(original);
      if (name === "completed") {
        const count = await page.evaluate((id) => window.historyTransport.disconnect(id), threadId);
        await page.waitForFunction(
          ({ id, count }) => window.historyTransport.reconnected(id, count),
          { id: threadId, count },
        );
        assert.equal(activeCase.rounds, 2, "断线恢复不重发模型请求");
        await assertBubbles(original);
        await input.fill("completed_STEER");
        await send.click();
        await until(
          async () =>
            (await read(threadId)).turns
              .at(-1)
              ?.items.some(
                (item) =>
                  item.type === "userMessage" &&
                  item.content.some((part) => part.text === "completed_STEER"),
              ),
          "同一轮次接收调整方向",
        );
        activeCase.finish();
      } else if (name === "interrupted") {
        await page.getByRole("button", { name: "暂停执行", exact: true }).click();
      } else activeCase.finish();
      await until(
        async () => (await read(threadId)).turns.at(-1)?.status === name,
        `${name} settlement`,
      );
      await until(
        () =>
          events.some(
            (event) => event.method === "turn/completed" && event.params.threadId === threadId,
          ),
        "原 Core 终态事件",
      );
      const terminal = events.findLast(
        (event) => event.method === "turn/completed" && event.params.threadId === threadId,
      );
      assert.equal(
        terminal.params.turn.items.some(
          (item) =>
            item.type === "userMessage" &&
            item.content.some((part) => part.text === `${name}_USER`),
        ),
        false,
        "终态事件确实省略已归档的原始提问",
      );
      const authoritative = await read(threadId);
      assert.equal(authoritative.turns.at(-1).id, original.turns.at(-1).id);
      await assertBubbles(authoritative);
      await page.screenshot({ path: join(scratch, `${name}.png`), animations: "disabled" });
      cases.push({ name, threadId, turns: authoritative.turns });
    });
    checks.push(
      `${name}: real compaction, user/agent text, same-turn input, and authoritative history agree`,
    );
  }
  for (const value of cases) {
    await selectConversation(page, value.threadId);
    await assertBubbles(value);
  }
  const continued = cases[0];
  await selectConversation(page, continued.threadId);
  activeCase = { name: "followup", rounds: 2 };
  await input.fill("FOLLOWUP_USER");
  await sendReady(page);
  await send.click();
  await until(async () => {
    const thread = await read(continued.threadId);
    return thread.turns.length === 2 && thread.turns.at(-1).status === "completed";
  }, "a new turn preserves the compacted previous turn");
  const full = await read(continued.threadId);
  assert.deepEqual(full.turns[0], continued.turns[0]);
  continued.turns = full.turns;
  await assertBubbles(continued);
  checks.push("a new user/agent turn retains the complete prior compacted turn");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]').waitFor();
  await selectConversation(page, continued.threadId);
  await assertBubbles(continued);
  checks.push(
    "switching conversations, Host reconnect, authoritative reopen, and renderer reload preserve every bubble",
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
  activeCase?.observed?.resolve();
  if (application) {
    try {
      await withSmokeDeadline(
        "history quit confirmation",
        () =>
          application.evaluate(({ dialog }) => {
            dialog.showMessageBox = async () => ({ response: 1 });
          }),
        5000,
      );
    } catch (error) {
      errors.push(`quit confirmation: ${error.message}`);
    }
    try {
      await closeSmokeApplication(application, 60000);
    } catch (error) {
      errors.push(`Electron cleanup: ${error.message}`);
    }
  }
  try {
    originalHost ??= await readFixtureHost(env);
    if (originalHost)
      stopReceipt = await settleFixtureHostAfterQuit(binary, env, scratch, {
        host: originalHost,
        pid: electronPid,
      });
    else await assertApplicationStopped(binary, env, { pid: electronPid });
  } catch (error) {
    errors.push(`cleanup: ${error.message}`);
  }
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  const manifest = {
    passed,
    binary,
    binarySha256,
    electronPid: electronPid ?? null,
    hostPid: originalHost?.pid ?? null,
    scope:
      "built React renderer in Electron and real Rust Host/Core/Runtime with a deterministic local SSE model",
    checks,
    errors,
    requests,
    stopReceipt: stopReceipt?.requestId ?? null,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(join(scratch, "history.json"), JSON.stringify({ events, cases }, null, 2));
  console.log(JSON.stringify({ ...manifest, evidence: scratch }));
}
