import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const ts = require("typescript");
const source = await readFile(
  new URL("../renderer/src/side-model-intent.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { sideStartConfiguration } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
const { CoreBackend } = appRequire("../app/src/core/backend.cjs");
test("historical anchor A with current source C: renderer default intent reaches adapter as inherit, default B and explicit C remain distinct", async () => {
  const project = {
    configurations: { source: { model: { providerId: "p", modelId: "C" } } },
    client: { capabilities: { methods: ["areal/side/start"] } },
  };
  for (const [draft, expected] of [
    [null, {}],
    [{ model: null }, { resetModel: true }],
    [{ model: { providerId: "p", modelId: "C" } }, { model: { providerId: "p", modelId: "C" } }],
  ]) {
    let sent;
    const backend = {
      closing: false,
      start: async () => project,
      submit: async (_project, method, params) => {
        assert.equal(method, "areal/side/start");
        sent = params;
        return { thread: { id: "side" }, turn: { id: "first" }, requestId: "receipt" };
      },
      openThread: async () => {},
      listThreads: async () => {},
    };
    await CoreBackend.prototype.executeCommand.call(backend, "side", {
      projectId: "p",
      operation: "start",
      sourceThreadId: "source",
      workspaceAccess: "none",
      requestId: "receipt",
      text: "question",
      anchor: { kind: "turn", turnId: "A-turn", boundary: "after" },
      ...sideStartConfiguration(draft),
    });
    assert.deepEqual(
      {
        ...(sent.model ? { model: sent.model } : {}),
        ...(sent.resetModel ? { resetModel: sent.resetModel } : {}),
      },
      expected,
    );
    assert.equal(
      sent.parameters,
      undefined,
      "untouched source C parameters must not override historical anchor",
    );
  }
});
