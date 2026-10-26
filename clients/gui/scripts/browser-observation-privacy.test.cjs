"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { BrowserReads } = require("../app/src/core/preview-native/reads.cjs");
const { NativePageTargets } = require("../app/src/core/preview-native/native-targets.cjs");
const query = "AI Agent";
function field(id, name, value = query, role = "textbox") {
  return {
    nodeId: id,
    parentId: "root",
    backendDOMNodeId: Number(id),
    role: { value: role },
    name: { value: name },
    value: { value },
  };
}
function label(id, name, parentId = "root") {
  return {
    nodeId: id,
    parentId,
    backendDOMNodeId: Number(id),
    role: { value: "link" },
    name: { value: name },
  };
}
async function observe(options = {}) {
  const url = options.url ?? "https://search.example/search?q=AI+Agent";
  const intent = {
    kind: "public_search",
    method: "GET",
    query,
    queryName: "q",
    submittedFields: [["q", query]],
    targetOrigin: "https://search.example",
    targetPath: "/search",
    controlEpoch: 2,
    pageGeneration: 1,
    expiresAt: Date.now() + 30000,
    ...options.intent,
  };
  const nodes = options.nodesOverride ?? [
    { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Search results" } },
    field("1", "Search"),
    label("2", "What Are AI Agents? | IBM"),
    label("3", "What are AI Agents? - AWS"),
    label("4", "AI agent - Wikipedia"),
    label("5", query, "1"),
    ...(options.nodes ?? []),
  ];
  const form = {
    method: "get",
    action: "https://search.example/search",
    target: "",
    acceptCharset: "UTF-8",
    getAttribute: (name) => (name === "role" ? "search" : null),
  };
  const elements = [1, 6].map((id) => ({
    tagName: "INPUT",
    type: "text",
    name: id === 1 ? "q" : "notes",
    id: String(id),
    value: query,
    autocomplete: "",
    form,
    getAttribute: () => null,
    hasAttribute: () => false,
    matches: () => false,
    closest: (selector) => (selector === "form" ? form : null),
  }));
  form.elements = elements;
  const c = Object.assign(new EventEmitter(), {
    id: 42,
    getURL: () => url,
    getTitle: () => "Search results",
    getZoomFactor: () => 1,
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    debugger: Object.assign(new EventEmitter(), {
      isAttached: () => true,
      detach: () => {},
      sendCommand: async (method, params) => {
        if (method === "Page.createIsolatedWorld") return { executionContextId: 7 };
        if (method === "Runtime.evaluate") {
          assert.equal(params.contextId, 7);
          return {
            result: {
              value: { width: 800, height: 600, scrollX: 0, scrollY: 0, deviceScaleFactor: 1 },
            },
          };
        }
        if (options.realClassification) {
          if (method === "DOM.resolveNode")
            return { object: { objectId: String(params.backendNodeId) } };
          if (method === "Runtime.callFunctionOn") {
            const fn = Function(
              "document",
              "return (" + params.functionDeclaration + ")",
            )({ characterSet: "UTF-8" });
            return {
              result: {
                value: fn.call(
                  elements.find((e) => e.id === params.objectId),
                  ...params.arguments.map((a) => a.value),
                ),
              },
            };
          }
          if (method === "Runtime.releaseObject") return {};
        }
        return method === "Accessibility.getFullAXTree"
          ? { nodes }
          : method === "Page.getFrameTree"
            ? { frameTree: { frame: { id: "main", url } } }
            : Promise.reject(Error(method));
      },
    }),
  });
  const page = {
    id: "page",
    projectId: "project",
    threadId: "thread",
    coreInstanceId: "core",
    pageGeneration: 1,
    documentGeneration: 1,
    controlEpoch: 2,
    control: "agent",
    refs: new Map(),
    nativeControls: new Map(),
    optionIds: new Map(),
    plans: new Map(),
    nextRef: 0,
    viewportRevision: 0,
    view: { webContents: c, getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) },
    networkPolicy: { canAuthorize: () => true },
    approvedActionNavigation: options.noIntent ? null : intent,
  };
  let classificationCalls = 0;
  const workspace = {
    browserHostId: "host",
    hostGeneration: 1,
    page: () => page,
    owns: () => true,
    pageStillOwned: () => true,
  };
  const targets = {
    nativeControl: async () => ({ control: null }),
    publicActionSemantics: async (_page, _c, target, action, requireQueryField) => {
      classificationCalls++;
      if (options.realClassification)
        return new NativePageTargets().publicActionSemantics(
          _page,
          _c,
          target,
          action,
          requireQueryField,
        );
      if (options.classificationFailure) throw Error("native unavailable");
      if (options.classificationRevoke) {
        page.control = "human";
        page.controlEpoch++;
        page.activeRead.cancel();
        return null;
      }
      if (options.classificationNavigate) {
        page.documentGeneration++;
        page.activeRead.cancel();
        return null;
      }
      return target.backendNodeId === 1 ? { ...intent, ...options.semantics } : null;
    },
  };
  const reads = new BrowserReads(
    targets,
    { window: { webContents: { getZoomFactor: () => 1 } } },
    workspace,
    () => {
      throw Error("unexpected diagnostics");
    },
  );
  const result = await reads.observe({
    operation: "observe",
    parameters: { budget: options.budget ?? { nodes: 1000, textBytes: 64000 } },
    projectId: "project",
    threadId: "thread",
    pageId: "page",
    coreInstanceId: "core",
    coreGeneration: "generation",
    browserHostId: "host",
    hostGeneration: 1,
    pageGeneration: 1,
    controlEpoch: 2,
  });
  return { result, page, classificationCalls };
}
const title = (r) => r.result.nodes.find((n) => n.name === "What Are AI Agents? | IBM");
const hidden = (r) => assert.equal(title(r), undefined);
test("approved current native GET query does not conceal result titles or their Refs; field values and subtree stay hidden", async () => {
  const r = await observe({ realClassification: true });
  assert.ok(title(r)?.ref);
  assert.ok(r.result.nodes.some((n) => n.name === "What are AI Agents? - AWS" && n.ref));
  assert.ok(r.result.nodes.some((n) => n.name === "AI agent - Wikipedia"));
  assert.equal(r.result.nodes.find((n) => n.name === "Search").value, undefined);
  assert.equal(
    r.result.nodes.some((n) => n.name === query),
    false,
  );
  assert.equal(r.result.url, "https://search.example/search");
  assert.equal(r.page.approvedActionNavigation.expiresAt > Date.now(), true);
});
for (const [name, options] of [
  ["unapproved query", { noIntent: true }],
  ["wrong control epoch", { intent: { controlEpoch: 1 } }],
  ["wrong page generation", { intent: { pageGeneration: 2 } }],
  ["expired intent", { intent: { expiresAt: 1 } }],
  ["wrong origin", { url: "https://other.example/search?q=AI+Agent" }],
  ["wrong path", { url: "https://search.example/other?q=AI+Agent" }],
  ["missing query", { url: "https://search.example/search" }],
  ["changed multiplicity", { url: "https://search.example/search?q=AI+Agent&q=AI+Agent" }],
  ["link permit", { intent: { kind: "link_navigation" } }],
  ["failed native classification", { classificationFailure: true }],
  ["POST field", { semantics: { method: "POST" } }],
  ["different native query", { semantics: { query: "other" } }],
  ["different native query name", { semantics: { queryName: "other" } }],
  ["different native destination", { semantics: { targetPath: "/other" } }],
  ["different submitted fields", { semantics: { submittedFields: [["q", "other"]] } }],
  ["unknown Notes same value", { realClassification: true, nodes: [field("6", "Notes")] }],
  ["password same value", { nodes: [field("6", "Password", query, "passwordField")] }],
  ["unclassified OTP same value", { nodes: [field("6", "Verification code")] }],
])
  test(name + " retains echo protection", async () => {
    const r = await observe(options);
    hidden(r);
  });
