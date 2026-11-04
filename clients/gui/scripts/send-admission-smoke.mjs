import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applicationFixture } from "./application-fixture.mjs";
import { assertApplicationStopped, closeSmokeApplication } from "./application-cleanup.mjs";
import { randomUUID } from "node:crypto";
import { respondToSessionName } from "./model-fixture.mjs";
import { captureSmokeFailure } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN;
const failList = process.env.AREAL_SEND_LIST_FAILURE === "1";
const beforeCreate = process.env.AREAL_SEND_LIST_BEFORE_CREATE === "1";
assert.ok(binary && isAbsolute(binary), "Set AREAL_CORE_BIN to an absolute fixed Core binary");
const scratch = await makeTempDir("send-admission-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: join(scratch, "config.toml"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  NO_PROXY: [env.NO_PROXY, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
  no_proxy: [env.no_proxy, "127.0.0.1,localhost,::1"].filter(Boolean).join(","),
});
const requests = [],
  errors = [],
  checks = [];
const originalText = "Send this exact first message once while the conversation list is held.";
const server = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "SEND_ADMISSION_COMPLETE" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
const tracePath = join(scratch, "boundary-trace.jsonl");
const listGate = join(scratch, "conversation-list.gate");
const submissionGate = join(scratch, "submission.gate");
const submissionEntered = join(scratch, "submission-entered.json");
const bootstrap = `
const { CoreBackend } = require(${JSON.stringify(join(gui, "app/src/core/backend.cjs"))});
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
let sequence = 0;
const record = value => appendFileSync(${JSON.stringify(tracePath)}, JSON.stringify({ sequence: ++sequence, at: Date.now(), ...value }) + '\\n');
const execute = CoreBackend.prototype.dispatchCommand;
CoreBackend.prototype.dispatchCommand = async function(invocation, ...args) {
  const { name, request: params } = invocation;
  const gate = existsSync(${JSON.stringify(submissionGate)}) ? JSON.parse(readFileSync(${JSON.stringify(submissionGate)}, 'utf8')) : null;
  if (gate?.name === name) {
    writeFileSync(${JSON.stringify(submissionEntered)}, JSON.stringify({ name }));
    const deadline = Date.now() + 30000;
    while (existsSync(${JSON.stringify(submissionGate)})) {
      if (Date.now() > deadline) throw new Error('Fixture submission gate was not released');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (gate.mode === 'reject') throw new Error('Fixture rejected message before dispatch');
    if (gate.mode === 'unknown') throw Object.assign(new Error('Fixture submission result unknown'), {
      submissionUnknown: true, requestId: gate.requestId, code: 'UNKNOWN',
    });
  }
  const project = this.projects.get(params?.projectId);
  if (name === 'create' && project?.client && !project.client.__sendAdmissionTrace) {
    record({ boundary: 'createCommand', mode: params.worktree?.mode ?? 'source', requestId: params.requestId });
    const client = project.client;
    client.__sendAdmissionTrace = true;
    const request = client.request.bind(client);
    let admitted = false, held = false;
    client.request = async function(method, ...args) {
      const id = ++sequence;
      record({ boundary: 'rpc', phase: 'start', id, method });
      try {
        const value = await request(method, ...args);
        if (!held && method === 'areal/conversation/list' && (${JSON.stringify(beforeCreate)} || admitted)) {
          held = true;
          record({ boundary: 'listGate', phase: 'held', method, admitted, responseReady: true });
          const deadline = Date.now() + 60000;
          while (existsSync(${JSON.stringify(listGate)})) {
            if (Date.now() > deadline) throw new Error('Fixture conversation-list gate was not released');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          record({ boundary: 'listGate', phase: 'released', method });
          if (${JSON.stringify(failList)}) throw new Error('Fixture conversation-list failure');
        }
        if (method === 'areal/thread/start') {
          admitted = true;
          record({ boundary: 'threadAdmission', phase: 'accepted', method, requestId: args[0]?.requestId });
        }
        record({ boundary: 'rpc', phase: 'finish', id, method, ok: true });
        return value;
      } catch (error) {
        record({ boundary: 'rpc', phase: 'finish', id, method, ok: false, code: error.code });
        throw error;
      }
    };
  }
  const result = await execute.call(this, invocation, ...args);
  if (gate?.mode === 'lost-after-acceptance' && gate.name === name) {
    record({ boundary: 'lostAfterAcceptance', phase: 'accepted', requestId: params.requestId, result });
    throw Object.assign(new Error('Fixture lost accepted receipt'), { submissionUnknown: true, requestId: params.requestId, code: 'UNKNOWN' });
  }
  return result;
};
`;
const hash = async () =>
  createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
