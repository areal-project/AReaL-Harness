import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreClient } from "../packages/runtime-client/core.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { validToolInput } = require("../packages/browser-automation/src/host-tool.cjs");

test("browser observation and capture accept only bounded declared parameters", () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  assert.equal(
    validToolInput({
      operation: "observe",
      parameters: { pageId, scope: "document", budget: { nodes: 20, textBytes: 1024 } },
    }),
    true,
  );
  assert.equal(
    validToolInput({ operation: "observe", parameters: { pageId, scope: "viewport" } }),
    false,
  );
  assert.equal(
    validToolInput({ operation: "capture", parameters: { pageId, scope: "viewport" } }),
    true,
  );
  assert.equal(
    validToolInput({ operation: "observe", parameters: { pageId, budget: { nodes: 1001 } } }),
    false,
  );
  assert.equal(
    validToolInput({ operation: "capture", parameters: { pageId, scope: "full" } }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: { pageId, snapshotId: pageId, action: { kind: "click", ref: "r1" } },
    }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "click", ref: "r1", preparedActionId: "forged" },
      },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "fill", ref: "r1", value: "ok", allow: true },
      },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: { pageId, snapshotId: pageId, action: { kind: "clickAt", x: 320, y: 180 } },
    }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "drag", fromX: 10, fromY: 20, toX: 300, toY: 210, steps: 4 },
      },
    }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "pressAt", x: 320, y: 180, key: "ArrowRight" },
      },
    }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: { pageId, snapshotId: pageId, action: { kind: "clickAt", x: -1, y: 180 } },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "drag", fromX: 1, fromY: 1, toX: 2, toY: 2, steps: 101 },
      },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "clickAt", x: 320, y: 180, approved: true },
      },
    }),
    false,
  );
  assert.equal(
    validToolInput({ operation: "wait", parameters: { pageId, timeoutMs: 30001 } }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "navigate",
      parameters: { pageId, url: "http://localhost:3000/next" },
    }),
    true,
  );
  assert.equal(
    validToolInput({ operation: "openDocument", parameters: { pageId, path: "/tmp/report.html" } }),
    true,
  );
  assert.equal(
    validToolInput({
      operation: "openDocument",
      parameters: { pageId, path: "/tmp/report.html", workspacePath: "/tmp" },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "navigate",
      parameters: { pageId, url: "file:///tmp/report.html" },
    }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "newPage",
      parameters: { pageId, url: "http://localhost:3000/new" },
    }),
    true,
  );
  assert.equal(
    validToolInput({ operation: "newPage", parameters: { pageId, url: "javascript:alert(1)" } }),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "navigate",
      parameters: { pageId, url: "http://localhost:3000", allow: true },
    }),
    false,
  );
});

test("native browser controls accept bounded intent and reject injected execution details", () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const act = (action) =>
    validToolInput({ operation: "act", parameters: { pageId, snapshotId: pageId, action } });
  const wait = (condition) =>
    validToolInput({ operation: "wait", parameters: { pageId, timeoutMs: 500, condition } });
  for (const action of [
    { kind: "scroll", target: "viewport", deltaX: 0, deltaY: 512 },
    { kind: "hover", ref: "r1" },
    { kind: "selectOption", ref: "r1", value: "exact" },
    { kind: "setChecked", ref: "r1", checked: true },
  ]) {
    assert.equal(act(action), true, JSON.stringify(action));
    for (const injected of [{ selector: "#control" }, { backendNodeId: 42 }, { code: "alert(1)" }])
      assert.equal(act({ ...action, ...injected }), false);
  }
  for (const delta of [0.5, 4097, -4097, Infinity, NaN, "10"])
    assert.equal(act({ kind: "scroll", target: "viewport", deltaX: 0, deltaY: delta }), false);
  assert.equal(act({ kind: "scroll", target: "viewport", deltaX: 0, deltaY: 0 }), false);
  assert.equal(act({ kind: "selectOption", ref: "r1", value: "x".repeat(257) }), false);
  assert.equal(act({ kind: "setChecked", ref: "r1", checked: "true" }), false);
  for (const kind of ["checked", "enabled"]) {
    assert.equal(wait({ kind, ref: "r1", value: false }), true);
    assert.equal(wait({ kind, ref: "r1", value: true }), true);
    assert.equal(wait({ kind, ref: "r1", value: "false" }), false);
    assert.equal(wait({ kind, ref: "r1", value: false, selector: "#control" }), false);
  }
});

