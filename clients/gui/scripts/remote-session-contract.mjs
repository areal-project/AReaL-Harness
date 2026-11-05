import { SessionBodyReader, CommandState, acceptSessionMessage } from "@areal/remote-client";
import assert from "node:assert/strict";
import { BrowserState } from "../renderer/remote-web/browser-state.mjs";
import { browserDeviceName } from "../renderer/remote-web/device-name.mjs";
const baseline = {
  connectionId: "c",
  gatewayGeneration: "g",
  serviceGeneration: "s",
  subscriptionId: "r",
  projectId: "p",
  sequence: 0,
  snapshot: { threadId: "t", turns: [] },
};
assert.equal(acceptSessionMessage(baseline, { ...baseline, sequence: 1 }).kind, "update");
assert.equal(acceptSessionMessage(baseline, { ...baseline, sequence: 2 }).kind, "resync");
for (const key of ["connectionId", "gatewayGeneration", "serviceGeneration", "subscriptionId"])
  assert.equal(
    acceptSessionMessage(baseline, { ...baseline, [key]: "stale", sequence: 1 }).kind,
    "ignore",
  );

// 使用 Core 的原生工具输出形状，覆盖初始历史和 item/completed 两条投影路径。
const { snapshot, update } = await import("@areal/workbench-service/desktop/core/remote-session-projection.cjs");
const scope = ["p", "svc", "s", "t"];
const toolItem = {
  id: "tool",
  type: "dynamicToolCall",
  tool: "run_command",
  status: "completed",
  contentItems: [{ type: "inputText", text: "native tool result" }],
};
const project = (item) =>
  snapshot({ id: "t", turns: [{ id: "turn", items: [item] }] }, scope, { kind: "ordinary" });
assert.equal(project(toolItem).turns[0].items[0].preview, "native tool result");
const live = project({ ...toolItem, contentItems: [] });
update(live, "item/completed", { threadId: "t", turnId: "turn", item: toolItem }, scope);
assert.equal(live.turns[0].items[0].preview, "native tool result");
const long = project({ ...toolItem, contentItems: [{ type: "inputText", text: "界".repeat(500) }] })
  .turns[0].items[0];
assert.equal(long.preview, "界".repeat(341));
assert.equal(long.textBytes, 1500);
assert.equal(long.truncated, true);
assert.equal(long.bodyDetail.state, "available");
const media = project({
  ...toolItem,
  contentItems: [
    ...toolItem.contentItems,
    { type: "inputImage", imageUrl: "data:image/png;base64,AA==" },
  ],
}).turns[0].items[0];
assert.equal(media.preview, "native tool result");
assert.equal(media.bodyDetail.state, "inline");
assert.equal(media.mediaUnavailable, true);

// Shared GUI Messages must distinguish Core-authored continuation from user text.
const continuation = {
  id: "goal-turn",
  status: "completed",
  durationMs: 3500,
  goal: { goalId: "goal", origin: "continuation", sequence: 3, privateContext: "PRIVATE" },
  instructionSnapshot: "PRIVATE",
  configuration: { credentialRef: "PRIVATE" },
  items: [
    {
      id: "goal-input",
      type: "userMessage",
      content: [{ type: "text", text: "Continue the active goal" }],
    },
  ],
};
const continued = snapshot({ id: "t", turns: [continuation] }, scope, { kind: "ordinary" });
assert.deepEqual(continued.turns[0].goal, { origin: "continuation", sequence: 3 });
assert.equal(continued.turns[0].durationMs, 3500);
assert.ok(!JSON.stringify(continued.turns).includes("PRIVATE"));
const streamed = snapshot({ id: "t", turns: [] }, scope, { kind: "ordinary" });
for (const method of ["turn/started", "turn/completed"]) {
  update(streamed, method, { threadId: "t", turn: continuation }, scope);
  assert.deepEqual(streamed.turns[0].goal, continued.turns[0].goal);
}
assert.equal(project(continuation.items[0]).turns[0].goal, undefined);

