import { readTurnToolDetails } from "./support/tool-history.mjs";
import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { selectConversation, captureSmokeFailure } from "./smoke-navigation.mjs";

// B-10–B-13: public GUI/Core approval and actual native input against a synthetic site.
const capacityMode = process.argv[2] ?? "act";
assert.ok(["act", "batch", "b1"].includes(capacityMode));
const privacyMode = process.env.AREAL_BROWSER_B1_PRIVACY === "1";
assert.ok(!privacyMode || capacityMode === "b1");
const privateValue = "AZ7q9n42",
  notesValue = "BX8r0m53";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-browser-actions-");
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
await mkdir(workspace);
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const siteFacts = { gets: 0, posts: 0, effects: {} };
const site = createServer(async (request, response) => {
  if (request.method === "POST") {
    siteFacts.posts++;
    const effect = new URL(request.url, "http://fixture").searchParams.get("kind");
    if (effect) siteFacts.effects[effect] = (siteFacts.effects[effect] ?? 0) + 1;
    for await (const _chunk of request) {
      /* consume fixture request without logging values */
    }
    response.end("ok");
    return;
  }
  siteFacts.gets++;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Action fixture</title>
    <button id="submit" onclick="fetch('/effect',{method:'POST'})">Submit action</button>
    <button id="disabled" disabled>Disabled action</button>
    <form id="form"><label>Draft <input id="draft"></label><button type="submit">Send draft</button></form>
    ${
      capacityMode === "b1"
        ? `<label id="choice-label">Native choice <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Closed</option></select></label>
    ${privacyMode ? `<label>Private password <input id="password" type="password" value="${privateValue}"></label><label>Notes <input id="notes" value="${notesValue}"></label>` : ""}
    <label>Native check <input id="check" type="checkbox"></label>
    <label>Disabled check <input id="disabled-check" type="checkbox" disabled checked></label>
    <label>Multiple choice <select id="multiple" multiple><option value="a">Alpha</option><option value="b">Beta</option></select></label>
    <label>Radio check <input id="radio" type="radio" role="checkbox"></label>
    <button id="hover">Hover menu</button><div id="menu" hidden>Visible hover menu</div>
    <div style="height:1200px"></div><div id="sentinel">Lower sentinel</div>`
        : ""
    }
    <script>window.keyFacts={downs:[],ups:[],submits:0};
    window.controlFacts={click:0,input:0,change:0,hover:0,scroll:0,selectInput:0,selectChange:0};
    const effect=kind=>fetch('/effect?kind='+kind,{method:'POST'});
    document.querySelector('#check')?.addEventListener('click',()=>{controlFacts.click++;effect('checkClick')});
    for(const kind of ['input','change']) {
      document.querySelector('#check')?.addEventListener(kind,()=>{controlFacts[kind]++;effect('check'+kind)});
      document.querySelector('#choice')?.addEventListener(kind,()=>{controlFacts[kind==='input'?'selectInput':'selectChange']++;effect('select'+kind)});
    }
    ${privacyMode ? `document.querySelector('#choice').addEventListener('change',()=>{const option=document.querySelector('#choice').selectedOptions[0];option.value=document.querySelector(window.privateEchoSource||'#password').value;option.label=document.querySelector(window.privateEchoSource||'#password').value;effect('privateEcho')});` : ""}
    document.addEventListener('mouseenter',event=>{if(event.target.id==='hover'){controlFacts.hover++;document.querySelector('#menu').hidden=false;effect('hover')}},true);
    addEventListener('scroll',()=>{if(!controlFacts.scroll&&document.querySelector('#sentinel')?.getBoundingClientRect().top<innerHeight){controlFacts.scroll++;document.querySelector('#sentinel').insertAdjacentHTML('afterend','<p id=loaded>Loaded next segment</p>');effect('scroll')}});
    document.addEventListener('keydown',event=>window.keyFacts.downs.push({key:event.key,target:event.target.id}));
    document.addEventListener('keyup',event=>window.keyFacts.ups.push({key:event.key,target:event.target.id}));
    document.querySelector('#form').addEventListener('submit',event=>{
      window.keyFacts.submits++;
      event.preventDefault();fetch('/effect',{method:'POST',body:document.querySelector('#draft').value});
    });</script>`);
});
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteUrl = `http://${process.env.AREAL_BROWSER_B1_PUBLIC === "1" ? "browser-synthetic.localhost" : "127.0.0.1"}:${site.address().port}/`;
const publicB1 = process.env.AREAL_BROWSER_B1_PUBLIC === "1";
let pageId,
  mode =
    capacityMode === "b1"
      ? privacyMode
        ? "selectPrivacy"
        : publicB1
          ? "scroll"
          : "scrollDenied"
      : "deny";
let modelStage = -1;
const modelCalls = [];
const observationFrom = (value, depth = 0) => {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") {
    try {
      return observationFrom(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value))
    return value.map((item) => observationFrom(item, depth + 1)).find(Boolean) ?? null;
  if (typeof value !== "object") return null;
  if (value.observationId && Array.isArray(value.nodes)) return value;
  return (
    Object.values(value)
      .map((item) => observationFrom(item, depth + 1))
      .find(Boolean) ?? null
  );
};
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw),
      last = body.messages.at(-1);
    modelCalls.push({
      mode,
      lastRole: last?.role,
      browserToolAvailable: (body.tools ?? []).some((t) => t.function?.name === "browser_v1"),
    });
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
      );
    const tool = (id, args) => {
      send({
        tool_calls: [
          {
            index: 0,
            id,
            type: "function",
            function: { name: "browser_v1", arguments: JSON.stringify(args) },
          },
        ],
      });
      send({}, "tool_calls");
    };
    if (modelStage === -1) {
      modelStage = 0;
      tool("describe-entry", { operation: "describe", parameters: {} });
      response.end("data: [DONE]\n\n");
      return;
    }
    await until(() => pageId, "claimed native page");
    if (modelStage === 0) {
      modelStage = 1;
      tool(`observe-${mode}`, { operation: "observe", parameters: { pageId } });
    } else if (modelStage === 1 && capacityMode === "b1") {
      const observation = observationFrom(last.content);
      assert.ok(observation, `B1 observation for ${mode}`);
      events[`${mode}Observation`] = observation;
      const names = {
        hover: "Hover menu",
        choice: "Native choice",
        check: "Native check",
        disabled: "Disabled check",
        multiple: "Multiple choice",
        radio: "Radio check",
        submit: "Submit action",
      };
      const ref = (key) => {
        const node = observation.nodes.find((node) => node.name?.trim() === names[key] && node.ref);
        assert.ok(node, `${mode} has ${names[key]}`);
        return node.ref;
      };
      const select = {
        kind: "selectOption",
        ref: ref("choice"),
        value: mode === "selectDisabled" ? "c" : "b",
      };
      let input;
      if (mode.startsWith("wait")) {
        const condition =
          mode === "waitEnabledFalse"
            ? { kind: "enabled", ref: ref("disabled"), value: false }
            : mode === "waitEnabledTrue"
              ? { kind: "enabled", ref: ref("check"), value: true }
              : {
                  kind: "checked",
                  ref: ref(
                    [
                      "waitTransition",
                      "waitTimeout",
                      "waitCheckedFalse",
                      "waitTakeoverLate",
                    ].includes(mode)
                      ? "check"
                      : "disabled",
                  ),
                  value: mode !== "waitCheckedFalse",
                };
        input = {
          operation: "wait",
          parameters: {
            pageId,
            timeoutMs: mode === "waitTimeout" ? 300 : mode === "waitTakeoverLate" ? 10000 : 2000,
            condition,
          },
        };
      } else {
        const action = mode.startsWith("scroll")
          ? { kind: "scroll", target: "viewport", deltaX: 0, deltaY: 700 }
          : mode.startsWith("hover")
            ? { kind: "hover", ref: ref("hover") }
            : mode === "multiple"
              ? { kind: "selectOption", ref: ref("multiple"), value: "b" }
              : mode.startsWith("select")
                ? select
                : {
                    kind: "setChecked",
                    ref: ref(
                      mode === "checkDisabled"
                        ? "disabled"
                        : mode === "checkRadio"
                          ? "radio"
                          : "check",
                    ),
                    checked: mode !== "checkFalse",
                  };
        input = {
          operation: "act",
          parameters: { pageId, snapshotId: observation.observationId, action },
        };
        if (mode === "selectPrivacyBatch")
          input = {
            operation: "runBatch",
            parameters: {
              pageId,
              snapshotId: observation.observationId,
              steps: [{ operation: "act", snapshotId: observation.observationId, action: select }],
            },
          };
        if (mode === "batchPrefix" || mode === "batchUnknown")
          input = {
            operation: "runBatch",
            parameters: {
              pageId,
              snapshotId: observation.observationId,
              steps: [
                {
                  operation: "act",
                  snapshotId: observation.observationId,
                  action: { kind: "setChecked", ref: ref("check"), checked: true },
                },
                {
                  operation: "act",
                  snapshotId: observation.observationId,
                  action: mode === "batchUnknown" ? select : { kind: "hover", ref: ref("hover") },
                },
                {
                  operation: "act",
                  snapshotId: observation.observationId,
                  action: { kind: "click", ref: ref("submit") },
                },
              ],
            },
          };
      }
      if (mode === "scrollBeforePrepare")
        await app.evaluate(
          ({ webContents }, id) => webContents.fromId(id).executeJavaScript("scrollTo(0,40)"),
          nativeId,
        );
      if (mode === "selectBeforePrepare")
        await app.evaluate(
          ({ webContents }, id) =>
            webContents
              .fromId(id)
              .executeJavaScript(
                `{const o=document.querySelector('#choice option[value=b]');o.replaceWith(o.cloneNode(true))}`,
              ),
          nativeId,
        );
      modelStage = 2;
      tool(`act-${mode}`, input);
    } else if (modelStage === 1) {
      const observation = observationFrom(last.content);
      if (!observation) {
        send({ content: `Action ${mode} reviewed` });
        send({}, "stop");
      } else {
        const name =
          mode === "disabled"
            ? "Disabled action"
            : ["fill", "press"].includes(mode)
              ? "Draft"
              : "Submit action";
        const ref = observation.nodes.find((node) => node.name?.trim() === name && node.ref)?.ref;
        if (!ref) {
          send({ content: `No target ${name}` });
          send({}, "stop");
        } else {
          const action =
            mode === "fill"
              ? { kind: "fill", ref, value: "DRAFT_INPUT_04" }
              : ["press", "pressButton", "pressTab"].includes(mode)
                ? { kind: "press", ref, key: mode === "pressTab" ? "Tab" : "Enter" }
                : { kind: "click", ref };
          const input = {
            operation: "act",
            parameters: { pageId, snapshotId: observation.observationId, action },
          };
          if (mode === "forged") input.browserApproval = { decision: "allowOnce" };
          modelStage = 2;
          tool(`act-${mode}`, input);
        }
      }
    } else if (privacyMode && modelStage === 2) {
      events[`${mode}ModelResult`] = last.content;
      modelStage = 3;
      if (mode === "selectPrivacyNotes")
        tool(`post-observe-${mode}`, { operation: "observe", parameters: { pageId } });
      else {
        send({ content: `Action ${mode} reviewed` });
        send({}, "stop");
      }
    } else {
      if (privacyMode && last?.role === "tool") {
        events[`${mode}PostObservation`] = observationFrom(last.content);
        events[`${mode}PostObservationResult`] = last.content;
      }
      send({ content: `Action ${mode} reviewed` });
      send({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  } catch (error) {
    errors.push("fixture model: " + (error.stack ?? error.message));
    response.end("data: [DONE]\n\n");
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(userHome, ".areal", "config.toml"),
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
        instructions: "Use the requested browser tool.",
      },
    ],
  }),
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_DESKTOP_CONFIG: deployment,
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN || resolve(root, "target/debug/areal"),
};
for (const key of [
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_CONFIG",
  "AREAL_HARNESS_HOME",
  "AREAL_HARNESS_CONFIG",
])
  delete env[key];