test("batch accepts only eight observed same-page actions or bounded waits", () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const snapshotId = "00000000-0000-4000-8000-000000000002";
  const click = { operation: "act", snapshotId, action: { kind: "click", ref: "r1" } };
  const wait = { operation: "wait", timeoutMs: 50 };
  const input = (steps) => ({ operation: "runBatch", parameters: { pageId, snapshotId, steps } });
  assert.equal(validToolInput(input([click, wait])), true);
  assert.equal(validToolInput(input(Array(8).fill(wait))), true);
  assert.equal(validToolInput(input([])), false);
  assert.equal(validToolInput(input(Array(9).fill(wait))), false);
  assert.equal(validToolInput(input([{ operation: "navigate", url: "http://localhost/" }])), false);
  assert.equal(validToolInput(input([{ ...click, pageId }])), false);
  assert.equal(
    validToolInput(
      input([click, { operation: "act", snapshotId, action: { kind: "clickAt", x: 1, y: 1 } }]),
    ),
    false,
  );
  assert.equal(
    validToolInput({
      operation: "runBatch",
      parameters: { pageId, snapshotId, steps: [click], approved: true },
    }),
    false,
  );
});

test("bound client may answer a browser tool request while ordinary clients reject it", async () => {
  const replies = [];
  const socket = { readyState: 1, send: (data) => replies.push(JSON.parse(data)) };
  const request = {
    id: 9,
    method: "item/tool/call",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      tool: "browser_v1",
      arguments: { operation: "observe", parameters: { pageId: "page-1" } },
    },
  };
  const ordinary = new CoreClient({ createSocket: () => socket });
  ordinary.socket = socket;
  ordinary.receive(JSON.stringify(request));
  assert.equal(replies.at(-1).error.code, -32601);

  const bound = new CoreClient({
    createSocket: () => socket,
    onServerRequest: async () => ({
      success: true,
      contentItems: [{ type: "inputText", text: "fixture sentinel" }],
    }),
  });
  bound.socket = socket;
  bound.receive(JSON.stringify(request));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.at(-1).id, 9);
  assert.equal(replies.at(-1).result.contentItems[0].text, "fixture sentinel");
});

test("browser describe examples expose valid checkbox and command-topic parameters", async () => {
  const pageId = "00000000-0000-4000-8000-000000000001";
  const { tools, frame, preview } = nativeBrowserFixture();
  const page = { pageId, control: "agent" };
  preview.page = () => page;
  preview.pageStillOwned = (candidate) => candidate === page;
  preview.ensureAgentPage = async () => page;
  preview.workspace = { workspacePages: () => [page] };
  frame.params.arguments = { operation: "describe", parameters: {} };
  delete frame.params.browserApproval;
  const result = await tools.callback(frame, new AbortController().signal);
  assert.equal(result.success, true);
  const description = JSON.parse(result.contentItems[0].text);
  const checkbox = description.examples.find(
    (example) => example.operation === "act" && example.parameters.action?.kind === "setChecked",
  );
  const topic = description.examples.find(
    (example) =>
      example.operation === "describe" && example.parameters.topic === "command.playwright.locator",
  );
  assert.ok(checkbox, "the model receives an explicit checked:boolean action example");
  assert.ok(topic, "the model receives a supported describe topic example");
  for (const example of [checkbox, topic]) {
    const input = structuredClone(example);
    if (input.parameters.pageId) input.parameters.pageId = pageId;
    if (input.parameters.snapshotId) input.parameters.snapshotId = pageId;
    if (input.parameters.action?.ref) input.parameters.action.ref = "r1";
    assert.equal(validToolInput(input), true, JSON.stringify(input));
  }
  assert.equal(checkbox.parameters.action.checked, true);
  assert.match(description.parameterGuide, /checked.*boolean/);
  assert.match(description.parameterGuide, /command\.<method>/);
  assert.equal(
    validToolInput({
      operation: "act",
      parameters: {
        pageId,
        snapshotId: pageId,
        action: { kind: "setChecked", ref: "r1", value: true },
      },
    }),
    false,
  );
  assert.equal(validToolInput({ operation: "describe", parameters: { topic: "act" } }), false);
});

function nativeBrowserFixture() {
  const { NativeBrowserTools } = require("../app/src/core/generated/native-browser-tools.cjs");
  const permit = {
    pageId: "00000000-0000-4000-8000-000000000001",
    browserHostId: "browser",
    hostGeneration: 2,
    pageGeneration: 3,
    controlEpoch: 4,
    origin: "https://before.example",
  };
  const frame = {
    sourceId: "source",
    projectId: "execution-project",
    guiProjectId: "logical-project",
    workspacePath: "/workspace/checkout",
    lease: "original-lease",
    coreInstanceId: "core",
    coreGeneration: "generation",
    connectionId: "connection",
    coreRequestId: 17,
    method: "item/tool/call",
    params: {
      tool: "browser_v1",
      threadId: "thread",
      turnId: "turn",
      callId: "call",
      hostGeneration: "tool-generation",
      arguments: {
        operation: "capture",
        parameters: { pageId: "00000000-0000-4000-8000-000000000001", scope: "viewport" },
      },
      browserApproval: { plan: { preparedActionId: "plan" } },
    },
  };
  const calls = [];
  let connected = true;
  const preview = {
    page: () => ({ control: "agent" }),
    controlPermit: (projectId, threadId, pageId) => {
      assert.equal(projectId, frame.guiProjectId);
      assert.equal(threadId, "thread");
      assert.equal(pageId, "00000000-0000-4000-8000-000000000001");
      return { ...permit };
    },
    execute: async (request) => {
      calls.push(request);
      return { mimeType: "image/png", imageBase64: "aW1hZ2U=" };
    },
    cancelRead: (request) => calls.push({ cancelled: request }),
  };
  const tools = new NativeBrowserTools({
    preview: () => preview,
    current: () => connected,
    call: async (method, params) => {
      calls.push({ method, params });
      return { uri: "areal://media/original" };
    },
    reveal: () => {},
  });
  return {
    tools,
    preview,
    permit,
    frame,
    calls,
    disconnect: () => {
      connected = false;
    },
  };
}