const coreHash = await hash();
const source = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const guiDiffHash = createHash("sha256")
  .update(execFileSync("git", ["diff", "HEAD", "--", "clients/gui"], { cwd: root }))
  .digest("hex");
let application,
  app,
  page,
  metadata,
  passed = false,
  failure,
  cleanup,
  heldObservation,
  createPreviewFailure;
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
const project = (value) => value.projects.find((item) => item.root === workspace);
const trace = async () =>
  (
    await readFile(tracePath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    })
  )
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
const until = async (read, label, timeout = 45000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`Timeout: ${label}`);
};
const editorText = () => page.getByTestId("chat-input").innerText();
const capture = async (name) => {
  await page.screenshot({ path: join(scratch, `${name}.png`) });
  await writeFile(
    join(scratch, `${name}.json`),
    JSON.stringify(
      {
        snapshot: await snapshot(),
        editorText: await editorText(),
        modelRequests: requests.length,
        trace: await trace(),
      },
      null,
      2,
    ),
  );
};
console.log("Send admission evidence:", scratch);
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    env.AREAL_CORE_CONFIG,
    `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\n`,
  );
  await writeFile(listGate, "held");
  application = await applicationFixture(gui, join(scratch, "app"), bootstrap);
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  app.process().stderr.on("data", (chunk) => {
    void writeFile(join(scratch, "electron.log"), chunk, { flag: "a" });
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "Desktop ready");
  metadata = await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until(
    async () =>
      project(await snapshot())?.state?.connected && project(await snapshot())?.summariesLoaded,
    "Project and navigation summaries ready",
  );
  await page.evaluate(() =>
    localStorage.setItem(
      "areal-gui:application-preferences",
      JSON.stringify({ nextPromptSuggestions: false }),
    ),
  );
  await page.reload();
  await until(
    async () =>
      (await snapshot()).connection?.state === "ready" &&
      project(await snapshot())?.state?.connected,
    "Reloaded isolated preferences",
  );
  await writeFile(submissionGate, JSON.stringify({ name: "create" }));
  await page.getByTestId("chat-input").fill(originalText);
  await page.getByTestId("chat-send-button").click();
  await until(() => readFile(submissionEntered, "utf8").catch(() => false), "Create dispatch held");
  await page.getByTestId("pending-message").waitFor();
  assert.equal((await editorText()).trim(), "", "Composer clears before thread creation returns");
  try {
    assert.equal(
      await page.getByTestId("pending-message").locator(".user-bubble").innerText(),
      originalText,
    );
  } catch (error) {
    createPreviewFailure = error.stack;
    await capture("create-preview-failure");
  }
  assert.match(
    await page.getByTestId("pending-message").getByRole("status").innerText(),
    /正在启动聊天|Starting your chat/,
  );
  assert.equal(requests.length, 0, "Local preview never claims model admission");
  await capture("create-pending");
  if (!createPreviewFailure) {
    checks.push(
      "New-chat content moves to the transcript before real create dispatch; starting status is visible",
    );
  }
  await rm(submissionGate);
  await until(
    async () =>
      (await trace()).some((item) => item.boundary === "listGate" && item.phase === "held"),
    "Conversation-list response held",
  );
  try {
    await until(
      async () => {
        const current = project(await snapshot());
        const user = Object.values(current?.state?.threads ?? {})
          .flatMap((thread) => thread.turns ?? [])
          .flatMap((turn) => turn.items ?? [])
          .find(
            (item) =>
              item.type === "userMessage" &&
              item.content?.some((part) => part.text === originalText),
          );
        const visible = await page.locator(".user-message-body").allTextContents();
        return (
          requests.length === 1 &&
          (await editorText()).trim() === "" &&
          user &&
          visible.includes(originalText)
        );
      },
      "First message admitted, visible and Composer cleared while list response is held",
      10000,
    );
  } catch (error) {
    failure = error.stack;
  }
  heldObservation = {
    modelRequests: requests.length,
    editorText: await editorText(),
    admittedBeforeRelease: !failure,
    trace: await trace(),
  };
  await capture("list-held");
  console.log(
    heldObservation.admittedBeforeRelease
      ? "PASS: first message is visible and Composer clears while the conversation-list response is held"
      : "FAIL: conversation-list response blocks the first message while its text remains in Composer",
  );
  await rm(listGate);
  await until(async () => requests.length > 0, "Original message reaches model after list release");
  await until(
    async () => (await editorText()).trim() === "",
    "Composer clears after send admission",
  );
  await until(
    async () =>
      Object.values(project(await snapshot())?.state?.threads ?? {}).some((thread) =>
        thread.turns.some((turn) =>
          turn.items.some(
            (item) =>
              item.type === "agentMessage" && item.text?.includes("SEND_ADMISSION_COMPLETE"),
          ),
        ),
      ),
    "Reply completes",
  );
  await capture("after-release");
  if (failList) {
    await until(
      async () =>
        Object.values(project(await snapshot())?.refreshErrors ?? {}).some(
          (error) =>
            error.scope === "threadList" &&
            error.operation?.method === "areal/thread/start" &&
            error.message.includes("Fixture conversation-list failure"),
        ),
      "Background list failure remains visible",
    );
    checks.push("Background list failure remains attached to the accepted create operation");
  }
  assert.equal(requests.length, 1, "One UI submission reaches the model exactly once");
  const messageText = (message) =>
    typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((part) => part.text ?? "").join("\n");
  const userMessages = requests[0].messages.filter(
    (message) =>
      message.role === "user" &&
      !messageText(message).startsWith("AReaL runtime context (not a user request):"),
  );
  assert.equal(userMessages.length, 1, "The fixture receives one user message");
  assert.equal(
    messageText(userMessages[0]),
    originalText,
    "The exact original text reaches the model",
  );
  assert.equal(
    (await trace()).filter((item) => item.boundary === "threadAdmission").length,
    1,
    "Delayed observation never replays thread creation",
  );
  const create = (await trace()).filter((item) => item.boundary === "createCommand");
  assert.equal(create.length, 1, "One Send issues one create command");
  assert.equal(
    create[0].mode,
    "source",
    "Fresh drafts use the source directory unless the user opts into a worktree",
  );
  assert.equal(
    (await trace()).find((item) => item.boundary === "threadAdmission")?.requestId,
    create[0].requestId,
    "Core accepts the original creation request UUID once",
  );
  const finalProject = project(await snapshot());
  const binding = finalProject.worktreeOperations?.find(
    (item) => item.requestId === create[0].requestId,
  );
  assert.equal(binding?.usesSource, true, "Source-mode send retains its source-directory binding");
  assert.equal(
    binding?.state,
    "ready",
    "Source-mode send completes its existing creation lifecycle",
  );
  assert.deepEqual(errors, [], "No renderer or fixture errors");
  checks.push("Releasing the list delivers the exact original text once and completes a reply");
  assert.equal(
    heldObservation.admittedBeforeRelease,
    true,
    "Conversation-list responses must not block fresh source-mode message admission",
  );
  checks.push(
    "An accepted create permits the first message and clears Composer while the list refresh is held",
  );
  const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
  const draftKey = `areal-gui:draft:${finalProject.id}:${threadId}`;
  const requestId = "5594d99b-13a1-4ad8-8685-ef43a6580684";
  for (const mode of ["lost-after-acceptance", "pass", "reject", "unknown"]) {
    const text = `Submission feedback ${mode}`;
    const count = requests.length;
    await rm(submissionEntered, { force: true });
    await writeFile(submissionGate, JSON.stringify({ name: "send", mode, requestId }));
    await page.getByTestId("chat-input").fill(text);
    await page.locator("input[type=file]").setInputFiles({
      name: "message.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retained attachment"),
    });
    await page.getByTestId("chat-send-button").click();
    await until(() => readFile(submissionEntered, "utf8").catch(() => false), "Send dispatch held");
    const preview = page.getByTestId("pending-message");
    await preview.waitFor();
    assert.equal((await editorText()).trim(), "", "In-flight Composer is empty before acceptance");
    assert.equal(await preview.locator(".user-bubble").innerText(), text);
    assert.match(await preview.innerText(), /message.txt/);
    assert.equal(
      await page.getByTestId("composer-attachments").isVisible(),
      false,
      "Attachments move out of Composer during submission",
    );
    assert.equal(
      await page.evaluate((key) => localStorage.getItem(key), draftKey),
      text,
      "Recovery draft survives local presentation",
    );
    assert.equal(requests.length, count, "Held command cannot reach the model");
    await page.getByTestId("chat-input").press("Enter");
    await capture(`send-pending-${mode}`);
    await rm(submissionGate);
    await preview.waitFor({ state: "detached" });
    if (mode === "pass") {
      await until(
        async () =>
          requests.length === count + 1 &&
          project(await snapshot()).state.threads[threadId].turns.at(-1)?.status === "completed",
        "Delayed send completes exactly once",
      );
      assert.equal((await editorText()).trim(), "");
      assert.equal(
        await page.locator(".user-message-body").filter({ hasText: text }).count(),
        1,
        "Core history replaces the local preview without duplication",
      );
      await page.getByTestId("chat-input").focus();
      await app.evaluate(async ({ BrowserWindow }) => {
        const debug = BrowserWindow.getAllWindows()[0].webContents.debugger;
        debug.attach("1.3");
        await debug.sendCommand("Input.imeSetComposition", {
          text: "你好",
          selectionStart: 2,
          selectionEnd: 2,
        });
      });
      try {
        await page.waitForFunction(
          () =>
            document
              .querySelector('[data-testid="chat-input"]')
              .textContent.replaceAll("\u200b", "") === "你好",
        );
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(key), draftKey),
          null,
          "Uncommitted input after send stays out of recovery storage",
        );
        await app.evaluate(async ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.debugger.sendCommand("Input.insertText", {
            text: "你好",
          }),
        );
        await page.waitForFunction((key) => localStorage.getItem(key) === "你好", draftKey);
        assert.equal(
          requests.length,
          count + 1,
          "Committing an input-method candidate never sends it",
        );
        checks.push(
          "After send, native Chromium composition remains local until commitment and never triggers submission",
        );
      } finally {
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.debugger.detach(),
        );
      }
    } else if (mode === "lost-after-acceptance") {
      await until(
        async () => requests.length === count + 1,
        "Accepted message reaches provider exactly once",
      );
      await until(
        async () =>
          (await trace()).some(
            (event) => event.boundary === "lostAfterAcceptance" && event.phase === "accepted",
          ),
        "Accepted result recorded before loss",
      );
      const accepted = (await trace()).findLast(
        (event) => event.boundary === "lostAfterAcceptance" && event.phase === "accepted",
      );
      assert.ok(accepted.requestId, "Accepted request ID is recorded before receipt loss");
      await until(
        async () =>
          project(await snapshot()).state.threads[threadId].turns.some(
            (turn) =>
              turn.status === "completed" &&
              turn.items.some(
                (item) =>
                  item.type === "userMessage" && item.content.some((part) => part.text === text),
              ),
          ),
        "Accepted turn appears in authoritative snapshot",
      );
      await writeFile(
        join(scratch, "lost-after-acceptance-snapshot.json"),
        JSON.stringify(await snapshot(), null, 2),
      );
      await capture("send-lost-after-acceptance");
      await page.reload();
      await page.getByTestId("chat-input").waitFor();
      await until(async () => {
        const visible = await page.locator(".user-message-body").filter({ hasText: text }).count();
        const draft = (await editorText()).trim();
        const sendDisabled = await page.getByTestId("chat-send-button").isDisabled();
        return visible === 1 && (draft !== text || sendDisabled);
      }, "Accepted history is visible and the recovered draft cannot be submitted again");
      assert.equal(requests.length, count + 1, "Reload does not duplicate accepted request");
      assert.equal(
        await page.locator(".user-message-body").filter({ hasText: text }).count(),
        1,
        "Accepted history contains one user message",
      );
    } else {
      await until(
        async () => (await editorText()).trim() === text,
        "Rejected or unknown content restored",
      );
      assert.equal(
        await page.getByTestId("composer-attachments").isVisible(),
        true,
        "Unaccepted attachments are restored",
      );
      assert.equal(requests.length, count, "Failure never resends automatically");
      await capture(`send-restored-${mode}`);
      if (mode === "unknown") {
        assert.equal(
          await page.evaluate((key) => localStorage.getItem(`${key}:pending`), draftKey),
          requestId,
          "Original unknown request is retained for reconciliation",
        );
        await page.reload();
        await page.getByTestId("chat-input").waitFor();
        await until(
          async () => (await editorText()).trim() === text,
          "Unknown draft survives renderer reload",
        );
        assert.equal(requests.length, count, "Reload does not replay the unknown request");
        assert.equal(
          await page.getByTestId("chat-send-button").isDisabled(),
          true,
          "Unknown receipt blocks duplicate submission",
        );
      }
    }
    checks.push(
      `Delayed existing-chat ${mode}: text and attachment preview, empty Composer, no duplicate dispatch, ${mode === "pass" ? "Core handoff" : mode === "lost-after-acceptance" ? "accepted history survives reload without resubmission" : "draft restoration"}`,
    );
  }
  assert.deepEqual(errors, [], "No renderer or fixture errors after submission feedback checks");
  if (createPreviewFailure) throw new Error(`First-message preview: ${createPreviewFailure}`);
  passed = true;
} catch (error) {
  failure ??= error.stack;
  console.error(error.message);
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  await rm(listGate, { force: true });
  const descriptor = await readFile(
    join(env.AREAL_HARNESS_SERVICE_HOME, "host", "host.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (descriptor) {
    const { HostClient } = require("./src/core/host-client.cjs");
    const host = new HostClient();
    try {
      await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
      assert.equal(host.hostId, descriptor.hostId);
      assert.equal(host.generation, descriptor.generation);
      const receipt = await host.stop(randomUUID(), descriptor.generation, "cancel");
      await writeFile(join(scratch, "host-stop.json"), JSON.stringify(receipt, null, 2));
      assert.equal(receipt.state, "completed");
    } catch (error) {
      failure ??= `Host stop: ${error.stack}`;
      passed = false;
    } finally {
      host.close();
    }
  }
  if (app) {
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async (...args) => ({
          response: ["确认取消后台任务？", "退出 AReaL Harness？"].includes(args.at(-1).message)
            ? 1
            : (args.at(-1).cancelId ?? 0),
        });
      })
      .catch(() => {});
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    try {
      await closeSmokeApplication(app);
    } catch (error) {
      failure ??= error.stack;
      passed = false;
    }
  }
  await application?.close();
  try {
    await assertApplicationStopped(binary, env, metadata);
    cleanup = "passed";
  } catch (error) {
    cleanup = error.stack;
    passed = false;
  }
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  assert.equal(await hash(), coreHash, "Core binary stays unchanged");
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        source,
        guiDiffHash,
        binary,
        coreHash,
        originalText,
        failList,
        beforeCreate,
        checks,
        heldObservation,
        createPreviewFailure,
        failure,
        cleanup,
        errors,
        boundaries:
          "Source Electron and real Core. Deterministic loopback model. Filesystem barriers hold create/send dispatch and a real conversation-list response. Rejection and UNKNOWN are injected before send dispatch; lost-after-acceptance calls actual dispatch then discards its result; accepted sends use real Core/model requests. Native folder picker stubbed. Deadline controls fixture completion, not a latency benchmark. No packaged app or physical input.",
      },
      null,
      2,
    ),
  );
  console.log("Send admission result:", passed ? "PASS" : "FAIL");
  if (!passed) process.exitCode = 1;
}