test("ordinary private field unrelated value still conceals echoed label", async () => {
  const r = await observe({
    nodes: [field("6", "Notes", "alpha-private"), label("7", "Link containing alpha-private")],
  });
  assert.equal(
    r.result.nodes.some((n) => n.name.includes("alpha-private")),
    false,
  );
  assert.ok(title(r));
});
test("native classification canceled by takeover cannot publish", async () => {
  await assert.rejects(observe({ classificationRevoke: true }), /human_control/);
});
test("native classification canceled by navigation cannot publish", async () => {
  await assert.rejects(observe({ classificationNavigate: true }), /plan_stale/);
});

test("sensitive field subtree stays concealed independently of allowed query", async () => {
  const r = await observe({
    nodes: [field("6", "Password", "private"), label("7", "AI Agent protected", "6")],
  });
  assert.equal(
    r.result.nodes.some((n) => n.name === "AI Agent protected"),
    false,
  );
  assert.ok(title(r));
});

test("AX child reading order exposes early query under budget despite late native array position", async () => {
  const root = {
    nodeId: "root",
    role: { value: "RootWebArea" },
    name: { value: "Page" },
    childIds: ["header", "footer"],
  };
  const header = {
    nodeId: "header",
    parentId: "root",
    role: { value: "generic" },
    name: { value: "" },
    description: { value: "Header container" },
    childIds: ["1"],
  };
  const queryField = { ...field("1", "Search privately", ""), parentId: "header" };
  const footer = { ...label("8", "Footer"), childIds: ["9"] };
  const footerText = {
    nodeId: "9",
    parentId: "8",
    role: { value: "StaticText" },
    name: { value: "Footer text" },
  };
  const r = await observe({
    noIntent: true,
    nodesOverride: [root, footer, footerText, header, queryField],
    budget: { nodes: 3, textBytes: 64000 },
  });
  const q = r.result.nodes.find((n) => n.name === "Search privately");
  assert.ok(q?.ref);
  assert.equal(q.parent, r.result.nodes.find((n) => n.role === "generic").id);
  assert.equal(r.result.truncated, true);
});