test("native browser capture binds logical preview to original execution Core media lease", async () => {
  const f = nativeBrowserFixture();
  const result = await f.tools.callback(f.frame, new AbortController().signal);
  assert.equal(f.calls[0].projectId, "logical-project");
  assert.equal(f.calls[0].workspacePath, "/workspace/checkout");
  assert.deepEqual(f.calls[1], {
    method: "core.blob",
    params: {
      sourceId: "source",
      projectId: "execution-project",
      lease: "original-lease",
      operation: "upload",
      threadId: "thread",
      callId: "call",
      hostGeneration: "tool-generation",
      mime: "image/png",
      base64: "aW1hZ2U=",
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.contentItems[1], {
    type: "arealMedia",
    modality: "image",
    media: { uri: "areal://media/original" },
  });
  assert.doesNotMatch(JSON.stringify(result), /aW1hZ2U=/);
});

test("native browser approved navigation accepts its new origin but revoked execution remains UNKNOWN", async () => {
  for (const revoke of [false, true]) {
    const f = nativeBrowserFixture();
    f.frame.params.arguments = {
      operation: "navigate",
      parameters: { pageId: "00000000-0000-4000-8000-000000000001", url: "https://after.example" },
    };
    f.preview.execute = async () => {
      f.permit.origin = "https://after.example";
      if (revoke) f.permit.controlEpoch++;
      return { dispatch: "confirmed" };
    };
    const result = await f.tools.callback(f.frame, new AbortController().signal);
    assert.equal(result.success, !revoke);
    assert.equal(result.structuredContent.dispatch, revoke ? "unknown" : "confirmed");
    if (!revoke)
      assert.equal(result.structuredContent.controlPermit.origin, "https://after.example");
  }
});

test("native browser owner loss during capture cannot publish or upload the old image", async () => {
  const f = nativeBrowserFixture();
  f.preview.execute = async () => {
    f.disconnect();
    return { mimeType: "image/png", imageBase64: "aW1hZ2U=" };
  };
  const result = await f.tools.callback(f.frame, new AbortController().signal);
  assert.equal(result.success, false);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /arealMedia|aW1hZ2U=/);
});

test("native browser preparation returns the native plan and execute requires Core approval", async () => {
  const f = nativeBrowserFixture();
  f.frame.method = "areal/browser/prepare";
  f.preview.prepare = async (request) => ({
    plan: {
      preparedActionId: "original-plan",
      pageId: request.pageId,
      operation: request.operation,
    },
  });
  const prepared = await f.tools.callback(f.frame, new AbortController().signal);
  assert.equal(prepared.preparedActionId, "original-plan");
  f.frame.method = "item/tool/call";
  delete f.frame.params.browserApproval;
  const rejected = await f.tools.callback(f.frame, new AbortController().signal);
  assert.equal(rejected.structuredContent.code, "approval_required");
  assert.equal(f.calls.length, 0);
});

test("native executor distinguishes refused input from dispatched UNKNOWN", async () => {
  for (const message of ["plan_stale", "not_sent", "outcome_unknown"]) {
    const f = nativeBrowserFixture();
    f.frame.params.arguments = {
      operation: "navigate",
      parameters: { pageId: f.permit.pageId, url: "https://after.example" },
    };
    f.preview.execute = async () => {
      throw Object.assign(new Error(message), { reason: "navigation_timeout" });
    };
    const result = await f.tools.callback(f.frame, new AbortController().signal);
    assert.equal(result.success, false);
    assert.equal(
      result.structuredContent.code,
      message === "outcome_unknown" ? "outcome_unknown" : message,
    );
    assert.equal(
      result.structuredContent.dispatch,
      message === "outcome_unknown" ? "unknown" : "not_sent",
    );
    if (message === "outcome_unknown")
      assert.equal(result.structuredContent.reason, "navigation_timeout");
  }
  const f = nativeBrowserFixture();
  f.frame.params.arguments = {
    operation: "wait",
    parameters: { pageId: f.permit.pageId, timeoutMs: 1 },
  };
  f.preview.execute = async () => {
    throw new Error("condition_timeout");
  };
  const result = await f.tools.callback(f.frame, new AbortController().signal);
  assert.equal(result.structuredContent.code, "condition_timeout");
  assert.equal(result.structuredContent.dispatch, "not_sent");
});