const startedAt = new Date().toISOString(),
  checks = [],
  events = {},
  errors = [];
const fixtureApp = join(scratch, "app"),
  mainErrorsPath = join(scratch, "main-errors.jsonl");
await mkdir(fixtureApp);
await writeFile(mainErrorsPath, "");
await writeFile(
  join(fixtureApp, "package.json"),
  JSON.stringify({ name: "browser-actions-fixture", main: "bootstrap.cjs" }),
);
await writeFile(
  join(fixtureApp, "bootstrap.cjs"),
  `
process.on('uncaughtExceptionMonitor',(error,origin)=>require('node:fs').appendFileSync(${JSON.stringify(mainErrorsPath)},JSON.stringify({pid:process.pid,origin,name:error.name,message:error.message,stack:error.stack})+'\\n'));
require(${JSON.stringify(join(gui, "app/src/main.cjs"))});
`,
);
let app,
  appProcess,
  page,
  passed = false,
  projectId,
  threadId,
  nativeId;
async function until(predicate, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
}
async function snapshot() {
  return page.evaluate(() => window.arealDesktop.snapshot());
}
async function command(name, params) {
  const result = await page.evaluate(
    ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function currentThread() {
  return (await snapshot()).projects.find((item) => item.id === projectId)?.state?.threads?.[
    threadId
  ];
}
async function terminalTurn(previous) {
  const turn = await until(async () => {
    const turns = (await currentThread())?.turns ?? [];
    const last = turns.at(-1);
    return turns.length > previous && ["completed", "failed", "interrupted"].includes(last?.status)
      ? last
      : null;
  }, `terminal turn after ${mode}`);
  return readTurnToolDetails({
    command,
    readThread: currentThread,
    projectId,
    threadId,
    turnId: turn.id,
  });
}
function toolResult(turn) {
  const item = turn.items.find(
    (item) =>
      item.type === "dynamicToolCall" &&
      item.tool === "browser_v1" &&
      item.callId === `act-${mode}`,
  );
  assert.ok(item, `Core history contains act-${mode}`);
  return item;
}
async function nativeFacts() {
  return app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id)?.executeJavaScript(
        `({draft:document.querySelector('#draft')?.value,submitPresent:!!document.querySelector('#submit'),
      activeElement:document.activeElement?.id,keyFacts:window.keyFacts,
      controlFacts:window.controlFacts,checked:document.querySelector('#check')?.checked,
      choice:document.querySelector('#choice')?.value,scrollY,menu:document.querySelector('#menu')?.hidden})`,
      ),
    nativeId,
  );
}
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [fixtureApp],
    env,
    timeout: 120000,
  });
  appProcess = app.process();
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  events.runtime = await app.evaluate(({ app }) => ({
    product: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
  }));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await until(async () => (await snapshot()).connection?.state === "ready", "desktop ready");
  await app.evaluate(
    ({ app, dialog, BrowserWindow }, { path, origin, publicB1 }) => {
      if (publicB1)
        app.commandLine.appendSwitch(
          "host-resolver-rules",
          "MAP browser-synthetic.localhost 127.0.0.1",
        );
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      const original = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1);
        if (
          options?.title === "允许本地开发站点" &&
          options.message === `允许此浏览工作区访问 ${origin}？`
        ) {
          globalThis.__m1OriginPrompt = {
            origin,
            title: options.title,
            count: (globalThis.__m1OriginPrompt?.count ?? 0) + 1,
          };
          return { response: 1, checkboxChecked: false };
        }
        return original(...args);
      };
      BrowserWindow.getAllWindows()[0].setSize(1440, 960);
    },
    { path: workspace, origin: new URL(siteUrl).origin, publicB1 },
  );
  await page.evaluate(() => window.arealDesktop.chooseProject());
  const project = await until(
    async () =>
      (await snapshot()).projects.find((item) => item.root === workspace && item.state?.connected),
    "project ready",
  );
  projectId = project.id;
  const first = await command("create", {
    projectId,
    browserEnabled: true,
    profile: { id: "fixture", revision: "v1" },
  });
  threadId = first.threadId;
  await selectConversation(page, threadId);
  await page.keyboard.press("Meta+t");
  await page.locator(".preview-panel").waitFor();
  await app.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
  });
  await until(
    () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
    "focused Main Origin prompt",
  );
  await page.evaluate(
    ({ projectId, threadId, url }) =>
      window.arealDesktop.preview({ operation: "navigate", projectId, threadId, url }),
    { projectId, threadId, url: siteUrl },
  );
  events.developmentOriginPrompt = await app.evaluate(() => globalThis.__m1OriginPrompt);
  if (!publicB1) {
    assert.equal(
      events.developmentOriginPrompt?.count ?? 0,
      0,
      "ordinary navigation requires no development-Origin prompt",
    );
    events.developmentOriginPrompt = { count: 0, boundary: "current ordinary-navigation policy" };
  }
  nativeId = await until(
    () =>
      app.evaluate(
        ({ webContents }, url) =>
          webContents.getAllWebContents().find((c) => c.getURL() === url)?.id,
        siteUrl,
      ),
    "native page",
  );
  await command("send", {
    projectId,
    threadId,
    text: "Use the browser to inspect the fixture page and perform the requested action.",
  });
  const entryApproval = page.locator('[data-interaction="approval"]');
  await entryApproval.waitFor({ timeout: 60000 });
  assert.match(await entryApproval.innerText(), /describe/);
  await entryApproval.getByRole("button", { name: "允许一次", exact: true }).click();
  pageId = (
    await until(async () => {
      const value = await page.evaluate(
        ({ projectId, threadId }) =>
          window.arealDesktop.preview({ operation: "state", projectId, threadId }),
        { projectId, threadId },
      );
      return value.browser?.control === "agent" ? value : null;
    }, "claim")
  ).browser.pageId;
  await app.evaluate(({ webContents }, id) => {
    const debuggerApi = webContents.fromId(id).debugger;
    const send = debuggerApi.sendCommand.bind(debuggerApi);
    globalThis.__actionInputs = [];
    debuggerApi.sendCommand = (method, params) => {
      if (
        ["DOM.focus", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent"].includes(method) ||
        (method === "Runtime.callFunctionOn" &&
          params.functionDeclaration?.includes("function (expected, value)"))
      )
        globalThis.__actionInputs.push({ method, type: params?.type, key: params?.key });
      const pending = send(method, params);
      if (
        globalThis.__holdB1Ack &&
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration?.includes("function (expected, value)")
      ) {
        globalThis.__holdB1Ack = false;
        return pending.then(
          (value) =>
            new Promise((resolve) => {
              globalThis.__releaseB1Ack = () => resolve(value);
              globalThis.__heldB1Ack = true;
            }),
        );
      }
      if (
        globalThis.__holdB1Read &&
        method === "Runtime.callFunctionOn" &&
        params.functionDeclaration?.includes("return globalThis[key].read(this)")
      ) {
        globalThis.__waitB1Reads++;
        return pending.then((value) =>
          value.result?.value?.checked === true
            ? new Promise((resolve) => {
                globalThis.__releaseB1Read = () => resolve(value);
                globalThis.__heldB1Read = value.result.value;
              })
            : value,
        );
      }
      return pending;
    };
  }, nativeId);
  await app.evaluate(
    (_electron, { modulePath, capacityMode }) => {
      const { CorePreview } = process.getBuiltinModule("module").createRequire(modulePath)(
        modulePath,
      );
      const { NativePageTargets } = process.getBuiltinModule("module").createRequire(modulePath)(
        "./preview-native/native-targets.cjs",
      );
      const { ApprovedBatches } = process.getBuiltinModule("module").createRequire(modulePath)(
        "./preview-native/batches.cjs",
      );
      const execute = CorePreview.prototype.execute,
        target = NativePageTargets.prototype.actionTarget;
      const prepare = CorePreview.prototype.prepare;
      const executeBatch = ApprovedBatches.prototype.executeBatch;
      ApprovedBatches.prototype.executeBatch = async function (request) {
        const value = await executeBatch.call(this, request);
        const duplicate = await executeBatch.call(this, request);
        const altered = await executeBatch
          .call(this, { ...request, parameters: { ...request.parameters, steps: [] } })
          .then(
            () => true,
            () => false,
          );
        globalThis.__batchDedup = { value, duplicate, altered };
        return value;
      };
      CorePreview.prototype.prepare = async function (request) {
        const original = await prepare.call(this, request);
        if (!globalThis.__planBudgetOnce) return original;
        globalThis.__planBudgetOnce = false;
        const page = this.page(request.projectId, request.threadId, request.pageId);
        const facts = () => ({
          plans: page.plans.size,
          outstanding: this.workspace.workspaceOutstanding(request.projectId, request.threadId),
          activeRead: !!page.activeRead,
          activePrepare: !!page.activePrepare,
          activeAction: !!page.activeAction,
          pageGeneration: page.pageGeneration,
          documentEpoch: page.documentGeneration,
          controlEpoch: page.controlEpoch,
        });
        const first = facts(),
          samples = [first];
        const limit = capacityMode === "batch" ? 15 : 16;
        for (let index = 1; index < limit; index++) {
          const result = await prepare.call(this, {
            ...request,
            requestId: request.requestId + 100000 + index,
            callId: request.callId + "-main-budget-" + index,
          });
          samples.push({ ...facts(), preparedActionId: result.plan.preparedActionId });
        }
        const beforeExtra = facts(),
          started = Date.now();
        const extra = await prepare
          .call(this, {
            ...request,
            requestId: request.requestId + 200000,
            callId: request.callId + "-main-budget-extra",
            ...(capacityMode === "batch"
              ? {
                  operation: "runBatch",
                  parameters: {
                    pageId: request.pageId,
                    snapshotId: request.parameters.snapshotId,
                    steps: [
                      {
                        operation: "act",
                        snapshotId: request.parameters.snapshotId,
                        action: request.parameters.action,
                      },
                    ],
                    timeoutMs: 2000,
                  },
                }
              : {}),
          })
          .then(
            () => ({ accepted: true }),
            (error) => ({ accepted: false, error: error.message }),
          );
        globalThis.__planBudgetManager = this;
        globalThis.__planBudgetRequest = request;
        globalThis.__planBudgetFacts = {
          capacityMode,
          first,
          samples,
          beforeExtra,
          extra,
          afterExtra: facts(),
          elapsedMs: Date.now() - started,
          boundary:
            "Original Core plan unchanged; fifteen additional real Main prepares are admission probes and do not fabricate Core approval/history.",
        };
        return original;
      };
      CorePreview.prototype.execute = async function (request) {
        const moving = globalThis.__unstableActionOnce === true && request.operation === "act";
        if (!moving) return execute.call(this, request);
        globalThis.__unstableActionOnce = false;
        globalThis.__unstableActionActive = true;
        try {
          return await execute.call(this, request);
        } finally {
          globalThis.__unstableActionActive = false;
        }
      };
      NativePageTargets.prototype.actionTarget = async function (...args) {
        const result = await target.apply(this, args);
        if (globalThis.__unstableActionActive) {
          globalThis.__actionTargetReadPositions.push({
            x: result.x,
            y: result.y,
            backendNodeId: result.backendNodeId,
          });
          // 两次真实目标采样之间移动页面元素；保留原始读取结果。
          if (globalThis.__actionTargetReadPositions.length === 1)
            await args[1].executeJavaScript(
              `document.querySelector('#submit').style.transform='translateX(24px)'`,
            );
        }
        return result;
      };
    },
    { modulePath: join(gui, "app/src/core/preview.cjs"), capacityMode },
  );
  let completedTurns = 0;
  async function scenario(next, choice = null) {
    mode = next;
    if (completedTurns > 0) modelStage = 0;
    console.error(`browser-actions: ${next} starting`);
    let approvalPath;
    if (completedTurns > 0)
      await command("send", { projectId, threadId, text: `Check ${next} action` });
    const readApproval = page.locator('[data-interaction="approval"]');
    await readApproval.waitFor({ timeout: 60000 });
    assert.match(await readApproval.innerText(), /observe/);
    await readApproval.getByRole("button", { name: "允许一次", exact: true }).click();
    await until(
      async () =>
        !(await readApproval.count()) ||
        !(await readApproval.innerText()).includes("操作：observe"),
      "observation approved",
    );
    if (choice) {
      const panel = page.locator('[data-interaction="approval"]');
      await panel.waitFor({ timeout: 60000 });
      assert.match(
        await panel.innerText(),
        capacityMode === "b1" ? /scroll|hover|selectOption|setChecked|wait/ : /Submit action|Draft/,
      );
      if (capacityMode === "b1") {
        const mutation = {
          selectReplace: `{const o=document.querySelector('#choice option[value=b]');o.replaceWith(o.cloneNode(true))}`,
          selectReorder: `document.querySelector('#choice').prepend(document.querySelector('#choice option[value=b]'))`,
          selectType: `{const old=document.querySelector('#choice'),el=document.createElement('input');el.id='choice';old.replaceWith(el)}`,
          hoverReplace: `{const old=document.querySelector('#hover');old.replaceWith(old.cloneNode(true))}`,
          scrollStale: "scrollTo(0,40)",
          waitTransition: `setTimeout(()=>{document.querySelector('#check').checked=true},200)`,
        }[next];
        if (mutation)
          await app.evaluate(
            ({ webContents }, { id, mutation }) =>
              webContents.fromId(id).executeJavaScript(mutation),
            { id: nativeId, mutation },
          );
      }
      if (next === "stale")
        await app.evaluate(
          ({ webContents }, id) =>
            webContents
              .fromId(id)
              .executeJavaScript(
                `{const old=document.querySelector('#submit');old.replaceWith(old.cloneNode(true))}`,
              ),
          nativeId,
        );
      if (next === "hidden" || next === "covered")
        await app.evaluate(
          ({ webContents }, { id, next }) =>
            webContents.fromId(id).executeJavaScript(
              next === "hidden"
                ? `document.querySelector('#submit').style.display='none'`
                : `(()=>{const r=document.querySelector('#submit').getBoundingClientRect(), cover=document.createElement('div');
            cover.id='fixture-cover';cover.style.cssText='position:fixed;z-index:999999;background:#ccc';
            Object.assign(cover.style,{left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
            document.body.append(cover)})()`,
            ),
          { id: nativeId, next },
        );
      if (next === "unstable")
        await app.evaluate(() => {
          globalThis.__unstableActionOnce = true;
          globalThis.__actionTargetReadPositions = [];
        });
      if (
        [
          "allow",
          "select",
          "selectPrivacy",
          "selectPrivacyBatch",
          "checkTrue",
          "hover",
          "scroll",
        ].includes(next)
      ) {
        approvalPath = join(scratch, `${next}-approval.png`);
        await panel.screenshot({ path: approvalPath });
      }
      if (next === "waitTakeoverLate")
        await app.evaluate(() => {
          globalThis.__holdB1Read = true;
          globalThis.__waitB1Reads = 0;
        });
      await panel.getByRole("button", { name: choice }).click();
    }
    if (next === "selectPrivacyNotes") {
      const panel = page.locator('[data-interaction="approval"]');
      await until(
        async () => (await panel.count()) && /observe/.test(await panel.innerText()),
        "post-action observe approval",
      );
      await panel.getByRole("button", { name: "允许一次", exact: true }).click();
    }
    const turn = await terminalTurn(completedTurns);
    completedTurns++;
    const item = toolResult(turn);
    let nativePath;
    if (approvalPath && item.success) {
      nativePath = join(scratch, `${next}-native.png`);
      const png = await app.evaluate(
        async ({ webContents }, id) =>
          (await webContents.fromId(id).capturePage()).toPNG().toString("base64"),
        nativeId,
      );
      await writeFile(nativePath, Buffer.from(png, "base64"));
    }
    const plan = item.execution?.effectiveArguments?.plan;
    events[next] = {
      turnId: turn.id,
      status: turn.status,
      item,
      posts: siteFacts.posts,
      native: await nativeFacts(),
      ...(approvalPath
        ? {
            visualEvidence: {
              approvalPath,
              nativePath,
              callId: item.callId,
              pageId,
              ref: plan?.target?.ref ?? null,
              snapshotId: plan?.snapshotId,
              preparedActionId: plan?.preparedActionId,
            },
          }
        : {}),
    };
    console.error(`browser-actions: ${next} completed`);
    return item;
  }
  if (capacityMode === "b1" && publicB1) {
    for (const next of ["scroll", "hover", "select", "checkTrue"]) {
      const item = await scenario(next);
      assert.equal(item.success, false);
      assert.match(JSON.stringify(item.contentItems), /human_takeover_required/);
      assert.equal(siteFacts.posts, 0);
      assert.equal((await app.evaluate(() => globalThis.__actionInputs)).length, 0);
    }
    checks.push(
      "B1 synthetic public Origin refuses undeclared viewport scroll, hover, select and checkbox without native input",
    );
  } else if (capacityMode === "b1" && privacyMode) {
    for (const [index, next] of [
      "selectPrivacy",
      "selectPrivacyBatch",
      "selectPrivacyNotes",
    ].entries()) {
      if (index)
        await app.evaluate(
          ({ webContents }, { id, source }) =>
            webContents
              .fromId(id)
              .executeJavaScript(
                `document.querySelector('#choice').innerHTML='<option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Closed</option>';window.privateEchoSource=${JSON.stringify(source)}`,
              ),
          { id: nativeId, source: next === "selectPrivacyNotes" ? "#notes" : "#password" },
        );
      const expectedPrivateValue = next === "selectPrivacyNotes" ? notesValue : privateValue;
      await app.evaluate(() => {
        globalThis.__actionInputs = [];
      });
      const item = await scenario(next, "允许一次");
      assert.equal(item.success, true);
      await until(
        () => siteFacts.effects.privateEcho === index + 1,
        "private echo handler executed once",
      );
      assert.equal(siteFacts.effects.selectinput, index + 1);
      assert.equal(siteFacts.effects.selectchange, index + 1);
      const native = await app.evaluate(
        ({ webContents }, id) =>
          webContents
            .fromId(id)
            .executeJavaScript(
              `({value:document.querySelector('#choice').value,label:document.querySelector('#choice').selectedOptions[0].label,controlFacts})`,
            ),
        nativeId,
      );
      assert.equal(native.value, expectedPrivateValue);
      assert.equal(native.label, expectedPrivateValue);
      assert.equal(native.controlFacts.selectInput, index + 1);
      assert.equal(native.controlFacts.selectChange, index + 1);
      const inputs = await app.evaluate(() => globalThis.__actionInputs);
      assert.equal(inputs.filter((input) => input.method === "Runtime.callFunctionOn").length, 1);
      events[next].privateEcho = { native, inputs };
      const payload = item.contentItems
        .filter((item) => item.type === "inputText")
        .map((item) => JSON.parse(item.text))[0];
      const receipt = next === "selectPrivacyBatch" ? payload.receipts[0] : payload;
      events[next].receipt = receipt;
      assert.equal(receipt.dispatch, "confirmed");
      assert.equal(receipt.inputConfirmed, true);
      assert.equal(receipt.noOp ?? false, false);
      assert.equal(receipt.stateMatched, false);
      assert.equal(
        JSON.stringify(receipt).includes(expectedPrivateValue),
        false,
        "post-select receipt conceals private field echo",
      );
      assert.equal(
        JSON.stringify(item).includes(expectedPrivateValue),
        false,
        "Core tool history conceals private field echo",
      );
      assert.equal(
        JSON.stringify(events[`${next}ModelResult`]).includes(expectedPrivateValue),
        false,
        "model-visible Core result conceals private field echo",
      );
      if (next === "selectPrivacyNotes") {
        const observation = events[`${next}PostObservation`];
        assert.ok(observation, "post-action observe returns current facts");
        const select = observation.nodes.find(
          (node) => node.nativeControl?.kind === "select",
        )?.nativeControl;
        assert.equal(select.optionsComplete, false);
        assert.deepEqual(select.options, []);
        assert.equal(
          JSON.stringify(observation).includes(expectedPrivateValue),
          false,
          "observe conceals private Notes field echo",
        );
      }
      if (next === "selectPrivacyBatch") {
        const dedup = await app.evaluate(() => globalThis.__batchDedup);
        assert.deepEqual(dedup.value, dedup.duplicate);
        assert.equal(
          JSON.stringify(dedup.value).includes(expectedPrivateValue),
          false,
          "retained batch receipt conceals private field echo",
        );
        assert.equal(dedup.value.receipts[0].stateMatched, false);
        events[next].dedup = dedup;
      }
      checks.push(
        `${next} confirms one native select and input/change pair while action, Core and model conceal private field echo`,
      );
    }
  } else if (capacityMode === "b1") {
    const native = (code) =>
      app.evaluate(
        ({ webContents }, { id, code }) => webContents.fromId(id).executeJavaScript(code),
        { id: nativeId, code },
      );
    const reset = async () => {
      await native(`scrollTo(0,0);document.querySelector('#check').checked=false;document.querySelector('#choice')?.remove();document.querySelector('#choice-label')?.remove();
        document.querySelector('#multiple').closest('label').insertAdjacentHTML('beforebegin','<label id="choice-label">Native choice <select id="choice"><option value="a">Alpha</option><option value="b">Beta</option><option value="c" disabled>Closed</option></select></label>');
        for(const kind of ['input','change']) document.querySelector('#choice').addEventListener(kind,()=>{controlFacts[kind==='input'?'selectInput':'selectChange']++;effect('select'+kind)});`);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await app.evaluate(() => {
        globalThis.__actionInputs = [];
      });
    };
    await scenario("scrollDenied", "拒绝");
    assert.equal(siteFacts.posts, 0);
    for (const next of ["scrollBeforePrepare", "selectBeforePrepare"]) {
      await reset();
      const before = siteFacts.posts;
      const item = await scenario(next);
      assert.equal(item.success, false);
      assert.equal(siteFacts.posts, before);
      assert.equal((await app.evaluate(() => globalThis.__actionInputs)).length, 0);
    }
    for (const next of [
      "scrollStale",
      "hoverReplace",
      "selectReplace",
      "selectReorder",
      "selectType",
    ]) {
      await reset();
      const before = siteFacts.posts;
      const item = await scenario(next, "允许一次");
      assert.equal(item.success, false);
      assert.equal(siteFacts.posts, before);
      assert.equal((await app.evaluate(() => globalThis.__actionInputs)).length, 0);
    }
    await reset();
    const selected = await scenario("select", "允许一次");
    assert.equal(selected.success, true);
    await until(() => siteFacts.effects.selectchange === 1, "one exact select change");
    assert.equal((await nativeFacts()).choice, "b");
    assert.equal(siteFacts.effects.selectinput, 1);
    const control = events.selectObservation.nodes.find(
      (node) => node.nativeControl?.kind === "select",
    )?.nativeControl;
    assert.equal(control.multiple, false);
    assert.equal(control.optionsComplete, true);
    assert.deepEqual(
      control.options.map(({ value, label, disabled, selected }) => ({
        value,
        label,
        disabled,
        selected,
      })),
      [
        { value: "a", label: "Alpha", disabled: false, selected: true },
        { value: "b", label: "Beta", disabled: false, selected: false },
        { value: "c", label: "Closed", disabled: true, selected: false },
      ],
    );
    assert.equal(new Set(control.options.map((o) => o.optionId)).size, 3);
    for (const next of ["selectDisabled", "multiple", "checkDisabled", "checkRadio"]) {
      const before = siteFacts.posts;
      const item = await scenario(next);
      assert.equal(item.success, false);
      assert.equal(siteFacts.posts, before);
    }
    await reset();
    await native(
      `document.querySelector('#choice').insertAdjacentHTML('beforeend','<option value="b">Duplicate</option>')`,
    );
    const duplicate = await scenario("selectDuplicate");
    assert.equal(duplicate.success, false);
    await reset();
    await scenario("checkTrue", "允许一次");
    await until(() => siteFacts.effects.checkClick === 1, "one checkbox toggle");
    assert.equal((await nativeFacts()).checked, true);
    const again = await scenario("checkAgain", "允许一次");
    assert.equal(again.success, true);
    const noOpReceipt = JSON.parse(
      again.contentItems.find((item) => item.type === "inputText").text,
    );
    assert.equal(noOpReceipt.noOp, true);
    assert.equal(noOpReceipt.inputConfirmed, false);
    assert.equal(noOpReceipt.dispatch, "confirmed");
    assert.equal(siteFacts.effects.checkClick, 1);
    assert.equal(siteFacts.effects.checkinput, 1);
    assert.equal(siteFacts.effects.checkchange, 1);
    await scenario("checkFalse", "允许一次");
    await until(() => siteFacts.effects.checkClick === 2, "checkbox false");
    assert.equal((await nativeFacts()).checked, false);
    assert.equal(siteFacts.effects.checkinput, 2);
    assert.equal(siteFacts.effects.checkchange, 2);
    for (const next of [
      "waitEnabledFalse",
      "waitEnabledTrue",
      "waitCheckedTrue",
      "waitCheckedFalse",
      "waitTransition",
      "waitTimeout",
    ]) {
      await native(
        `document.querySelector('#check').checked=false;document.querySelector('#check').disabled=${next === "waitTransition"}`,
      );
      await app.evaluate(() => {
        globalThis.__actionInputs = [];
      });
      const item = await scenario(next, "允许一次");
      assert.equal(item.success, next !== "waitTimeout");
      assert.equal((await app.evaluate(() => globalThis.__actionInputs)).length, 0);
    }
    await native(
      `document.querySelector('#check').checked=false;document.querySelector('#check').disabled=true`,
    );
    const beforeWaitTakeover = { ...siteFacts.effects },
      lateWait = scenario("waitTakeoverLate", "允许一次");
    await until(
      () => app.evaluate(() => globalThis.__waitB1Reads >= 2),
      "disabled checkbox is polled through native reads",
    );
    await native(`document.querySelector('#check').checked=true`);
    await until(
      () => app.evaluate(() => globalThis.__heldB1Read?.checked === true),
      "matching native state reply withheld",
    );
    await page.evaluate(
      ({ projectId, threadId, pageId }) =>
        window.arealDesktop.preview({ operation: "takeover", projectId, threadId, pageId }),
      { projectId, threadId, pageId },
    );
    const stoppedWait = await lateWait;
    assert.equal(stoppedWait.success, false);
    assert.equal(stoppedWait.execution.outcome, "unknown");
    const fencedReads = await app.evaluate(() => globalThis.__waitB1Reads);
    await app.evaluate(() => {
      globalThis.__holdB1Read = false;
      globalThis.__releaseB1Read();
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(await app.evaluate(() => globalThis.__waitB1Reads), fencedReads);
    assert.equal((await app.evaluate(() => globalThis.__actionInputs)).length, 0);
    assert.deepEqual(siteFacts.effects, beforeWaitTakeover);
    const historicalWait = (await currentThread()).turns
      .flatMap((turn) => turn.items)
      .find((item) => item.id === stoppedWait.id);
    assert.equal(historicalWait.success, false);
    assert.equal(historicalWait.execution.outcome, "unknown");
    events.waitTakeoverLate.fencedReads = fencedReads;
    events.waitTakeoverLate.lateReplySuppressed = true;
    const inspection =
      "Inspected native checkbox state, read counts and site counters. Takeover stopped polling with zero input or site effects. The matching late reply was suppressed and historical UNKNOWN remains unchanged.";
    await command("manage", {
      projectId,
      threadId,
      operation: "toolAcknowledge",
      itemId: stoppedWait.id,
      inspection,
    });
    assert.equal(
      (await currentThread()).turns
        .flatMap((turn) => turn.items)
        .find((item) => item.id === stoppedWait.id).execution.outcome,
      "unknown",
    );
    events.waitTakeoverLate.inspection = inspection;
    await until(
      async () =>
        (
          await page.evaluate(
            ({ projectId, threadId }) =>
              window.arealDesktop.preview({ operation: "state", projectId, threadId }),
            { projectId, threadId },
          )
        ).browser.control === "human",
      "read takeover converges to human",
    );
    await page.evaluate(
      ({ projectId, threadId, pageId }) =>
        window.arealDesktop.preview({ operation: "claim", projectId, threadId, pageId }),
      { projectId, threadId, pageId },
    );
    await native(`document.querySelector('#check').disabled=false`);
    await reset();
    await scenario("hover", "允许一次");
    await until(() => siteFacts.effects.hover === 1, "hover menu");
    assert.equal((await nativeFacts()).menu, false);
    await reset();
    await scenario("scroll", "允许一次");
    await until(() => siteFacts.effects.scroll === 1, "scroll sentinel");
    assert.ok((await nativeFacts()).scrollY > 100);
    const scrollState = await native(
      `({visible:document.querySelector('#sentinel').getBoundingClientRect().top<innerHeight,loaded:document.querySelector('#loaded')?.textContent})`,
    );
    assert.deepEqual(scrollState, { visible: true, loaded: "Loaded next segment" });
    await scenario("waitAfterScroll", "允许一次");
    assert.ok(
      events.waitAfterScrollObservation.nodes.some((node) => node.name === "Loaded next segment"),
    );
    await reset();
    const prefix = await scenario("batchPrefix", "允许一次");
    assert.equal(prefix.success, false);
    assert.equal(prefix.execution.outcome, "failed");
    const batch = prefix.contentItems
      .filter((item) => item.type === "inputText")
      .map((item) => {
        try {
          return JSON.parse(item.text);
        } catch {
          return null;
        }
      })
      .find((value) => Array.isArray(value?.receipts));
    assert.equal(batch.code, "plan_stale");
    assert.equal(batch.dispatch, "not_sent");
    assert.equal(batch.receipts.length, 2);
    assert.equal(batch.failedStep, 2);
    assert.equal(batch.remaining, "not_sent");
    assert.equal(batch.receipts[0].inputConfirmed, true);
    assert.equal(batch.receipts[1].inputConfirmed, true);
    const dedup = await app.evaluate(() => globalThis.__batchDedup);
    assert.deepEqual(dedup.value, dedup.duplicate);
    assert.deepEqual(dedup.value.receipts, batch.receipts);
    assert.equal(dedup.altered, false);
    await reset();
    await app.evaluate(() => {
      globalThis.__holdB1Ack = true;
    });
    const beforeUnknown = { ...siteFacts.effects },
      unknownPromise = scenario("batchUnknown", "允许一次");
    await until(
      () => app.evaluate(() => globalThis.__heldB1Ack === true),
      "native SELECT sent with ACK withheld",
    );
    await until(
      () => (siteFacts.effects.selectchange ?? 0) === (beforeUnknown.selectchange ?? 0) + 1,
      "unknown select effect once",
    );
    await page.evaluate(
      ({ projectId, threadId, pageId }) =>
        window.arealDesktop.preview({ operation: "takeover", projectId, threadId, pageId }),
      { projectId, threadId, pageId },
    );
    const unknown = await unknownPromise;
    assert.equal(unknown.success, false);
    assert.match(JSON.stringify(unknown), /unknown/i);
    assert.equal((await nativeFacts()).choice, "b");
    assert.equal(siteFacts.effects.selectchange, (beforeUnknown.selectchange ?? 0) + 1);
    const unknownDedup = await app.evaluate(() => globalThis.__batchDedup);
    assert.equal(unknownDedup.value.receipts.length, 1);
    assert.equal(unknownDedup.value.failedStep, 1);
    assert.equal(unknownDedup.value.remaining, "not_sent");
    assert.deepEqual(unknownDedup.value, unknownDedup.duplicate);
    await app.evaluate(() => {
      globalThis.__releaseB1Ack();
    });
    await until(
      async () =>
        (
          await page.evaluate(
            ({ projectId, threadId }) =>
              window.arealDesktop.preview({ operation: "state", projectId, threadId }),
            { projectId, threadId },
          )
        ).browser.control === "human",
      "B1 pending ACK release converges to human",
    );
    checks.push(
      "B1 public Core calls bind native controls, ordered option identities, disabled state waits, stale targets and batch confirmed prefix to page and server counters",
    );
  } else {
    const denied = await scenario("deny", "拒绝");
    assert.equal(siteFacts.posts, 0);
    assert.equal(denied.success, false);
    checks.push("B-10: denied real Core approval sends zero native site effects");
    const allowed = await scenario("allow", "允许一次");
    assert.equal(allowed.success, true);
    await until(() => siteFacts.posts === 1, "one native click site effect");
    assert.equal((await nativeFacts()).submitPresent, true);
    checks.push("B-10: approved Core plan executes one actual native click");
    const stale = await scenario("stale", "允许一次");
    assert.equal(stale.success, false);
    assert.match(JSON.stringify(stale.contentItems), /plan_stale|stale_ref|not_sent/);
    assert.equal(siteFacts.posts, 1);
    checks.push(
      "B-11: replaced same-label target after plan preparation sends zero additional effects",
    );
    const disabled = await scenario("disabled");
    assert.equal(disabled.success, false);
    assert.match(JSON.stringify(disabled.contentItems), /not_sent|target_unavailable/);
    assert.equal(siteFacts.posts, 1);
    checks.push("B-13: disabled target fails before dispatch");
    const forged = await scenario("forged");
    assert.equal(forged.success, false);
    assert.equal(siteFacts.posts, 1);
    checks.push("B-12: model-supplied approval field cannot authorize action");
    for (const next of ["hidden", "covered", "unstable"]) {
      await app.evaluate(() => {
        globalThis.__actionInputs = [];
      });
      const refused = await scenario(next, "允许一次");
      assert.equal(refused.success, false);
      assert.match(JSON.stringify(refused.contentItems), /not_sent|target_unavailable|plan_stale/);
      assert.equal(siteFacts.posts, 1);
      const inputs = await app.evaluate(() => globalThis.__actionInputs);
      assert.equal(inputs.length, 0, `${next} fails before input dispatch`);
      if (next === "unstable") {
        const samples = await app.evaluate(() => globalThis.__actionTargetReadPositions);
        assert.equal(samples.length, 2);
        assert.equal(samples[0].backendNodeId, samples[1].backendNodeId);
        assert.equal(samples[1].x - samples[0].x, 24);
        events[next].samples = samples;
      }
      events[next].inputTrace = inputs;
      await app.evaluate(
        ({ webContents }, id) =>
          webContents
            .fromId(id)
            .executeJavaScript(
              `document.querySelector('#submit').style.cssText='';document.querySelector('#fixture-cover')?.remove()`,
            ),
        nativeId,
      );
      checks.push(
        `B-13: approved ${next} target is refused by actual Native actionability checks with zero input or additional POST`,
      );
    }
    const filled = await scenario("fill", "允许一次");
    assert.equal(filled.success, true);
    assert.equal((await nativeFacts()).draft, "DRAFT_INPUT_04");
    assert.equal(siteFacts.posts, 1);
    const pressed = await scenario("press", "允许一次");
    assert.equal(pressed.success, true);
    await until(() => siteFacts.posts === 2, "Enter submits the synthetic form once", 3000);
    checks.push(
      "B-13: approved fill and key input change native form state and produce one independent submit",
    );
    for (const [next, key, expectedPosts] of [
      ["pressButton", "Enter", 3],
      ["pressTab", "Tab", 3],
    ]) {
      const before = await nativeFacts();
      await app.evaluate(() => {
        globalThis.__actionInputs = [];
      });
      const result = await scenario(next, "允许一次");
      assert.equal(result.success, true);
      if (next === "pressButton")
        await until(() => siteFacts.posts === expectedPosts, "button Enter submits once", 3000);
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(siteFacts.posts, expectedPosts, `${key} introduces no implicit button click`);
      const after = await nativeFacts();
      const trace = await app.evaluate(() => globalThis.__actionInputs);
      assert.equal(trace.filter((item) => item.method === "DOM.focus").length, 1);
      assert.equal(trace.filter((item) => item.method === "Input.dispatchMouseEvent").length, 0);
      assert.deepEqual(
        trace
          .filter((item) => item.method === "Input.dispatchKeyEvent")
          .map((item) => [item.type, item.key]),
        [
          ["keyDown", key],
          ["keyUp", key],
        ],
      );
      assert.deepEqual(after.keyFacts.downs.slice(before.keyFacts.downs.length), [
        { key, target: "submit" },
      ]);
      if (next === "pressTab") assert.equal(after.activeElement, "draft");
      events[next].inputTrace = trace;
      checks.push(
        `B-13: Ref ${key} focuses the actual button and dispatches only the approved key; site effects=${expectedPosts}`,
      );
    }
    await page.evaluate(
      ({ projectId, threadId, pageId }) =>
        window.arealDesktop.preview({ operation: "takeover", projectId, threadId, pageId }),
      { projectId, threadId, pageId },
    );
    await until(
      async () =>
        (
          await page.evaluate(
            ({ projectId, threadId }) =>
              window.arealDesktop.preview({ operation: "state", projectId, threadId }),
            { projectId, threadId },
          )
        ).browser.control === "human",
      "plan-budget Human convergence",
    );
    await page.evaluate(
      ({ projectId, threadId, pageId }) =>
        window.arealDesktop.preview({ operation: "claim", projectId, threadId, pageId }),
      { projectId, threadId, pageId },
    );
    await app.evaluate(() => {
      globalThis.__planBudgetOnce = true;
      globalThis.__actionInputs = [];
    });
    const capacity = await scenario("capacity", "拒绝");
    assert.equal(capacity.success, false);
    const budget = await app.evaluate(() => globalThis.__planBudgetFacts);
    events.capacity.budget = budget;
    assert.equal(budget.first.plans, 1);
    const limit = capacityMode === "batch" ? 15 : 16;
    assert.deepEqual(
      budget.samples.map((row) => row.plans),
      Array.from({ length: limit }, (_, index) => index + 1),
    );
    assert.equal(budget.beforeExtra.outstanding, limit);
    assert.equal(
      budget.beforeExtra.activeRead ||
        budget.beforeExtra.activePrepare ||
        budget.beforeExtra.activeAction,
      false,
    );
    assert.equal(budget.extra.accepted, false);
    assert.match(budget.extra.error, /not_sent/);
    assert.equal(budget.afterExtra.plans, limit);
    assert.equal(budget.afterExtra.outstanding, limit);
    for (const field of ["pageGeneration", "documentEpoch", "controlEpoch"])
      assert.equal(budget.first[field], budget.afterExtra[field]);
    assert.ok(budget.elapsedMs < 1000);
    assert.equal(siteFacts.posts, 3);
    assert.equal((await app.evaluate(() => globalThis.__actionInputs)).length, 0);
    await page.evaluate(
      ({ projectId, threadId, pageId }) =>
        window.arealDesktop.preview({ operation: "takeover", projectId, threadId, pageId }),
      { projectId, threadId, pageId },
    );
    await until(
      async () =>
        (
          await page.evaluate(
            ({ projectId, threadId }) =>
              window.arealDesktop.preview({ operation: "state", projectId, threadId }),
            { projectId, threadId },
          )
        ).browser.control === "human",
      "budget plans cleared by takeover",
    );
    const cleared = await app.evaluate(() => {
      const request = globalThis.__planBudgetRequest,
        manager = globalThis.__planBudgetManager;
      return {
        plans: manager.page(request.projectId, request.threadId, request.pageId).plans.size,
        outstanding: manager.workspace.workspaceOutstanding(request.projectId, request.threadId),
      };
    });
    assert.equal(cleared.plans, 0);
    assert.equal(cleared.outstanding, 0);
    events.capacity.budget = budget;
    events.capacity.cleared = cleared;
    checks.push(
      `09c5 Main ${capacityMode}: actual prepared plans exhaust the workspace budget including the outer batch plan; extra original Main prepare is promptly refused without input, epoch drift or Core history fabrication; takeover clears all plans`,
    );
  }
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page) await captureSmokeFailure(page, scratch, error);
  throw error;
} finally {
  const cleanup = {},
    metadata = await readFile(join(scratch, "core/service.json"), "utf8").then(
      JSON.parse,
      (error) => {
        if (error.code !== "ENOENT") errors.push("cleanup identity: " + error.message);
        return null;
      },
    );
  if (app) {
    let timer;
    try {
      await Promise.race([
        app.close(),
        new Promise((_resolve, reject) => {
          timer = setTimeout(() => reject(Error("owned Electron quit timed out")), 15000);
        }),
      ]);
      if (appProcess.exitCode === null && appProcess.signalCode === null)
        await new Promise((resolve, reject) => {
          const deadline = setTimeout(() => reject(Error("owned Electron did not exit")), 15000);
          appProcess.once("exit", () => {
            clearTimeout(deadline);
            resolve();
          });
        });
      assert.equal(appProcess.exitCode, 0);
      assert.equal(appProcess.signalCode, null);
      cleanup.electronExited = true;
    } catch (error) {
      errors.push("natural GUI quit: " + error.message);
    } finally {
      clearTimeout(timer);
    }
  }
  if (metadata) {
    try {
      await assertApplicationStopped(env.AREAL_CORE_BIN, env, metadata);
      cleanup.applicationStopped = true;
    } catch (error) {
      errors.push("application cleanup: " + error.message);
    }
  }
  if (errors.length && metadata && !cleanup.applicationStopped) {
    const {
        ServiceConnection,
        waitForServiceProcessExit,
      } = require("../app/src/core/service-client.cjs"),
      connection = new ServiceConnection();
    cleanup.assistedServiceStop = true;
    try {
      await connection.connect(metadata);
      const packet = await connection.request("hello", {
        protocol: metadata.protocol,
        identity: metadata.identity,
      });
      await connection
        .request(
          "stopService",
          {
            protocol: metadata.protocol,
            cancel: true,
            expectedDesktopGeneration: metadata.desktopGeneration,
            expectedTargets: packet.service.targets,
          },
          true,
        )
        .catch((error) => {
          if (!error.message.includes("已请求退出")) throw error;
        });
      await waitForServiceProcessExit(join(scratch, "core"), metadata);
    } catch (error) {
      if (!["ENOENT", "ECONNREFUSED", "ESRCH"].includes(error.code))
        errors.push("assisted stop: " + error.message);
    } finally {
      connection.close();
    }
  }
  if (appProcess && appProcess.exitCode === null && appProcess.signalCode === null) {
    errors.push("forced Electron cleanup");
    appProcess.kill("SIGKILL");
    await new Promise((resolve) => appProcess.once("exit", resolve));
    cleanup.forcedElectronExit = true;
  }
  const mainErrors = (await readFile(mainErrorsPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  for (const error of mainErrors)
    errors.push("uncaught Main " + error.origin + ": " + error.message);
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  events.cleanup = {
    ...cleanup,
    metadata: metadata && {
      protocol: metadata.protocol,
      identity: metadata.identity,
      desktopGeneration: metadata.desktopGeneration,
      pid: metadata.pid,
      applicationOwner: metadata.applicationOwner,
      endpoint: metadata.endpoint,
    },
    mainErrors,
  };
  site.closeAllConnections();
  model.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => site.close(resolve)),
    new Promise((resolve) => model.close(resolve)),
  ]);
  const files = [
    "app/src/core/browser-tool.cjs",
    "app/src/core/preview.cjs",
    "app/src/core/service-protocol.cjs",
    "renderer/src/ApprovalRequest.tsx",
    "scripts/browser-actions-smoke.mjs",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(gui, file)))
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(
    join(scratch, "run-manifest.json"),
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        events,
        modelCalls,
        startedAt,
        endedAt: new Date().toISOString(),
        sourceHead: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        diffSHA256: createHash("sha256")
          .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
          .digest("hex"),
        hashes,
        coreBinary: env.AREAL_CORE_BIN,
        coreBinarySHA256: createHash("sha256")
          .update(await readFile(env.AREAL_CORE_BIN))
          .digest("hex"),
        runtime: events.runtime,
        entrypoint: "node clients/gui/scripts/browser-actions-smoke.mjs",
        scope:
          "source Electron + independent adapter + Core/Runtime + deterministic loopback model + synthetic site; OS chooser stubbed",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed, evidence: scratch, checks, errors }));
}
