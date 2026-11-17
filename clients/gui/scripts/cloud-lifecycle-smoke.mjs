import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { lockVerificationSlot, verificationDoctor } from "./verification-build.mjs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const gui = resolve(fileURLToPath(new URL("..", import.meta.url))),
  root = await realpath(await mkdtemp(join(tmpdir(), "cloud-native-")));
const require = createRequire(join(gui, "app/package.json"));
const { HostClient } = require("@areal/client/node");
const { createNativeHostTransport } = require(
  join(gui, "app/src/core/generated/native-host-transport.cjs"),
);
const { chromium } = require("playwright-core"),
  WebSocket = require("ws"),
  { WebSocketServer } = WebSocket;
const repository = resolve(gui, "../..");
const binary = resolve(
  process.env.AREAL_CORE_BIN || join(repository, ".local/shared-host-bin/areal"),
);
const { cleanupSyntheticHostKeychain } = await import(join(gui, "scripts/application-cleanup.mjs"));
const home = join(root, "host"),
  user = join(root, "user"),
  workspace = join(root, "workspace");
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: join(root, "legacy"),
};
for (const p of [home, user, workspace, ...Object.values(source)]) await mkdir(p, { mode: 0o700 });
const projectId = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
await writeFile(
  join(source.coreHome, "projects.json"),
  JSON.stringify([{ id: projectId, root: workspace }]),
  { mode: 0o600 },
);
const evidence = {
  root,
  binary,
  reached: [],
  calls: [],
  cleanup: {},
};
const host = new HostClient();
let transport,
  browser,
  page,
  socket,
  hostPid,
  release,
  stage = "verification preflight";
const pending = new Map();
const pageErrors = [];
const remote = createServer((_q, r) => {
  r.writeHead(404);
  r.end();
});
const wss = new WebSocketServer({ server: remote });
let allocations = 0,
  queries = 0,
  unknown = false,
  deferNext = false,
  rejectNext = false;
const thread = {
  id: "native-cloud-thread",
  turns: [],
  status: { type: "idle" },
  desktop: { archived: false, configuration: { revision: 0 } },
};
wss.on("connection", (ws, req) => {
  assert.equal(req.headers.authorization, "Bearer fixture-token");
  allocations++;
  ws.on("message", (raw) => {
    const q = JSON.parse(raw);
    if (!q.id) return;
    evidence.calls.push({ method: q.method, requestId: q.params?.requestId });
    let result;
    switch (q.method) {
      case "initialize":
        result = {};
        break;
      case "areal/capabilities":
        result = {
          apiVersion: "areal.core.v1",
          methods: [
            "areal/profile/list",
            "areal/thread/start",
            "thread/read",
            "areal/thread/observe",
            "areal/conversation/history",
            "areal/turn/start",
            "turn/interrupt",
            "areal/request/read",
          ],
          features: {
            conversationObservation: true,
            threadCreationJournal: {
              binding: {
                identity: "remote-cloud-store",
                journalEpoch: "epoch",
                coreInstanceId: "remote-core",
              },
            },
          },
          methodSemantics: {
            "areal/thread/start": { effect: "mutation", receipt: "management" },
            "areal/turn/start": { effect: "mutation", receipt: "management" },
            "turn/interrupt": { effect: "mutation", receipt: "management" },
          },
        };
        break;
      case "areal/profile/list":
        result = { data: [{ id: "remote-default", revision: "v1" }] };
        break;
      case "areal/model/list":
        result = {
          data: [
            {
              providerId: "remote",
              modelId: "remote-model",
              displayName: "Remote model",
              available: true,
            },
          ],
        };
        break;
      case "areal/thread/start":
        result = { thread, requestId: q.params.requestId };
        break;
      case "thread/read":
      case "areal/thread/observe":
        result = { thread };
        break;
      case "areal/request/read":
        result = { data: [] };
        break;
      case "areal/turn/start": {
        if (rejectNext) {
          rejectNext = false;
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: q.id,
              error: {
                code: -32000,
                message: "fixture rejection",
                data: { outcome: { kind: "rejected" }, recovery: { kind: "none" } },
              },
            }),
          );
          return;
        }
        queries++;
        const turn = {
          id: `turn-${queries}`,
          status: "completed",
          items: [{ id: `answer-${queries}`, type: "agentMessage", text: `QUERY_OK_${queries}` }],
        };
        if (deferNext) {
          deferNext = false;
          turn.status = "inProgress";
          turn.items = [];
        }
        thread.turns.push(turn);
        result = unknown
          ? {}
          : { threadId: thread.id, turn, requestId: q.params.requestId, accepted: true };
        unknown = false;
        break;
      }
      case "turn/interrupt":
        result = {};
        break;
      default:
        throw Error(`Unexpected remote method ${q.method}`);
    }
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
    if (q.method === "areal/turn/start" && thread.turns.length) {
      const turn = thread.turns.at(-1);
      ws.send(
        JSON.stringify({
          method: turn.status === "inProgress" ? "turn/started" : "turn/completed",
          params: { threadId: thread.id, turn },
        }),
      );
    }
  });
});
remote.listen(0, "127.0.0.1");
await once(remote, "listening");
async function rpc(method, params) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("socket reply deadline"));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ version: 1, id, method, params }));
  });
}

