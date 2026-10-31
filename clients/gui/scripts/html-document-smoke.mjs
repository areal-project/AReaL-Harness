import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { makeTempDir } from "./support/temp.mjs";
import { selectConversation, captureSmokeFailure } from "./smoke-navigation.mjs";
import { assertApplicationStopped, closeRecordedSmokeApplication } from "./application-cleanup.mjs";
import { respondToSessionName } from "./model-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const binary = process.env.AREAL_CORE_BIN;
assert.ok(binary && isAbsolute(binary), "Set AREAL_CORE_BIN to an isolated fixed deployment");
const scratch = await makeTempDir("areal-html-document-");
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const outside = join(scratch, "quiz.html"),
  inside = join(workspace, "report.html");
await writeFile(
  outside,
  `<!doctype html><title>Local quiz</title><h1>LOCAL_HTML_QUIZ</h1><a href="#answer" id="toc">Answer section</a><button id="answer">Choose correct answer</button><output id="result"></output><script>document.querySelector('#answer').onclick=()=>document.querySelector('#result').textContent='CORRECT';</script>`,
);
await writeFile(join(scratch, "sibling.js"), "secret");
await writeFile(
  inside,
  `<!doctype html><title>Workspace report</title><h1>WORKSPACE_HTML_REPORT</h1><link rel="stylesheet" href="style.css"><script type="module" src="main.mjs"></script><img src="image.svg"><button id="answer">Answer</button><output id="result"></output>`,
);
await writeFile(join(workspace, "style.css"), "h1 { color: rgb(1, 2, 3) }");
await writeFile(
  join(workspace, "main.mjs"),
  "import {answer} from './answer.js'; document.querySelector('#answer').onclick=()=>document.querySelector('#result').textContent=answer;window.moduleReady=true",
);
await writeFile(join(workspace, "answer.js"), "export const answer='WORKSPACE_CORRECT'");
await writeFile(
  join(workspace, "image.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="12" height="12"/></svg>',
);
const checks = [],
  errors = [],
  facts = { histories: {}, approvals: [] };
let activeScenario,
  application,
  page,
  projectId,
  passed = false;
const model = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, res)) return;
    const system = body.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason) =>
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    if (system.includes("Predict the next user prompt")) send({ content: "" }, "stop");
    else if (system.includes("AReaL permission review.")) {
      const packet = JSON.parse(body.messages.findLast((m) => m.role === "user").content);
      send(
        {
          content: JSON.stringify({
            decision: "ask",
            reason: "Fixture requires review of the file scope.",
            digest: packet.digest,
          }),
        },
        "stop",
      );
    } else {
      assert.ok(activeScenario);
      if (activeScenario.input && !activeScenario.sent) {
        activeScenario.sent = true;
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: activeScenario.id,
                type: "function",
                function: { name: "browser_v1", arguments: JSON.stringify(activeScenario.input) },
              },
            ],
          },
          "tool_calls",
        );
      } else send({ content: activeScenario.reply ?? "HTML acceptance completed." }, "stop");
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    errors.push(error.stack);
    res.end();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(userHome, ".areal/config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      {
        id: "fixture",
        revision: "v1",
        displayName: "Fixture",
        instructions: "Use the requested browser operation.",
      },
    ],
  }),
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_CORE_CONFIG: join(userHome, ".areal/config.toml"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_BIN: binary,
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
  "ELECTRON_RUN_AS_NODE",
])
  delete env[key];
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error(`Timeout: ${label}`);
}
const snapshot = () => page.evaluate(() => window.arealDesktop.snapshot());
async function command(name, params) {
  const result = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
const thread = async (id) =>
  (await snapshot()).projects.find((p) => p.id === projectId)?.state?.threads?.[id];
const preview = (threadId, operation, extra = {}) =>
  page.evaluate((request) => window.arealDesktop.preview(request), {
    projectId,
    threadId,
    operation,
    ...extra,
  });
const nativeScript = (id, code) =>
  application.evaluate(
    ({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code),
    { id, code },
  );
const nativeId = async (url) =>
  until(
    () =>
      application.evaluate(
        ({ webContents }, url) =>
          webContents.getAllWebContents().find((c) => c.getURL() === url)?.id,
        url,
      ),
    "native document",
  );
const urlDenied = (url) =>
  new Promise((resolve) => {
    const u = new URL(url);
    const req = request(
      { host: "127.0.0.1", port: u.port, path: u.pathname, headers: { host: u.host } },
      (res) => {
        res.resume();
        resolve(res.statusCode === 403);
      },
    );
    req.on("error", () => resolve(true));
    req.end();
  });
async function run(threadId, scenario) {
  activeScenario = { ...scenario, sent: false };
  const previous = (await thread(threadId))?.turns?.at(-1)?.id;
  await command("send", { projectId, threadId, text: `HTML acceptance ${scenario.id}` });
  const answered = new Set();
  await until(async () => {
    const state = await snapshot();
    const owner = state.projects.find((p) => p.id === projectId);
    const interaction = owner?.state?.interactions?.[threadId]?.data?.find(
      (i) => i.kind === "approval" && i.status === "pending" && !answered.has(i.requestId),
    );
    if (interaction) {
      answered.add(interaction.requestId);
      facts.approvals.push(interaction);
      if (scenario.input?.operation === "openDocument") {
        assert.equal(interaction.effectiveArguments.plan.operation, "openDocument");
        const document = interaction.effectiveArguments.plan.document;
        assert.equal(document.scope.canonicalFile, scenario.input.parameters.path);
        assert.equal(document.scope.kind, scenario.scope);
        assert.match(document.entryDigest, /^[a-f0-9]{64}$/);
        if (!scenario.background) {
          const panel = page.locator('[data-interaction="approval"]');
          await panel.waitFor();
          const details = panel.locator("details.decision-card-details");
          if ((await details.getAttribute("open")) === null)
            await details.locator(":scope > summary").click();
          assert.ok((await panel.innerText()).includes(scenario.input.parameters.path));
          if (scenario.scope === "workspaceDirectory")
            assert.match(await panel.innerText(), /未在 HTML|not referenced/);
          await panel.screenshot({ path: join(scratch, `${scenario.id}-approval.png`) });
        }
      }
      await scenario.beforeApproval?.();
      await command("respond", {
        projectId,
        threadId,
        requestId: interaction.requestId,
        decision: scenario.deny ? "deny" : "allowOnce",
      });
    }
    const latest = owner?.state?.threads?.[threadId]?.turns?.at(-1);
    return (
      latest &&
      latest.id !== previous &&
      ["completed", "failed", "interrupted"].includes(latest.status)
    );
  }, scenario.id);
  const value = (await thread(threadId)).turns.at(-1);
  facts.histories[scenario.id] = value;
  assert.equal(value.status, "completed", JSON.stringify(value));
  if (scenario.input) {
    const calls = value.items.filter(
      (i) => i.type === "dynamicToolCall" && i.callId === scenario.id,
    );
    assert.equal(calls.length, 1, "exactly one tool dispatch");
    assert.equal(calls[0].success, !scenario.deny, JSON.stringify(calls[0]));
    if (scenario.input.operation === "openDocument")
      assert.equal(answered.size, 1, "file scope needs its own approval");
    return calls[0];
  }
}
try {
  application = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  page = await application.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "desktop ready");
  await application.evaluate(({ dialog, BrowserWindow }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(
    async () => (await snapshot()).projects.find((p) => p.root === workspace),
    "project",
  );
  projectId = project.id;
  const human = await command("create", {
    projectId,
    browserEnabled: true,
    profile: { id: "fixture", revision: "v1" },
  });
  await selectConversation(page, human.threadId);
  await run(human.threadId, { id: "human-link", reply: `[Open generated quiz](${outside})` });
  await page.getByText("Open generated quiz", { exact: true }).click();
  await page.locator(".preview-panel").waitFor();
  const humanState = await until(async () => {
    const s = await preview(human.threadId, "state");
    return s.url?.includes(".localhost:") ? s : null;
  }, "built-in local document");
  let humanUrl = humanState.url;
  const humanNative = await nativeId(humanUrl);
  await until(
    async () =>
      (await nativeScript(humanNative, "document.body.innerText")).includes("LOCAL_HTML_QUIZ"),
    "local HTML body",
  );
  await application.evaluate(({ webContents, BrowserWindow, app }, id) => {
    const c = webContents.fromId(id);
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
    c.focus();
    c.executeJavaScript(
      "(()=>{const r=document.querySelector('#answer').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
    ).then((p) => {
      c.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...p });
      c.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...p });
    });
  }, humanNative);
  await until(
    async () =>
      (await nativeScript(humanNative, "document.querySelector('#result').textContent")) ===
      "CORRECT",
    "native quiz input",
  );
  await nativeScript(
    humanNative,
    "document.querySelector('#toc').click();history.replaceState({},'', '?view=quiz#answer')",
  );
  assert.equal(await nativeScript(humanNative, "fetch(location.pathname).then(r=>r.status)"), 200);
  humanUrl = (await preview(human.threadId, "state")).url;
  assert.equal(
    await nativeScript(humanNative, "fetch('sibling.js').then(r=>r.status).catch(()=>403)"),
    403,
  );
  assert.ok(await urlDenied(humanUrl));
  await page.screenshot({ path: join(scratch, "human-window.png") });
  const png = await application.evaluate(
    async ({ webContents }, id) =>
      (await webContents.fromId(id).capturePage()).toPNG().toString("base64"),
    humanNative,
  );
  await writeFile(join(scratch, "human-native.png"), Buffer.from(png, "base64"));
  checks.push(
    "reply link opens external exact-file HTML in built-in Browser; native click runs quiz; sibling and copied URL denied",
  );
  await application.evaluate(({ shell }) => {
    globalThis.__openedHtml = [];
    shell.openPath = async (path) => {
      globalThis.__openedHtml.push(path);
      return "";
    };
  });
  await preview(human.threadId, "external", { pageId: humanState.browser.pageId });
  assert.deepEqual(await application.evaluate(() => globalThis.__openedHtml), [outside]);
  checks.push("explicit external action hands off the original validated HTML path");
  const agent = await command("create", {
    projectId,
    browserEnabled: true,
    profile: { id: "fixture", revision: "v1" },
  });
  await selectConversation(page, agent.threadId);
  await run(agent.threadId, { id: "describe", input: { operation: "describe", parameters: {} } });
  const agentPage = (await preview(agent.threadId, "state")).browser.pageId;
  const opened = await run(agent.threadId, {
    id: "open-workspace",
    input: { operation: "openDocument", parameters: { pageId: agentPage, path: inside } },
    scope: "workspaceDirectory",
  });
  assert.match(JSON.stringify(opened.contentItems), /confirmed/);
  await page.locator(".preview-panel").waitFor();
  const agentUrl = (await preview(agent.threadId, "state")).url,
    agentNative = await nativeId(agentUrl);
  await until(
    async () =>
      await nativeScript(
        agentNative,
        "window.moduleReady===true && document.querySelector('img').naturalWidth===12",
      ),
    "workspace modules and image",
  );
  assert.equal(
    await nativeScript(agentNative, "getComputedStyle(document.querySelector('h1')).color"),
    "rgb(1, 2, 3)",
  );
  assert.equal(
    await nativeScript(agentNative, "typeof require + ':' + typeof arealDesktop"),
    "undefined:undefined",
  );
  await page.screenshot({ path: join(scratch, "agent-window.png") });
  checks.push(
    "real Core prepare and explicit file-scope approval execute once, reveal current chat, load relative CSS/module/image without bridge",
  );
  await run(agent.threadId, {
    id: "observe-again",
    input: { operation: "observe", parameters: { pageId: agentPage } },
  });
  await run(agent.threadId, {
    id: "denied-document",
    input: { operation: "openDocument", parameters: { pageId: agentPage, path: outside } },
    scope: "exactHtml",
    deny: true,
  });
  assert.equal((await preview(agent.threadId, "state")).url, agentUrl);
  checks.push("denied document approval preserves the existing page without replay");
  await run(agent.threadId, {
    id: "background-document",
    input: { operation: "openDocument", parameters: { pageId: agentPage, path: outside } },
    scope: "exactHtml",
    background: true,
    beforeApproval: () => selectConversation(page, human.threadId),
  });
  assert.equal(
    await page.getByTestId("areal-workbench").getAttribute("data-thread-id"),
    human.threadId,
  );
  assert.equal((await preview(human.threadId, "state")).url, humanUrl);
  assert.ok(await urlDenied(agentUrl));
  checks.push(
    "background confirmed document reveal leaves current conversation and page selected; replacing document revokes old URL",
  );
  await preview(human.threadId, "reload", { pageId: humanState.browser.pageId });
  await until(
    async () =>
      (await nativeScript(humanNative, "document.querySelector('#result').textContent")) === "",
    "human reload snapshot",
  );
  await preview(human.threadId, "release", { pageId: humanState.browser.pageId, userIntent: true });
  assert.ok(await urlDenied(humanUrl));
  checks.push("human reload retains document capability after input; close releases the grant");
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  try {
    if (application) {
      const metadata = await readFile(join(scratch, "core/service.json"), "utf8").then(
        JSON.parse,
        () => null,
      );
      await application.evaluate(
        ({ app, BrowserWindow, dialog }, tracePath) => {
          const fs = process.getBuiltinModule("node:fs");
          const append = (entry) => fs.appendFileSync(tracePath, `${JSON.stringify(entry)}\n`);
          append({ event: "instrumented", windows: BrowserWindow.getAllWindows().length });
          for (const event of ["before-quit", "will-quit"])
            app.on(event, (detail) => append({ event, prevented: detail.defaultPrevented }));
          for (const window of BrowserWindow.getAllWindows())
            window.on("close", (detail) =>
              append({ event: "window-close", prevented: detail.defaultPrevented }),
            );
          const original = dialog.showMessageBox;
          dialog.showMessageBox = async (...args) => {
            const options = args.at(-1);
            append({ event: "dialog", options });
            return options?.type === "question" && /退出|关闭/.test(options.message ?? "")
              ? { response: 1, checkboxChecked: false }
              : original(...args);
          };
        },
        join(scratch, "quit-trace.jsonl"),
      );
      await closeRecordedSmokeApplication(application);
      assert.ok(metadata, "isolated desktop service metadata is available");
      await assertApplicationStopped(binary, env, metadata);
    }
    facts.cleanup = { stopped: true };
  } catch (error) {
    passed = false;
    facts.cleanup = { stopped: false, error: error.stack ?? String(error) };
    errors.push(facts.cleanup.error);
  }
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  await writeFile(
    join(scratch, "manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        facts,
        scope:
          "source Electron, real Core and deterministic local model; no real provider or package acceptance",
        source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
        diffSHA256: createHash("sha256")
          .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
          .digest("hex"),
        coreBinary: binary,
        coreSHA256: createHash("sha256")
          .update(await readFile(binary))
          .digest("hex"),
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
  if (!passed) process.exitCode = 1;
}