// 整个生产入口运行在 DOM/加密传输边界替身上；通过真实按钮和消息分发复现延迟响应。
const { readFile } = await import("node:fs/promises");
const { createContext, runInContext } = await import("node:vm");
class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
  }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => [
      ...(child.tagName === tag.toUpperCase() ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  children = [];
  listeners = new Map();
  dataset = {};
  style = {};
  attributes = new Map();
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  value = "all";
  append(...children) {
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
  }
  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }
  click() {
    return this.listeners.get("click")?.();
  }
}
const elements = new Map();
const element = (id) => {
  if (!elements.has(id)) elements.set(id, new Element());
  return elements.get(id);
};
const calls = [],
  sockets = [],
  callChannel = new Map(),
  timers = new Map();
let timerId = 0,
  answerWork = true;
function channel() {
  const incoming = [],
    waiting = [];
  return {
    push(value) {
      if (waiting.length) {
        waiting.shift()({ value, done: false });
        return;
      }
      incoming.push(value);
    },
    next() {
      return incoming.length
        ? Promise.resolve({ value: incoming.shift(), done: false })
        : new Promise((resolve) => waiting.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
const row = {
  kind: "thread",
  threadId: "t",
  title: "Session",
  execution: { state: "idle" },
  attentionCount: 0,
  attentionComplete: true,
  attentionRefs: [],
  queue: { pendingCount: 0 },
};
const reply = (call, result) => callChannel.get(call).push({ id: call.id, result });
function transport() {
  const messages = channel();
  return {
    messages: () => messages,
    send(call) {
      calls.push(call);
      callChannel.set(call, messages);
      if (call.method === "hello")
        messages.push({
          event: "ready",
          hostId: "host",
          connectionId: "c",
          gatewayGeneration: "g",
          capabilities: ["observe", "submit", "interrupt", "answer"],
          grantRevision: 1,
          limits: { applicationMessageBytes: 262144 },
        });
      else if (call.method === "project.list")
        reply(call, { projects: [{ projectId: "p", name: "Project", connectionState: "online" }] });
      else if (call.method === "work.list" && answerWork)
        reply(call, { data: [row], complete: true, serviceGeneration: "s" });
      else if (call.method === "subscription.close") reply(call, {});
    },
  };
}
class Socket {
  constructor() {
    sockets.push(this);
    queueMicrotask(() => this.onopen?.());
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
let guiAPI;
const context = createContext({
  document: {
    hidden: false,
    body: new Element(),
    getElementById: element,
    createElement: (tag) => new Element(tag),
    addEventListener() {},
  },
  window: { addEventListener() {}, dispatchEvent() {} },
  Event,
  navigator: { onLine: true },
  browserDeviceName,
  BrowserState: class extends BrowserState {
    constructor(options) {
      super({ ...options, indexedDB: null, sessionStorage: null, channel: null });
    }
  },
  CommandState,
  SessionBodyReader,
  createRemoteWorkbench: (api) => {
    guiAPI = api;
    return { render() {} };
  },
  location: { hash: "#host=host", pathname: "/remote", protocol: "http:", host: "localhost" },
  history: { replaceState() {} },
  TextEncoder,
  URLSearchParams,
  URL,
  WebSocket: Socket,
  setTimeout(callback, delay) {
    const id = ++timerId;
    timers.set(id, {
      callback() {
        timers.delete(id);
        callback();
      },
      delay,
    });
    return id;
  },
  clearTimeout(id) {
    timers.delete(id);
  },
  setInterval: () => 1,
  clearInterval() {},
  acceptSessionMessage,
  createIdentity: async () => "identity",
  identityId: () => "peer",
  createRemoteWire: (socket) => ({
    wire: { close() {}, receive() {} },
    ready: new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(new Error("Host 暂不可用，请检查连接"));
    }),
  }),
  remoteLocator: (fragment) => ({ host: fragment.get("host"), room: fragment.get("room") }),
  publicLocator: (locator) =>
    new URLSearchParams(Object.entries(locator).filter(([, value]) => value)).toString(),
  secureChannel: async () => transport(),
});
const connectionSource = await readFile(
  new URL("../packages/remote-client/src/connection.mjs", import.meta.url),
  "utf8",
);
const source = await readFile(new URL("../renderer/remote-web/main.js", import.meta.url), "utf8");
runInContext(
  connectionSource
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace("export class RemoteConnection", "class RemoteConnection"),
  context,
);
runInContext(source.replace(/^import[\s\S]*?;\n/gm, ""), context);
await element("connect").click();
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};
const open = async () => {
  void guiAPI.open("p", "t");
  await flush();
};
const lastOpen = () => calls.filter((call) => call.method === "session.open").at(-1);
const closes = () => calls.filter((call) => call.method === "subscription.close");
const response = (subscriptionId) => ({
  ...baseline,
  subscriptionId,
  snapshot: {
    threadId: "t",
    status: "idle",
    configRevision: 1,
    turns: [],
    ownership: { kind: "ordinary" },
    queue: { pendingCount: 0 },
    attentionRefs: [],
    history: {},
  },
});
assert.equal(typeof guiAPI.open, "function", "生产 Remote 工作台必须提供权威会话入口");
await open();
const delayed = lastOpen();
element("session-close").click();
reply(delayed, response("abandoned"));
await flush();
assert.equal(element("session").hidden, true);
assert.equal(closes().length, 1, "closing a pending open must release its delayed subscription");
assert.equal(closes()[0].params.subscriptionId, "abandoned");
assert.equal(closes()[0].context.projectId, "p");

// 旧请求迟到不能释放随后打开的新订阅。
await open();
const oldOpen = lastOpen();
element("session-close").click();
await open();
const newOpen = lastOpen();
reply(newOpen, response("replacement"));
await flush();
reply(oldOpen, response("old"));
await flush();
assert.equal(element("session").hidden, false);
assert.equal(closes().at(-1).params.subscriptionId, "old");
assert.equal(
  closes().some((call) => call.params.subscriptionId === "replacement"),
  false,
);
element("session-close").click();
await flush();
assert.equal(closes().at(-1).params.subscriptionId, "replacement");

// 触发生产请求的真实计时器回调；计时只由测试时钟推进，不改请求实现。
const requestTimers = () => [...timers.values()].filter((timer) => timer.delay === 15000);
const pendingTimer = () => {
  assert.equal(requestTimers().length, 1);
  return requestTimers()[0];
};
await open();
const timedOpen = lastOpen();
const timedSocket = sockets.at(-1);
const timeout = pendingTimer();
assert.equal(timeout.delay, 15000);
element("session-close").click();
timeout.callback();
await flush();
assert.equal(
  timedSocket.closed,
  true,
  "timed-out allocating request must disconnect its originating transport",
);
reply(timedOpen, response("after-timeout"));
await flush();
assert.equal(element("session").hidden, true);
assert.equal(element("session-content").children.length, 0);
assert.equal(element("host").textContent, "");

// 已排队的旧连接超时回调在重连后执行，只能关闭旧连接。
assert.equal(requestTimers().length, 0);
await element("connect").click();
await open();
const oldTimer = pendingTimer();
const originatingSocket = sockets.at(-1);
await element("connect").click();
const replacementSocket = sockets.at(-1);
reply(lastOpen(), response("reconnected"));
await flush();
oldTimer.callback();
await flush();
assert.equal(originatingSocket.closed, true);
assert.notEqual(replacementSocket.closed, true);
assert.equal(element("session").hidden, false);
assert.equal(element("host").textContent, "host");

// 普通只读请求超时保留连接与已打开的详情。
answerWork = false;
element("work-refresh").click();
const readTimer = pendingTimer();
readTimer.callback();
await flush();
assert.notEqual(replacementSocket.closed, true);
assert.equal(element("session").hidden, false);
assert.match(element("work-error").textContent, /读取超时/);
assert.equal(requestTimers().length, 0);

// 未主动关闭的打开请求超时也清除正文，并显示连接失效。
element("session-refresh").click();
pendingTimer().callback();
await flush();
assert.equal(replacementSocket.closed, true);
assert.equal(element("session-content").children.length, 0);
assert.match(element("session-error").textContent, /Host 已断开/);
assert.equal(requestTimers().length, 0);
// 生产按钮使用同一 commandId 核对未知发送；确认前保留草稿，明确受理后才清空。
answerWork = true;
await element("connect").click();
reply(lastOpen(), response("commands"));
await flush();
const draft = element("session-draft");
draft.value = "保留这条草稿";
draft.listeners.get("input")();
element("session-send").click();
await flush();
const sent = calls.filter((call) => call.method === "session.send").at(-1);
assert.match(sent.commandId, /^[a-f0-9-]{36}$/);
assert.equal(sent.params.text, "保留这条草稿");
assert.equal(sent.params.expectedConfigRevision, 1);
assert.equal(sent.context.grantRevision, 1);
pendingTimer().callback();
await flush();
assert.equal(draft.value, "保留这条草稿");
assert.equal(element("session-send").disabled, true);
assert.match(element("send-command-state").textContent, /结果未知/);
element("send-query").click();
const query = calls.filter((call) => call.method === "command.read").at(-1);
assert.equal(query.params.commandId, sent.commandId);
reply(query, {
  commandId: sent.commandId,
  admissionState: "accepted",
  threadId: "t",
  turnId: "turn",
  nativeRequestId: "native",
});
await flush();
assert.equal(draft.value, "");
assert.equal(calls.filter((call) => call.method === "session.send").length, 1);
draft.value = "冲突后的草稿";
draft.listeners.get("input")();
element("session-send").click();
await flush();
const conflict = calls.filter((call) => call.method === "session.send").at(-1);
assert.notEqual(conflict.commandId, sent.commandId);
callChannel.get(conflict).push({
  id: conflict.id,
  error: {
    code: "COMMAND_CONFLICT",
    message: "original semantics differ",
    submissionUnknown: false,
    commandId: conflict.commandId,
  },
});
await flush();
assert.equal(draft.value, "冲突后的草稿");
assert.match(element("send-command-state").textContent, /COMMAND_CONFLICT/);
assert.equal(requestTimers().length, 0);
// 未确认 create 跨重连只核对原 commandId；notFound 不释放重复创建按钮。
element("session-create").click();
await flush();
const create = calls.filter((call) => call.method === "session.create").at(-1);
assert.match(create.commandId, /^[a-f0-9-]{36}$/);
pendingTimer().callback();
await flush();
assert.match(element("create-command-state").textContent, /结果未知/);
await element("connect").click();
await flush();
const recovery = calls.filter((call) => call.method === "command.read").at(-1);
assert.equal(recovery.params.commandId, create.commandId);
assert.equal(calls.filter((call) => call.method === "session.create").length, 1);
reply(recovery, {
  commandId: create.commandId,
  admissionState: "notFound",
  submissionUnknown: true,
});
reply(lastOpen(), response("command-reconnect"));
await flush();
assert.equal(element("session-create").disabled, true);
assert.match(element("create-command-state").textContent, /不能据此认定未执行/);
assert.equal(draft.value, "冲突后的草稿");
assert.equal(requestTimers().length, 0);
// Stop 固定可见的 A；受理不是结算，换成 B 或窗口缺失均不能声称 A 已停止。
async function stopSnapshot(turns, activeTurnId) {
  element("session-refresh").click();
  reply(lastOpen(), {
    ...response("stop-view"),
    snapshot: {
      ...response("stop-view").snapshot,
      status: activeTurnId ? "active" : "idle",
      activeTurnId,
      turns,
    },
  });
  await flush();
}
await stopSnapshot([{ id: "A", status: "inProgress", items: [] }], "A");
assert.equal(element("turn-stop").disabled, false);
element("turn-stop").click();
await flush();
const stop = calls.filter((c) => c.method === "turn.stop").at(-1);
assert.equal(stop.params.expectedTurnId, "A");
assert.equal(stop.params.threadId, "t");
reply(stop, { commandId: stop.commandId, admissionState: "accepted", operationId: "journal" });
await flush();
assert.match(element("stop-command-state").textContent, /已受理/);
assert.match(element("stop-command-state").textContent, /等待原 Turn 结算/);
assert.equal(element("turn-stop").disabled, true);
assert.equal(draft.value, "冲突后的草稿");
await stopSnapshot([{ id: "B", status: "inProgress", items: [] }], "B");
assert.match(element("stop-command-state").textContent, /原 Turn 状态不可用/);
assert.doesNotMatch(element("stop-command-state").textContent, /观察到原 Turn 终态/);
await stopSnapshot(
  [
    { id: "A", status: "interrupted", items: [] },
    { id: "B", status: "inProgress", items: [] },
  ],
  "B",
);
assert.match(element("stop-command-state").textContent, /观察到原 Turn 终态：interrupted/);
element("turn-stop").click();
await flush();
const stopB = calls.filter((c) => c.method === "turn.stop").at(-1);
assert.equal(stopB.params.expectedTurnId, "B");
pendingTimer().callback();
await flush();
await stopSnapshot([{ id: "B", status: "completed", items: [] }], null);
assert.match(element("stop-command-state").textContent, /结果未知/);
assert.match(element("stop-command-state").textContent, /不证明本命令导致/);
assert.equal(calls.filter((c) => c.method === "turn.stop").length, 2);
assert.equal(draft.value, "冲突后的草稿");
console.log(
  "Session projection, timeout cleanup, identity, production send draft/unknown/query/conflict contracts passed",
);

const reviewState = new CommandState(() => "review-command");
const originalAnswers = { first: "original", second: "界" };
const reviewed = reviewState.begin("review", "interaction.respond", {
  threadId: "t",
  answers: originalAnswers,
});
originalAnswers.first = "changed after begin";
assert.equal(
  reviewed.params.answers.first,
  "original",
  "submitted questions retain the reviewed nested answer snapshot",
);

row.attentionRefs = [
  {
    kind: "approval",
    threadId: "t",
    turnId: "A",
    interactionId: "approval-1",
    summary: "Review original",
  },
];
row.attentionCount = 1;
element("work-refresh").click();
await flush();
function buttonDeep(node, label) {
  if (node.textContent === label) return node;
  for (const child of node.children) {
    const result = buttonDeep(child, label);
    if (result) return result;
  }
}
await open();
const attentionBaseline = response("attention-baseline");
attentionBaseline.snapshot.attentionRefs = row.attentionRefs;
reply(lastOpen(), attentionBaseline);
await flush();
const reviewButton = buttonDeep(element("session-attention"), "审阅待处理事项");
assert.ok(reviewButton, "production Session must open authoritative attention detail");
reviewButton.click();
await flush();
const lastAttention = () => calls.filter((c) => c.method === "attention.read").at(-1);
assert.deepEqual(JSON.parse(JSON.stringify(lastAttention().params)), {
  threadId: "t",
  turnId: "A",
  interactionId: "approval-1",
});

const reviewBody = JSON.stringify({
  tool: "write_file",
  effectiveArguments: { path: "original.txt", content: "payload" },
  effectivePermissions: { readOnly: false },
  questions: [],
});
const reviewPage = (extra = {}) => ({
  projectId: "p",
  serviceGeneration: "s",
  threadId: "t",
  turnId: "A",
  interactionId: "approval-1",
  kind: "approval",
  status: "pending",
  expiresAt: Math.floor(Date.now() / 1000) + 600,
  argumentsDigest: "d".repeat(64),
  review: {
    encoding: "json-utf8",
    offset: 0,
    totalBytes: Buffer.byteLength(reviewBody),
    chunk: reviewBody.slice(0, 20),
  },
  complete: false,
  nextCursor: "next",
  reviewToken: null,
  ...extra,
});
reply(lastAttention(), reviewPage());
await flush();
assert.equal(element("attention-allow").disabled, true);
assert.equal(element("attention-deny").disabled, false);
assert.match(element("attention-status").textContent, /审阅不完整/);
assert.equal(element("session").hidden, false, "review must preserve the active Session");
element("attention-more").click();
await flush();
assert.equal(lastAttention().params.cursor, "next");
reply(
  lastAttention(),
  reviewPage({
    review: {
      encoding: "json-utf8",
      offset: 20,
      totalBytes: Buffer.byteLength(reviewBody),
      chunk: reviewBody.slice(20),
    },
    complete: true,
    nextCursor: null,
    reviewToken: "proof",
  }),
);
await flush();
assert.equal(element("attention-allow").disabled, false);
assert.match(element("attention-body").textContent, /original.txt/);
element("attention-allow").click();
await flush();
const responseCall = calls.filter((c) => c.method === "interaction.respond").at(-1);
assert.equal(responseCall.params.turnId, "A");
assert.equal(responseCall.params.interactionId, "approval-1");
assert.equal(responseCall.params.argumentsDigest, "d".repeat(64));
assert.equal(responseCall.params.reviewToken, "proof");
reply(responseCall, {
  commandId: responseCall.commandId,
  admissionState: "unknown",
  submissionUnknown: true,
  observedState: { status: "answered", provesCommandAdmission: false },
});
await flush();
assert.match(element("attention-command-state").textContent, /结果未知/);
assert.match(element("attention-command-state").textContent, /独立观察原交互：answered/);
assert.match(element("attention-command-state").textContent, /不证明本命令/);
assert.equal(element("attention-allow").disabled, true);
assert.equal(element("attention-deny").disabled, true);
element("attention-query").click();
await flush();
const queryInteraction = calls.filter((c) => c.method === "command.read").at(-1);
assert.equal(queryInteraction.params.commandId, responseCall.commandId);
reply(queryInteraction, {
  commandId: responseCall.commandId,
  admissionState: "unknown",
  observedState: { status: "answered", provesCommandAdmission: false },
});
await flush();
assert.equal(calls.filter((c) => c.method === "interaction.respond").length, 1);

// 切换审阅后迟到的正文不能覆盖新目标。
element("attention-close").click();
row.attentionRefs = [
  {
    kind: "syncQuestion",
    threadId: "t",
    turnId: "B",
    interactionId: "question-1",
    summary: "Core question",
  },
];
await open();
const questionBaseline = response("question-baseline");
questionBaseline.snapshot.attentionRefs = row.attentionRefs;
reply(lastOpen(), questionBaseline);
await flush();
buttonDeep(element("session-attention"), "审阅待处理事项").click();
await flush();
const delayedReview = lastAttention();
element("attention-close").click();
buttonDeep(element("session-attention"), "审阅待处理事项").click();
await flush();
const freshReview = lastAttention();
reply(delayedReview, reviewPage());
await flush();
assert.equal(element("attention-body").textContent, "");
const questionsBody = JSON.stringify({
  tool: null,
  questions: [
    { id: "choice", title: "Actual Core choices", options: ["A", "B"], allowFreeText: false },
    { id: "__proto__", title: "Actual Core free text", options: [], allowFreeText: true },
  ],
});
reply(
  freshReview,
  reviewPage({
    turnId: "B",
    interactionId: "question-1",
    kind: "syncQuestion",
    argumentsDigest: null,
    review: {
      encoding: "json-utf8",
      offset: 0,
      totalBytes: Buffer.byteLength(questionsBody),
      chunk: questionsBody,
    },
    complete: true,
    nextCursor: null,
    reviewToken: "question-proof",
  }),
);
await flush();
const fields = element("attention-questions").children.map((label) => label.children.at(-1));
assert.equal(fields[0].dataset.questionId, "choice");
assert.deepEqual(
  fields[0].children.slice(1).map((option) => option.value),
  ["A", "B"],
);
fields[0].value = "A";
fields[0].listeners.get("change")();
fields[1].value = "界".repeat(1365) + "ab";
fields[1].listeners.get("input")();
assert.equal(element("attention-answer").disabled, true);
fields[1].value = "界".repeat(1365) + "a";
fields[1].listeners.get("input")();
assert.equal(element("attention-answer").disabled, false);
element("attention-answer").click();
await flush();
const questionCall = calls.filter((c) => c.method === "interaction.respond").at(-1);
fields[1].value = "modified later";
fields[1].listeners.get("input")();
assert.equal(questionCall.params.answers.__proto__, "界".repeat(1365) + "a");
assert.equal(questionCall.params.turnId, "B");
assert.equal(questionCall.params.interactionId, "question-1");
reply(questionCall, {
  commandId: questionCall.commandId,
  admissionState: "accepted",
  observedState: { status: "answered", provesCommandAdmission: false },
});
await flush();
assert.match(element("attention-command-state").textContent, /已受理（不代表执行完成）/);
console.log(
  "Production RC07 DOM: original-target review, incomplete pages, unknown recovery, Core questions, UTF-8 limits and deep command snapshot passed",
);