try {
  assert.ok(
    process.platform !== "darwin" || process.env.AREAL_TEST_HOST_KEYCHAIN === "1",
    "Isolated synthetic Host Keychain authorization required",
  );
  evidence.binarySha256 = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
  release = await lockVerificationSlot(binary);
  await verificationDoctor({ root: repository, binary, evidence: root });
  evidence.reached.push("verification preflight");
  stage = "host startup";
  await host.connectOrStart(home, binary);
  hostPid = JSON.parse(await readFile(join(home, "host/host.json"))).pid;
  stage = "attach source";
  await host.attachSource(source);
  stage = "import source";
  const imported = await host.importSource(randomUUID(), source);
  assert.equal(imported.kind, "ready");
  const sourceId = (await host.sourceState(source)).sourceId;
  evidence.host = { pid: hostPid, hostId: host.hostId, generation: host.generation, sourceId };
  stage = "desktop subscription";
  transport = await createNativeHostTransport({
    home,
    sourceId,
    launch: {
      binary,
      home: source.coreHome,
      guiProfile: source.profile,
      hostHome: home,
      harnessHome: source.legacyServiceHome,
      userHome: user,
      configHome: user,
    },
    onCallback: async () => {
      throw Error("no callback");
    },
    onEvent: () => {},
    onClosed: () => {},
  });
  evidence.reached.push("native Host source and desktop subscription");
  stage = "web ticket";
  const ticket = await host.request("web.ticket", {
    origin: "areal-ui://app",
    expectedGeneration: host.generation,
  });
  socket = new WebSocket(ticket.websocketUrl, { origin: ticket.origin });
  socket.on("message", (raw) => {
    const p = JSON.parse(raw);
    const entry = pending.get(p.id);
    if (!entry) return;
    pending.delete(p.id);
    clearTimeout(entry.timer);
    if (p.error) entry.reject(Error(JSON.stringify(p.error)));
    else entry.resolve(p.result);
  });
  await once(socket, "open");
  await rpc("hello", {
    protocolVersions: [1],
    capabilities: ["gui-read-v1", "gui-write-v1"],
    ticket: ticket.ticket,
    expectedGeneration: ticket.generation,
  });
  stage = "hello";
  const endpoint = JSON.parse(await readFile(join(home, "host/endpoint.json")));
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  stage = "browser authorization";
  const pairing = page.waitForResponse(
    (r) => r.url().endsWith("/host/auth/challenge") && r.request().method() === "POST",
  );
  await page.goto(endpoint.origin);
  const challenge = await (await pairing).json();
  await host.request("web.approve", {
    requestId: challenge.requestId,
    expectedGeneration: host.generation,
    scopes: ["observe", "submit", "approve", "manage"],
  });
  await page.getByRole("button", { name: /检查批准状态|Check approval/i }).click();
  await page.getByTestId("areal-workbench").waitFor({ timeout: 60000 });
  evidence.backendStatus = await host.request("backend.status", {});
  assert.equal(evidence.backendStatus.owned, false);
  assert.equal(evidence.backendStatus.service, null);
  evidence.reached.push("browser authorized against native Host without Node backend");
  stage = "settings";
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "云端", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Cloud 后端地址" })
    .fill(`http://127.0.0.1:${remote.address().port}/app-server/`);
  await page.getByRole("textbox", { name: "Cloud token", exact: true }).fill("fixture-token");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText(/配置已保存|credential helper exited without a result/).waitFor();
  assert.equal(
    await page.getByText("credential helper exited without a result").count(),
    0,
    "credential helper exited without a result",
  );
  assert.equal(allocations, 0);
  assert.equal(evidence.calls.length, 0);
  await page.screenshot({ path: join(root, "saved-without-connection.png") });
  evidence.reached.push("settings saved without remote allocation");
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await page.getByTestId("chat-input").waitFor();
  assert.equal(allocations, 0);
  assert.equal(await page.getByTestId("cloud-chat-input").count(), 0);
  assert.doesNotMatch(await page.locator(".composer-project-bar").innerText(), /Cloud|Local|本地/);
  assert.equal(evidence.calls.length, 0);
  await page.screenshot({ path: join(root, "draft-without-allocation.png") });
  evidence.reached.push("new project draft without allocation");
  stage = "cloud creation";
  const created = await rpc("desktop.command", {
    sourceId,
    command: "cloudSession",
    request: { operation: "create", projectId, requestId: randomUUID() },
  });
  assert.equal(created.threadId, thread.id);
  await page.reload();
  await page.getByTestId(`task-item-${thread.id}`).click();
  await page.waitForFunction(
    (id) => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId === id,
    thread.id,
  );
  await page.getByTestId("cloud-chat-input").waitFor();
  await page.getByTestId("cloud-chat-input").fill("first query");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_1", { exact: true }).waitFor();
  assert.equal(allocations, 1);
  assert.equal(queries, 1);
  await page.screenshot({ path: join(root, "connected-session.png") });
  evidence.reached.push("actual remote thread created and turn observed");
  stage = "reconnect";
  for (const ws of wss.clients) ws.close();
  await page
    .getByTestId("chat-view")
    .getByRole("button", { name: "恢复连接", exact: true })
    .waitFor();
  await page
    .getByTestId("chat-view")
    .getByRole("button", { name: "恢复连接", exact: true })
    .click();
  await page.getByTestId("cloud-chat-input").fill("second query");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_2", { exact: true }).waitFor();
  assert.equal(queries, 2);
  assert.equal(evidence.calls.filter((x) => x.method === "areal/thread/start").length, 1);
  await page.screenshot({ path: join(root, "reconnected.png") });
  evidence.reached.push("disconnect and reconnect preserves remote thread");
  stage = "offline completion";
  deferNext = true;
  await page.getByTestId("cloud-chat-input").fill("complete while offline");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor();
  for (const ws of wss.clients) ws.close();
  await page
    .getByTestId("chat-view")
    .getByRole("button", { name: "恢复连接", exact: true })
    .waitFor();
  assert.equal(await page.getByTestId("cloud-chat-input").getAttribute("contenteditable"), "false");
  const offline = thread.turns.at(-1);
  offline.status = "completed";
  offline.items = [{ id: "offline-answer", type: "agentMessage", text: "OFFLINE_COMPLETED" }];
  await page.screenshot({ path: join(root, "running-disconnected.png") });
  await page
    .getByTestId("chat-view")
    .getByRole("button", { name: "恢复连接", exact: true })
    .click();
  await page.getByText("OFFLINE_COMPLETED", { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("cloud-chat-input").getAttribute("contenteditable"), "true");
  assert.equal(queries, 3);
  assert.equal(evidence.calls.filter((x) => x.method === "areal/thread/start").length, 1);
  await page.screenshot({ path: join(root, "reconnected-completed.png") });
  evidence.reached.push("offline completion reconciled without replay");
  stage = "localized reconnect";
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const newValue = JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      locale: "en",
    });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
  assert.equal(await page.getByText("Cloud connected", { exact: true }).count(), 0);
  for (const ws of wss.clients) ws.close();
  await page
    .getByTestId("chat-view")
    .getByRole("button", { name: "Reconnect", exact: true })
    .waitFor();
  await page.screenshot({ path: join(root, "reconnect-english.png") });
  await page
    .getByTestId("chat-view")
    .getByRole("button", { name: "Reconnect", exact: true })
    .click();
  await page
    .getByTestId("chat-view")
    .getByRole("button", { name: "Reconnect", exact: true })
    .waitFor({ state: "hidden" });
  assert.equal(queries, 3);
  assert.equal(await page.getByText("Cloud connected", { exact: true }).count(), 0);
  await page.waitForFunction(
    () =>
      document.querySelector("[data-testid=cloud-chat-input]")?.getAttribute("contenteditable") ===
      "true",
  );
  await page.getByTestId("cloud-chat-input").fill("after reconnect");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_4", { exact: true }).waitFor();
  await page.evaluate(() => {
    const key = "areal-gui:application-preferences";
    const newValue = JSON.stringify({
      ...JSON.parse(localStorage.getItem(key) ?? "{}"),
      locale: "zh-CN",
    });
    localStorage.setItem(key, newValue);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
  });
  evidence.reached.push("localized reconnect without replay");
  stage = "rejected submission";
  rejectNext = true;
  await page.getByTestId("cloud-chat-input").fill("rejected draft");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("操作没有完成，请重试。", { exact: true }).waitFor();
  assert.equal(await page.getByText("提交结果未知", { exact: false }).count(), 0);
  assert.equal(queries, 4);
  assert.equal(await page.getByTestId("cloud-chat-input").innerText(), "rejected draft");
  assert.equal(await page.getByTestId("cloud-chat-input").getAttribute("contenteditable"), "true");
  evidence.reached.push("rejection retains draft");
  stage = "unknown";
  unknown = true;
  await page.getByTestId("cloud-chat-input").fill("keep this unknown draft");
  await page.getByTestId("cloud-chat-send").click();
  await page.getByText("QUERY_OK_5", { exact: true }).waitFor();
  await page.getByTestId("toast").filter({ hasText: "提交结果未知" }).waitFor();
  assert.equal(await page.getByTestId("cloud-chat-input").innerText(), "keep this unknown draft");
  assert.equal(queries, 5);
  const bounds = await page.getByTestId("toast").boundingBox();
  assert.ok(bounds.y < 100 && Math.abs(bounds.x + bounds.width / 2 - 720) < 5);
  assert.equal(await page.getByTestId("chat-view").getByRole("alert").count(), 0);
  await page.screenshot({ path: join(root, "unknown-receipt-draft.png") });
  evidence.reached.push("unknown receipt retains draft without replay");
  await page.getByRole("button", { name: "新聊天", exact: true }).click();
  await page.getByTestId("chat-input").waitFor();
  assert.equal(await page.getByTestId("cloud-chat-input").count(), 0);
  assert.doesNotMatch(await page.locator(".composer-project-bar").innerText(), /Cloud|Local|本地/);
  assert.equal(queries, 5);
  assert.equal(evidence.calls.filter((x) => x.method === "areal/thread/start").length, 1);
  await page.screenshot({ path: join(root, "new-draft-after-unknown.png") });
  assert.deepEqual(pageErrors, []);
  evidence.reached.push("new draft creates no remote session");
} catch (error) {
  evidence.firstFailure = { stage, message: error.message };
  if (page) await page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser?.close();
  socket?.terminate();
  transport?.close();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((r) => wss.close(r));
  await new Promise((r) => remote.close(r));
  try {
    if (host.generation) {
      const receipt = await host.stop(randomUUID(), host.generation, "cancel");
      evidence.cleanup.hostReceipt = receipt.state;
      assert.equal(receipt.state, "completed");
      host.close();
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        try {
          process.kill(hostPid, 0);
        } catch (e) {
          if (e.code === "ESRCH") {
            evidence.cleanup.hostExited = true;
            break;
          }
          evidence.cleanup.probeError = e.message;
          process.exitCode = 1;
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(evidence.cleanup.hostExited, true, "owned Host did not exit");
    }
  } catch (error) {
    evidence.cleanup.error = error.message;
    process.exitCode = 1;
  }
  host.close();
  try {
    if (evidence.cleanup.hostExited)
      evidence.cleanup.keychain = await cleanupSyntheticHostKeychain(home, root);
    if (release) await release();
  } catch (error) {
    evidence.cleanup.error = error.message;
    process.exitCode = 1;
  }
  evidence.unreached = [
    "settings saved without remote allocation",
    "new project draft without allocation",
    "actual remote thread created and turn observed",
    "disconnect and reconnect preserves remote thread",
    "offline completion reconciled without replay",
    "localized reconnect without replay",
    "rejection retains draft",
    "unknown receipt retains draft without replay",
    "new draft creates no remote session",
  ].filter((x) => !evidence.reached.includes(x));
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(evidence));
}