test("anonymous structure and duplicate inline text do not consume semantic node budget", async () => {
  const nodes = [
    {
      nodeId: "root",
      role: { value: "RootWebArea" },
      name: { value: "Results" },
      childIds: ["g0"],
    },
  ];
  for (let i = 0; i < 100; i++)
    nodes.push({
      nodeId: "g" + i,
      parentId: i ? "g" + (i - 1) : "root",
      role: { value: "generic" },
      name: { value: "" },
      childIds: i < 99 ? ["g" + (i + 1)] : ["a1", "a2", "a3", "orphan"],
    });
  for (let i = 1; i <= 3; i++)
    nodes.push(
      {
        nodeId: "a" + i,
        parentId: "g99",
        role: { value: "article" },
        name: { value: "" },
        childIds: ["h" + i],
      },
      {
        nodeId: "h" + i,
        parentId: "a" + i,
        role: { value: "heading" },
        name: { value: "Result " + i },
        childIds: ["t" + i],
      },
      {
        nodeId: "t" + i,
        parentId: "h" + i,
        role: { value: "StaticText" },
        name: { value: "Result " + i },
        childIds: ["i" + i],
      },
      {
        nodeId: "i" + i,
        parentId: "t" + i,
        role: { value: "InlineTextBox" },
        name: { value: "Result " + i },
      },
    );
  nodes.push({
    nodeId: "orphan",
    parentId: "g99",
    role: { value: "InlineTextBox" },
    name: { value: "Unique inline text" },
  });
  const r = await observe({
    noIntent: true,
    nodesOverride: nodes,
    budget: { nodes: 13, textBytes: 64000 },
  });
  assert.equal(
    r.result.nodes.some((n) => n.role === "generic"),
    false,
  );
  for (let i = 1; i <= 3; i++) {
    const h = r.result.nodes.find((n) => n.role === "heading" && n.name === "Result " + i);
    assert.ok(h);
    assert.equal(r.result.nodes.find((n) => n.id === h.parent).role, "article");
  }
  assert.equal(r.result.nodes.filter((n) => n.role === "InlineTextBox").length, 1);
  assert.ok(r.result.nodes.some((n) => n.name === "Unique inline text"));
  assert.equal(r.result.truncated, false);
});
test("projection keeps generic metadata, distinct inline text, and frame identity", async () => {
  const nodes = [
    { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Page" } },
    { nodeId: "1", parentId: "root", role: { value: "generic" }, name: { value: "Named" } },
    {
      nodeId: "2",
      parentId: "root",
      role: { value: "generic" },
      name: { value: "" },
      properties: [{ name: "disabled", value: { value: true } }],
    },
    {
      nodeId: "3",
      parentId: "root",
      role: { value: "generic" },
      name: { value: "" },
      frameId: "child",
    },
    { nodeId: "4", parentId: "root", role: { value: "StaticText" }, name: { value: "Full text" } },
    {
      nodeId: "5",
      parentId: "4",
      role: { value: "InlineTextBox" },
      name: { value: "Different text" },
    },
  ];
  const r = await observe({ noIntent: true, nodesOverride: nodes });
  assert.equal(r.result.nodes.length, 6);
  assert.ok(r.result.nodes.some((n) => n.frameId === "child"));
  assert.ok(r.result.nodes.some((n) => n.name === "Different text"));
});
test("omitted anonymous parents do not remove private field echo taint", async () => {
  const r = await observe({
    realClassification: true,
    nodes: [
      { nodeId: "wrapper", parentId: "root", role: { value: "generic" }, name: { value: "" } },
      { ...field("6", "Notes"), parentId: "wrapper" },
    ],
  });
  hidden(r);
  assert.equal(
    r.result.nodes.some((n) => n.name === query),
    false,
  );
});
