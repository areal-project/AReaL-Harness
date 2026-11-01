import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { respondToSessionName } from "./model-fixture.mjs";
import { readFile, readdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  BUDGET,
  createTaskFixture,
  gradeTask,
  SINGLE_TASK_CATALOG,
  GENERATED_TASK,
  PAIRED_TASK_CATALOG,
  NORMAL_CONTROLS_INSTRUCTION,
  taskApprovalDecision,
  trustedDocumentOrigins,
  trustedDocumentUrls,
  browserDescription,
  coldStartPageIds,
} from "./browser-task-benchmark-catalog.mjs";

import {
  EXTERNAL_TASK_IDS,
  externalNativeSnapshotScript,
  externalFixtureSteps,
} from "./browser-task-external-sources.mjs";

const atomicJSON = async (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2));
  await rename(temporary, path);
};

function browserObservation(value, pageId) {
  if (typeof value === "string") {
    try {
      return browserObservation(JSON.parse(value), pageId);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  if (
    value.pageId === pageId &&
    typeof value.observationId === "string" &&
    Array.isArray(value.nodes)
  )
    return value;
  return (
    Object.values(value)
      .map((item) => browserObservation(item, pageId))
      .find(Boolean) ?? null
  );
}

export const taskCreateRequest = (projectId, taskId) => ({
  projectId,
  browserEnabled: true,
  options: {
    permissionPreset: "ask",
    maxModelRounds: BUDGET.maxModelRounds,
    toolAllowlist: taskId === GENERATED_TASK.id ? ["fs_create", "browser_v1"] : ["browser_v1"],
    ...(taskId === GENERATED_TASK.id ? { approvalTools: ["fs_create"] } : {}),
  },
  profile: { id: "fixture", revision: "v1" },
});

export async function readNativeTaskSnapshots(app, taskURL, script, expectedNativePageId = null) {
  return app.evaluate(
    async ({ webContents }, { taskURL, script, expectedNativePageId }) => {
      const snapshots = [],
        diagnostics = [];
      for (const contents of webContents.getAllWebContents()) {
        let nativePageId = null;
        let matchedTaskURL = false;
        try {
          nativePageId = contents.id;
          if (contents.isDestroyed()) throw Error("WebContents was destroyed before native read");
          if (contents.getURL().split("#")[0] !== taskURL) continue;
          matchedTaskURL = true;
          const frame = contents.mainFrame;
          const sampled = await contents.executeJavaScript(
            `(() => ({snapshot: (${script}), timeOrigin: performance.timeOrigin}))()`,
          );
          const current = contents.mainFrame;
          const documentId =
            Number.isFinite(sampled.timeOrigin) &&
            contents.getURL().split("#")[0] === taskURL &&
            current.processId === frame.processId &&
            current.routingId === frame.routingId
              ? `${frame.processId}:${frame.routingId}:${sampled.timeOrigin}`
              : null;
          snapshots.push({ ...sampled.snapshot, nativePageId, documentId });
        } catch (error) {
          diagnostics.push({
            nativePageId,
            matchedTaskURL,
            expectedNativePageId,
            error: error.message,
          });
          if (matchedTaskURL || (nativePageId !== null && nativePageId === expectedNativePageId))
            snapshots.push({ unavailable: error.message, nativePageId, documentId: null });
        }
      }
      return snapshots.map((snapshot) => ({ ...snapshot, nativeReadDiagnostics: diagnostics }));
    },
    { taskURL, script, expectedNativePageId },
  );
}

export async function takeOverTodoVerification(page, { projectId, threadId, taskURL }) {
  const preview = (request) =>
    page.evaluate((request) => window.arealDesktop.preview(request), request);
  const scope = { projectId, threadId };
  const state = await preview({ ...scope, operation: "state" });
  const matches = (state.workspace?.pages ?? []).filter(
    (item) => item.url?.split("#")[0] === taskURL,
  );
  assert.equal(matches.length, 1, "Verification requires one owned TodoMVC task page");
  const pageId = matches[0].pageId;
  const before = await preview({ ...scope, pageId, operation: "state" });
  assert.equal(before.browser?.pageId, pageId);
  assert.equal(before.url?.split("#")[0], taskURL);
  const takeover = await preview({ ...scope, pageId, operation: "takeover" });
  const deadline = performance.now() + 3000;
  let after;
  do {
    after = await preview({ ...scope, pageId, operation: "state" });
    assert.equal(
      after.browser?.pageId,
      pageId,
      "Verification page ownership changed during takeover",
    );
    assert.equal(
      after.url?.split("#")[0],
      taskURL,
      "Verification task URL changed during takeover",
    );
    if (after.browser?.control === "human") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (performance.now() < deadline);
  assert.equal(after.browser?.control, "human", "Verification requires completed human takeover");
  return {
    source: "post-terminal-public-human-takeover",
    ...scope,
    pageId,
    before,
    takeover,
    after,
  };
}

export async function clickTodoVerificationFilter(app, taskURL, snapshot, filter) {
  assert.ok(["All", "Active"].includes(filter));
  return app.evaluate(
    async ({ app, webContents }, { taskURL, snapshot, filter }) => {
      const contents = webContents.fromId(snapshot.nativePageId);
      if (!contents || contents.isDestroyed() || contents.getURL().split("#")[0] !== taskURL)
        throw Error("Verification no longer owns the exact TodoMVC native page");
      const identity = async () => {
        const frame = contents.mainFrame;
        const timeOrigin = await contents.executeJavaScript("performance.timeOrigin");
        return `${frame.processId}:${frame.routingId}:${timeOrigin}`;
      };
      if ((await identity()) !== snapshot.documentId)
        throw Error("TodoMVC document changed before verification");
      const { createRequire } = process.getBuiltinModule("node:module");
      const localRequire = createRequire(`${app.getAppPath()}/package.json`);
      const { executeBrowserCommandOnView, validateBrowserCommand } = localRequire(
        "@areal/browser-automation",
      );
      const command = validateBrowserCommand({
        method: "playwright",
        action: {
          name: "locator",
          selector: `.filters a[href="${filter === "All" ? "#/" : "#/active"}"]`,
          operation: "click",
        },
      });
      const attached = contents.debugger.isAttached();
      if (!attached) contents.debugger.attach("1.3");
      try {
        const result = await executeBrowserCommandOnView(
          {
            webContents: contents,
            cdp: {
              send: (method, params, sessionId) => {
                if (contents.getURL().split("#")[0] !== taskURL)
                  throw Error("TodoMVC verification origin changed");
                return contents.debugger.sendCommand(method, params ?? {}, sessionId);
              },
            },
          },
          command,
        );
        if (!result.ok) throw Error(result.error?.message ?? "TodoMVC filter verification failed");
        if ((await identity()) !== snapshot.documentId)
          throw Error("TodoMVC document changed during verification");
        return { ...result, adapterPath: localRequire.resolve("@areal/browser-automation") };
      } finally {
        if (!attached && contents.debugger.isAttached()) contents.debugger.detach();
      }
    },
    { taskURL, snapshot, filter },
  );
}

export async function captureGeneratedNativePage(app, urls, path) {
  try {
    const captured = await app.evaluate(async ({ webContents }, urls) => {
      const matches = [];
      for (const contents of webContents.getAllWebContents()) {
        try {
          if (!contents.isDestroyed() && urls.includes(contents.getURL())) matches.push(contents);
        } catch {}
      }
      if (matches.length !== 1)
        throw Error(
          "Native capture requires exactly one live page matching the scoped document receipt",
        );
      const target = matches[0],
        nativePageId = target.id,
        url = target.getURL();
      const image = await target.capturePage();
      if (target.isDestroyed() || target.getURL() !== url || image.isEmpty())
        throw Error("Native document changed or returned an empty image during capture");
      return { nativePageId, url, ...image.getSize(), pngBase64: image.toPNG().toString("base64") };
    }, urls);
    const { pngBase64, ...identity } = captured;
    const bytes = Buffer.from(pngBase64, "base64");
    await writeFile(path, bytes);
    return {
      status: "captured",
      visualReview: "not_run",
      path,
      ...identity,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    return { status: "failed", visualReview: "not_run", error: error.message };
  }
}

export async function prepareTaskBenchmark(path, workspace) {
  const configuration = JSON.parse(await readFile(path, "utf8"));
  assert.ok(["fixture", "real"].includes(configuration.mode));
  assert.ok(
    configuration.fixtureRefLinkClicks === undefined ||
      typeof configuration.fixtureRefLinkClicks === "boolean",
    "fixtureRefLinkClicks must be a boolean",
  );
  assert.ok(
    !configuration.fixtureRefLinkClicks || configuration.mode === "fixture",
    "Ref link scripting is fixture-only",
  );
  assert.ok(
    SINGLE_TASK_CATALOG.some((task) => task.id === configuration.taskId) ||
      PAIRED_TASK_CATALOG.some((task) => task.id === configuration.taskId),
  );
  assert.ok(
    configuration.mode !== "real" ||
      (configuration.protocol === "responses" && configuration.model === "gpt-6.1-terra"),
  );
  const fixture = await createTaskFixture(configuration.taskId, workspace, {
    seed: configuration.instanceSeed,
  });
  if (configuration.normalControlsOnly) fixture.prompt += ` ${NORMAL_CONTROLS_INSTRUCTION}`;
  let pageId;
  let stage = 0;
  let partial;
  let nativeApp;
  let initialSnapshot;
  let nativeSnapshot;
  let observedRestart = false;
  const external = EXTERNAL_TASK_IDS.includes(fixture.id);
  const readNativeSnapshot = async () => {
    if (!external || !nativeApp) return;
    const snapshots = await readNativeTaskSnapshots(
      nativeApp,
      fixture.url,
      externalNativeSnapshotScript(fixture.id),
      initialSnapshot?.nativePageId ?? null,
    );
    nativeSnapshot = snapshots.length === 1 ? snapshots[0] : null;
    if (
      initialSnapshot &&
      nativeSnapshot &&
      (nativeSnapshot.nativePageId !== initialSnapshot.nativePageId ||
        nativeSnapshot.documentId !== initialSnapshot.documentId)
    )
      observedRestart = true;
    if (nativeSnapshot) nativeSnapshot.runnerEvidence = { observedRestart };
    if (
      !initialSnapshot &&
      Number.isInteger(nativeSnapshot?.nativePageId) &&
      typeof nativeSnapshot?.documentId === "string" &&
      nativeSnapshot.documentId.length > 0 &&
      nativeSnapshot.episodeActive &&
      nativeSnapshot.episodeId === 0 &&
      nativeSnapshot.query
    )
      initialSnapshot = structuredClone(nativeSnapshot);
    if (partial) Object.assign(partial, { initialSnapshot, nativeSnapshot });
  };
  const fixtureErrors = [];
  const locator = (selector, operation, rest = {}) => ({
    operation: "command",
    parameters: {
      pageId,
      command: { method: "playwright", action: { name: "locator", selector, operation, ...rest } },
    },
  });
  const navigate = (path) => ({
    operation: "navigate",
    parameters: { pageId, url: `${fixture.origin}${path}` },
  });
  const snapshot = () => ({
    operation: "command",
    parameters: { pageId, command: { method: "playwright", action: { name: "domSnapshot" } } },
  });
  const refLinkName = configuration.fixtureRefLinkClicks
    ? { "todomvc/active": "Active", information: `Details for ${fixture.expected.name}` }[
        fixture.id
      ]
    : null;
  const refLinkSelector =
    fixture.id === "todomvc/active"
      ? '.filters a[href="#/active"]'
      : `internal:role=link[name=${JSON.stringify(refLinkName)}s]`;
  const fixtureSteps = () => {
    const steps = external
      ? externalFixtureSteps(fixture.id, { pageId, origin: fixture.origin, initialSnapshot })
      : {
          "generated-local-html": [
            { operation: "openDocument", parameters: { pageId, path: fixture.localPath } },
            snapshot(),
          ],
          "local-html": [
            { operation: "openDocument", parameters: { pageId, path: fixture.localPath } },
            snapshot(),
          ],
          "form-submit": [
            navigate("/form"),
            locator('input[name="name"]', "fill", { value: "Morgan Lee" }),
            locator('input[name="updates"]', "setChecked", { checked: true }),
            locator("button", "click"),
            snapshot(),
          ],
          "dynamic-dom": [
            navigate("/dynamic"),
            locator("#expand", "click"),
            snapshot(),
            locator("article:nth-child(2) button", "click"),
            snapshot(),
          ],
          "iframe-info": [navigate("/iframe"), snapshot()],
          information: [
            navigate("/information"),
            snapshot(),
            locator(
              `internal:role=link[name=${JSON.stringify(`Details for ${fixture.expected.name}`)}s]`,
              "click",
            ),
            snapshot(),
          ],
          stop: [
            navigate("/stop"),
            ...Array.from({ length: 40 }, (_, n) =>
              locator(`button:nth-of-type(${n + 1})`, "click"),
            ),
          ],
        }[fixture.id];
    if (!refLinkName) return steps;
    return steps.flatMap((step) =>
      step.operation === "command" &&
      step.parameters.command.action?.name === "locator" &&
      step.parameters.command.action.selector === refLinkSelector &&
      step.parameters.command.action.operation === "click"
        ? [
            { operation: "observe", parameters: { pageId } },
            { fixtureRefClick: refLinkName },
            { operation: "observe", parameters: { pageId } },
          ]
        : [step],
    );
  };
  return {
    fixture,
    configuration,
    recordFixtureError(error) {
      const failure = {
        code: error.code ?? "FIXTURE_MODEL_ERROR",
        message:
          error instanceof SyntaxError ? "Invalid fixture model JSON request" : error.message,
        stack: error instanceof SyntaxError ? undefined : error.stack,
      };
      fixtureErrors.push(failure);
      return failure;
    },
    configText(endpoint) {
      const protocol = configuration.mode === "fixture" ? "chat-completions" : "responses";
      return `schema_version=1\n[limits]\ncontext_window_tokens=1000000\ncontext_mode="manual"\nmax_tool_calls=${BUDGET.maxToolCalls}\n[network]\nretry_mode="bounded"\n[model]\nprovider="pilot"\nname=${JSON.stringify(configuration.mode === "fixture" ? "fixture" : configuration.model)}\nreasoning_effort="medium"\nservice_tier="default"\nmax_output_tokens=${BUDGET.maxOutputTokensPerRequest}\nmax_retries=0\n[model.providers.pilot]\nprotocol=${JSON.stringify(protocol)}\nendpoint=${JSON.stringify(configuration.mode === "fixture" ? endpoint : configuration.modelEndpoint)}\n`;
    },
    async fixtureModel(request, response) {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (respondToSessionName(body, response)) return;
      if (
        body.messages?.some(
          (message) =>
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.startsWith("Predict the next user prompt"),
        )
      ) {
        assert.ok(!body.tools?.length, "prompt prediction must not receive tools");
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        );
        return;
      }
      const last = body.messages?.findLast(
        (message) => message.role === "tool" && message.tool_call_id === `pipeline-${stage - 1}`,
      );
      const description = last?.role === "tool" ? browserDescription(last.content) : null;
      if (description) pageId = description.controlPermit.pageId;
      if (stage > 0 && last?.role === "tool") {
        assert.ok(
          !/"success":false/.test(last.content),
          "scripted browser flow must actually succeed",
        );
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (delta, finish_reason) =>
        response.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      await readNativeSnapshot();
      const steps = [
        ...(fixture.id === GENERATED_TASK.id
          ? [
              {
                tool: "fs_create",
                arguments: {
                  path: fixture.localName,
                  text: `<!doctype html><html lang="en"><meta charset="utf-8"><title>${fixture.expected.title}</title><body><h1>${fixture.expected.title}</h1><h2>Results</h2><p>${fixture.expected.nonce}</p></body></html>`,
                },
              },
            ]
          : []),
        { operation: "describe", parameters: {} },
        ...fixtureSteps().flatMap((step, index) =>
          ["navigate", "openDocument"].includes(step.operation) && index > 0
            ? [{ operation: "observe", parameters: { pageId } }, step]
            : [step],
        ),
      ];
      if (stage < steps.length) {
        const scripted = steps[stage++];
        let step = scripted;
        if (scripted.fixtureRefClick) {
          assert.equal(steps[stage - 2]?.operation, "observe");
          const observation = browserObservation(last?.content, pageId);
          assert.ok(observation, "Ref click requires the immediately preceding observe receipt");
          const matches = observation.nodes.filter(
            (node) =>
              node.role === "link" &&
              node.name === scripted.fixtureRefClick &&
              typeof node.ref === "string",
          );
          assert.equal(matches.length, 1, "Ref click requires one exact observed link");
          step = {
            operation: "act",
            parameters: {
              pageId,
              snapshotId: observation.observationId,
              action: { kind: "click", ref: matches[0].ref },
            },
          };
        }
        if (step.operation !== "describe" && step.tool !== "fs_create")
          assert.ok(pageId, "next browser operation requires the actual describe receipt page ID");
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: `pipeline-${stage - 1}`,
                type: "function",
                function: {
                  name: step.tool ?? "browser_v1",
                  arguments: JSON.stringify(step.arguments ?? step),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        const e = fixture.expected;
        send(
          {
            content: `${e.heading}; ${e.code}; ${e.name}; ${e.desk}; ${e.hours}; Visitor reception; ${e.room}; ${e.contact}.`,
          },
          "stop",
        );
      }
      response.end("data: [DONE]\n\n");
    },
    async run({ app, page, command, readCoreThread, projectId, setThread, scratch }) {
      nativeApp = app;
      const setupStarted = performance.now();
      const created = await command("create", taskCreateRequest(projectId, fixture.id));
      setThread(created.threadId);
      const inspection = await command("manage", {
        projectId,
        threadId: created.threadId,
        operation: "inspect",
      });
      const effectiveConfiguration = inspection.configuration;
      assert.equal(effectiveConfiguration.options.permissionPreset, "ask");
      assert.equal(effectiveConfiguration.permissions.reviewer, "human");
      assert.deepEqual(
        effectiveConfiguration.toolAllowlist,
        taskCreateRequest(projectId, fixture.id).options.toolAllowlist,
      );
      assert.equal(effectiveConfiguration.options.maxModelRounds, BUDGET.maxModelRounds);
      const { selectConversation } = await import("./smoke-navigation.mjs");
      await selectConversation(page, created.threadId);
      await writeFile(join(scratch, "task-prompt.txt"), fixture.prompt);
      const started = performance.now();
      const taskDeadline = started + BUDGET.timeoutMs;
      let status = "running";
      let history;
      let stop = {};
      const approvals = [];
      const answeredApprovals = new Set();
      partial = {
        status: "unknown",
        identity: configuration.identity,
        freezeDigest: configuration.freezeDigest,
        instanceSeed: configuration.instanceSeed,
        prompt: fixture.prompt,
        threadId: created.threadId,
        facts: fixture.facts,
        expected: fixture.expected,
        approvals,
        stop,
      };
      await command("send", { projectId, threadId: created.threadId, text: fixture.prompt });
      while (performance.now() < taskDeadline) {
        if (
          fixture.id === "stop" &&
          fixture.facts.effects.length &&
          stop.requestedAtMs === undefined
        ) {
          stop = {
            requestedAtMs: performance.now() - started,
            effectCountAtStop: fixture.facts.effects.length,
          };
          partial.stop = stop;
          await page.getByRole("button", { name: "暂停执行", exact: true }).click();
        }
        history = await readCoreThread();
        await readNativeSnapshot();
        partial.history = history;
        partial.timings = {
          setupMs: started - setupStarted,
          sendToTerminalMs: null,
          observedUntilMs: performance.now() - started,
        };
        if (performance.now() >= taskDeadline) break;
        const terminal = history.turns?.at(-1)?.status;
        if (["completed", "failed", "interrupted"].includes(terminal)) {
          status = terminal;
          break;
        }
        if (stop.requestedAtMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        const pending = await command("manage", {
          projectId,
          threadId: created.threadId,
          operation: "interactions",
        });
        for (const interaction of pending.data.filter(
          (item) => item.status === "pending" && item.kind === "approval",
        )) {
          if (answeredApprovals.has(interaction.requestId)) continue;
          await readNativeSnapshot();
          if (performance.now() >= taskDeadline) break;
          if (interaction.tool === "fs_create") {
            history = await readCoreThread();
            partial.history = history;
          }
          const before = performance.now();
          const scope = {
            threadId: created.threadId,
            turnId: history.turns?.at(-1)?.id,
            origins: [...fixture.origins, ...trustedDocumentOrigins(history, fixture.localPath)],
            localPath: ["local-html", GENERATED_TASK.id].includes(fixture.id)
              ? fixture.localPath
              : null,
            allowFileCreate: fixture.id === GENERATED_TASK.id,
            fsCreateCalls: (history.turns?.at(-1)?.items ?? [])
              .filter((item) => item.type === "dynamicToolCall" && item.tool === "fs_create")
              .map((item) => ({
                callId: item.callId,
                path: item.execution?.effectiveArguments?.path ?? item.arguments?.path,
              })),
            blankPageIds: coldStartPageIds(history),
            normalControlsOnly: configuration.normalControlsOnly === true,
          };
          const decision = taskApprovalDecision(interaction, scope);
          if (performance.now() >= taskDeadline) break;
          const record = {
            requestId: interaction.requestId,
            callId: interaction.callId,
            atMs: before - started,
            plan: interaction.effectiveArguments?.plan,
            ...decision,
          };
          approvals.push(record);
          answeredApprovals.add(interaction.requestId);
          await command("respond", {
            projectId,
            threadId: created.threadId,
            requestId: interaction.requestId,
            decision: decision.decision,
          });
          record.waitMs = performance.now() - before;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (status === "running") {
        status = "timeout";
        if (
          stop.requestedAtMs === undefined &&
          !["completed", "failed", "interrupted"].includes(history?.turns?.at(-1)?.status)
        ) {
          history = await readCoreThread();
          partial.history = history;
        }
        if (
          stop.requestedAtMs === undefined &&
          !["completed", "failed", "interrupted"].includes(history?.turns?.at(-1)?.status)
        ) {
          stop = {
            requestedAtMs: performance.now() - started,
            effectCountAtStop: fixture.facts.effects.length,
          };
          partial.stop = stop;
          await page
            .getByRole("button", { name: "暂停执行", exact: true })
            .click()
            .catch(() => {});
        }
        const deadline = performance.now() + 10000;
        while (performance.now() < deadline) {
          history = await readCoreThread();
          if (["completed", "failed", "interrupted"].includes(history.turns?.at(-1)?.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      const terminalAt = performance.now();
      const terminalObserved = ["completed", "failed", "interrupted"].includes(
        history?.turns?.at(-1)?.status,
      );
      if (fixture.id === "stop" && stop.requestedAtMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, BUDGET.stopObservationMs));
        stop.effectsAfterWindow = fixture.facts.effects.length;
        stop.providerInFlight =
          configuration.mode === "fixture"
            ? 0
            : await fetch(configuration.statusEndpoint)
                .then((response) => response.json())
                .then((value) => value.inFlight)
                .catch(() => null);
      }
      history = await readCoreThread();
      await readNativeSnapshot();
      if (fixture.id === "todomvc/active" && nativeSnapshot && terminalObserved) {
        const finalBeforeVerify = structuredClone(nativeSnapshot);
        const evidence = { observedRestart, actions: [] };
        try {
          evidence.control = await takeOverTodoVerification(page, {
            projectId,
            threadId: created.threadId,
            taskURL: fixture.url,
          });
          for (const [filter, field] of [
            ["All", "allSnapshot"],
            ["Active", "restoredSnapshot"],
          ]) {
            evidence.actions.push({
              filter,
              ...(await clickTodoVerificationFilter(app, fixture.url, finalBeforeVerify, filter)),
            });
            const verificationDeadline = performance.now() + 3000;
            do {
              await readNativeSnapshot();
              if (
                nativeSnapshot?.selectedFilter === filter &&
                nativeSnapshot.hash === (filter === "All" ? "#/" : "#/active")
              )
                break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            } while (performance.now() < verificationDeadline);
            if (nativeSnapshot?.selectedFilter !== filter)
              throw Error("TodoMVC verification filter did not settle");
            evidence[field] = structuredClone(nativeSnapshot);
          }
        } catch (error) {
          evidence.verificationError = error.message;
          evidence.lastSnapshot = structuredClone(nativeSnapshot);
        }
        nativeSnapshot = { ...finalBeforeVerify, runnerEvidence: evidence };
      }
      const nativePages = await app.evaluate(async ({ webContents }, allowedOrigin) => {
        const result = [];
        for (const contents of webContents.getAllWebContents()) {
          let url;
          try {
            if (contents.isDestroyed()) continue;
            url = contents.getURL();
            if (
              !(
                (typeof allowedOrigin === "string" && url.startsWith(allowedOrigin)) ||
                /^http:\/\/[a-f0-9]+\.localhost:\d+\//.test(url)
              )
            )
              continue;
            result.push(
              await contents.executeJavaScript(
                '({url:location.href,title:document.title,text:document.body.innerText,headings:Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"),node=>node.innerText.trim())})',
              ),
            );
          } catch (error) {
            if (url) result.push({ url, unavailable: true, error: error.message });
          }
        }
        return result;
      }, fixture.origin);
      let diskArtifact;
      let nativeCapture;
      if (fixture.id === GENERATED_TASK.id) {
        const bytes = await readFile(fixture.localPath).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        const content = bytes?.toString("utf8") ?? "";
        const text = (value) =>
          value
            .replace(/<[^>]*>/g, "")
            .replace(/\s+/g, " ")
            .trim();
        diskArtifact = {
          path: fixture.localPath,
          exists: bytes !== null,
          sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
          title: text(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content)?.[1] ?? ""),
          headings: [...content.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((match) =>
            text(match[1]),
          ),
          noncePresent: content.includes(fixture.expected.nonce),
        };
        nativeCapture = await captureGeneratedNativePage(
          app,
          [...new Set(trustedDocumentUrls(history, fixture.localPath))],
          join(scratch, "generated-local-html-native.png"),
        );
        Object.assign(partial, { diskArtifact, nativeCapture });
      }
      await page.screenshot({ path: join(scratch, "task-final.png") });
      const result = {
        status,
        deadlineExceeded: status === "timeout",
        lateTerminal:
          status === "timeout" && terminalObserved
            ? { status: history?.turns?.at(-1)?.status, observedAtMs: terminalAt - started }
            : null,
        identity: configuration.identity,
        freezeDigest: configuration.freezeDigest,
        instanceSeed: configuration.instanceSeed,
        initialSnapshot,
        nativeSnapshot,
        threadId: created.threadId,
        prompt: fixture.prompt,
        effectiveConfiguration,
        history,
        nativePages,
        diskArtifact,
        nativeCapture,
        facts: fixture.facts,
        expected: fixture.expected,
        stop,
        approvals,
        elapsedMs: performance.now() - started,
        timings: {
          setupMs: started - setupStarted,
          sendToTerminalMs: terminalObserved ? terminalAt - started : null,
          observedUntilMs: terminalAt - started,
          verificationMs: performance.now() - terminalAt,
        },
      };
      await atomicJSON(join(scratch, "task-result.json"), result);
      return result;
    },
    async finish(scratch, events, errors) {
      await fixture.close();
      const result = events.taskBenchmark ??
        partial ?? { status: "blocked", facts: fixture.facts, expected: fixture.expected, errors };
      const files = await readdir(scratch, { recursive: true }).catch(() => []);
      const audits = [];
      const auditErrors = [];
      for (const file of files.filter(
        (file) => file.includes("model-requests/") && file.endsWith(".json"),
      )) {
        const audit = await readFile(join(scratch, file), "utf8")
          .then(JSON.parse)
          .catch(() => null);
        if (audit?.requestId) audits.push({ ...audit, auditPath: file });
        else auditErrors.push({ path: file, reason: "Missing or invalid request audit" });
      }
      result.audits = audits;
      result.auditErrors = auditErrors;
      result.processes = {
        launch: await readFile(join(scratch, "task-launch.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null),
        core: await readFile(join(scratch, "core/service.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null),
      };
      result.identity = configuration.identity;
      result.freezeDigest = configuration.freezeDigest;
      result.initialSnapshot = initialSnapshot;
      result.nativeSnapshot = nativeSnapshot;
      result.fixtureErrors = fixtureErrors;
      result.nativeLifecycle = events.nativeDialogTrace ?? null;
      result.cleanup = events.cleanup;
      result.errors = errors;
      // 代理的在途数由父执行器补齐，缺失时保持未知。
      result.grading = gradeTask(fixture.id, result);
      await atomicJSON(join(scratch, "task-result.json"), result);
      await atomicJSON(configuration.resultPath, { ...result, evidence: scratch });
    },
  };
}
