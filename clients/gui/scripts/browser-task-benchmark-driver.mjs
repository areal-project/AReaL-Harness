import assert from "node:assert/strict";
import { respondToSessionName } from "./model-fixture.mjs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  BUDGET,
  createTaskFixture,
  gradeTask,
  TASK_IDS,
  taskApprovalDecision,
  trustedDocumentOrigins,
  browserDescription,
  coldStartPageIds,
} from "./browser-task-benchmark-catalog.mjs";

export const taskCreateRequest = (projectId) => ({
  projectId,
  browserEnabled: true,
  options: {
    permissionPreset: "ask",
    maxModelRounds: BUDGET.maxModelRounds,
    toolAllowlist: ["browser_v1"],
  },
  profile: { id: "fixture", revision: "v1" },
});

export async function prepareTaskBenchmark(path, workspace) {
  const configuration = JSON.parse(await readFile(path, "utf8"));
  assert.ok(["fixture", "real"].includes(configuration.mode));
  assert.ok(TASK_IDS.includes(configuration.taskId));
  assert.ok(
    configuration.mode !== "real" ||
      (configuration.protocol === "responses" && configuration.model === "gpt-6.1-terra"),
  );
  const fixture = await createTaskFixture(configuration.taskId, workspace);
  let pageId;
  let stage = 0;
  let partial;
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
  const fixtureSteps = () =>
    ({
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
      information: [navigate("/information"), snapshot(), navigate("/detail/willow"), snapshot()],
      stop: [
        navigate("/stop"),
        ...Array.from({ length: 40 }, (_, n) => locator(`button:nth-of-type(${n + 1})`, "click")),
      ],
    })[fixture.id];
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
      const steps = [
        { operation: "describe", parameters: {} },
        ...fixtureSteps().flatMap((step, index) =>
          ["navigate", "openDocument"].includes(step.operation) && index > 0
            ? [{ operation: "observe", parameters: { pageId } }, step]
            : [step],
        ),
      ];
      if (stage < steps.length) {
        if (stage > 0)
          assert.ok(pageId, "next browser operation requires the actual describe receipt page ID");
        send(
          {
            tool_calls: [
              {
                index: 0,
                id: `pipeline-${stage}`,
                type: "function",
                function: { name: "browser_v1", arguments: JSON.stringify(steps[stage++]) },
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
      const setupStarted = performance.now();
      const created = await command("create", taskCreateRequest(projectId));
      setThread(created.threadId);
      const inspection = await command("manage", {
        projectId,
        threadId: created.threadId,
        operation: "inspect",
      });
      const effectiveConfiguration = inspection.configuration;
      assert.equal(effectiveConfiguration.options.permissionPreset, "ask");
      assert.equal(effectiveConfiguration.permissions.reviewer, "human");
      assert.deepEqual(effectiveConfiguration.toolAllowlist, ["browser_v1"]);
      assert.equal(effectiveConfiguration.options.maxModelRounds, BUDGET.maxModelRounds);
      const { selectConversation } = await import("./smoke-navigation.mjs");
      await selectConversation(page, created.threadId);
      await writeFile(join(scratch, "task-prompt.txt"), fixture.prompt);
      const started = performance.now();
      let status = "running";
      let history;
      let stop = {};
      const approvals = [];
      const answeredApprovals = new Set();
      partial = {
        status: "unknown",
        prompt: fixture.prompt,
        threadId: created.threadId,
        facts: fixture.facts,
        expected: fixture.expected,
        approvals,
        stop,
      };
      await command("send", { projectId, threadId: created.threadId, text: fixture.prompt });
      while (performance.now() - started < BUDGET.timeoutMs) {
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
        partial.history = history;
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
          const before = performance.now();
          const scope = {
            threadId: created.threadId,
            turnId: history.turns?.at(-1)?.id,
            origins: [...fixture.origins, ...trustedDocumentOrigins(history, fixture.localPath)],
            localPath: fixture.id === "local-html" ? fixture.localPath : null,
            blankPageIds: coldStartPageIds(history),
          };
          const decision = taskApprovalDecision(interaction, scope);
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
        if (stop.requestedAtMs === undefined) {
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
      const nativePages = await app.evaluate(async ({ webContents }, allowedOrigin) => {
        const result = [];
        for (const contents of webContents.getAllWebContents()) {
          const url = contents.getURL();
          if (!(url.startsWith(allowedOrigin) || /^http:\/\/[a-f0-9]+\.localhost:\d+\//.test(url)))
            continue;
          try {
            result.push(
              await contents.executeJavaScript(
                "({url:location.href,title:document.title,text:document.body.innerText})",
              ),
            );
          } catch {
            result.push({ url, unavailable: true });
          }
        }
        return result;
      }, fixture.origin);
      await page.screenshot({ path: join(scratch, "task-final.png") });
      const result = {
        status,
        threadId: created.threadId,
        prompt: fixture.prompt,
        effectiveConfiguration,
        history,
        nativePages,
        facts: fixture.facts,
        expected: fixture.expected,
        stop,
        approvals,
        elapsedMs: performance.now() - started,
        timings: {
          setupMs: started - setupStarted,
          sendToTerminalMs: terminalAt - started,
          verificationMs: performance.now() - terminalAt,
        },
      };
      await writeFile(join(scratch, "task-result.json"), JSON.stringify(result, null, 2));
      return result;
    },
    async finish(scratch, events, errors) {
      await fixture.close();
      const result = events.taskBenchmark ??
        partial ?? { status: "blocked", facts: fixture.facts, expected: fixture.expected, errors };
      const files = await readdir(scratch, { recursive: true }).catch(() => []);
      const audits = [];
      for (const file of files.filter(
        (file) =>
          file.includes("model-requests/") && file.endsWith(".json") && !file.includes("/errors/"),
      )) {
        const audit = await readFile(join(scratch, file), "utf8")
          .then(JSON.parse)
          .catch(() => null);
        if (audit?.requestId) audits.push(audit);
      }
      result.audits = audits;
      result.fixtureErrors = fixtureErrors;
      result.cleanup = events.cleanup;
      result.errors = errors;
      // 代理的在途数由父执行器补齐，缺失时保持未知。
      result.grading = gradeTask(fixture.id, result);
      await writeFile(join(scratch, "task-result.json"), JSON.stringify(result, null, 2));
      await writeFile(
        configuration.resultPath,
        JSON.stringify({ ...result, evidence: scratch }, null, 2),
      );
    },
  };
}
