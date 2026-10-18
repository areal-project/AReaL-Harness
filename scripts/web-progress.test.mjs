import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

// 最小 DOM 替身用于验证客户端投影、计时和控制请求；不替代浏览器布局验收。
class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.dataset = {};
    this.textContent = "";
    this.value = "";
    this.attributes = new Map();
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => (enabled ? classes.add(name) : classes.delete(name)),
    };
    this.scrollTop = this.scrollHeight = this.clientHeight = 0;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  append(...children) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children) {
    this.children = children;
    for (const child of children) child.parent = this;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  querySelector(selector) {
    return (
      this.children.find(
        (child) =>
          child.tag === selector ||
          (selector.startsWith(".") && child.className?.split(" ").includes(selector.slice(1))),
      ) ?? null
    );
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(selector === "details[open]" && child.tag === "details" && child.open ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}
function client(options = {}) {
  let now = 1000;
  const elements = new Map(),
    requests = [];
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get("composer-context").append(new Element("span"));
  get("group-start").append(new Element("button"));
  get("refresh").append(new Element("svg"));
  get("interrupt").append(new Element("span"));
  const location = new URL(options.href ?? "http://localhost/ui");
  const startup = [];
  const context = vm.createContext({
    document: {
      getElementById: get,
      createElement: (tag) => new Element(tag),
      createElementNS: (_, tag) => new Element(tag),
      documentElement: new Element("html"),
      body: new Element("body"),
      addEventListener: () => {},
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    localStorage: { getItem: () => null },
    crypto: { randomUUID },
    location,
    history: {
      replaceState: (_, __, url) => {
        location.href = String(url);
        startup.push({ type: "history", url: location.href });
      },
    },
    AbortSignal,
    confirm: options.confirm ?? (() => true),
    fetch: async (url, init) => {
      startup.push({ type: "fetch", url, init, page: location.href });
      return options.fetch ? options.fetch(url, init) : { ok: true };
    },
    URL,
    WebSocket: class {
      constructor(url) {
        startup.push({ type: "socket", url: String(url) });
      }
      send(request) {
        requests.push(JSON.parse(request));
      }
    },
    requestAnimationFrame: (callback) => callback(),
    setInterval: () => 0,
    setTimeout: options.setTimeout ?? (() => 0),
    clearTimeout: () => {},
    Date: class extends Date {
      static now() {
        return now;
      }
    },
  });
  const run = (code) => vm.runInContext(code, context);
  run(readFileSync(new URL("../clients/web/app.js", import.meta.url), "utf8"));
  run(
    `connected = true; thread = {id:"thread",cwd:"/workspace",turns:[{id:"turn",status:"inProgress",items:[{id:"answer",type:"agentMessage",text:""}]}]}; render();`,
  );
  return {
    startup,
    location,
    get,
    run,
    requests,
    advance: (seconds) => {
      now += seconds * 1000;
      run("renderProgress()");
    },
  };
}

test("sidebar archives a confirmed session, keeps failed archives visible, and switches selection", async () => {
  const c = client();
  c.run('thread = {id:"first",cwd:"/workspace",turns:[]}; render()');
  const listing = c.run("list()");
  const listRequest = c.requests.at(-1);
  c.run(
    `pending.get(${listRequest.id}).resolve({data:[{id:"first",preview:"First"},{id:"second",preview:"Second"},{id:"archived",desktop:{archived:true}}],nextCursor:null})`,
  );
  await listing;
  assert.equal(c.get("threads").children.length, 2);
  const rows = c.get("threads").children;
  assert.equal(
    rows[0].querySelector(".thread-remove").getAttribute("aria-label"),
    "删除会话：First",
  );

  const failed = rows[1].querySelector(".thread-remove").onclick();
  const failedRequest = c.requests.at(-1);
  assert.equal(failedRequest.method, "areal/thread/archive");
  assert.equal(failedRequest.params.threadId, "second");
  assert.equal(rows[1].querySelector(".thread-remove").disabled, true);
  c.run(`pending.get(${failedRequest.id}).reject(Error("active goal"))`);
  await failed;
  assert.equal(c.get("threads").children.length, 2);
  assert.match(c.get("notice").textContent, /active goal/);

  const archive = rows[0].querySelector(".thread-remove").onclick();
  const request = c.requests.at(-1);
  c.run(`pending.get(${request.id}).resolve({archived:true})`);
  await Promise.resolve();
  const resume = c.requests.at(-1);
  assert.equal(resume.method, "areal/thread/observe");
  assert.equal(resume.params.threadId, "second");
  c.run(`pending.get(${resume.id}).resolve({thread:{id:"second",cwd:"/workspace",turns:[]}})`);
  await archive;
  assert.equal(c.run("thread.id"), "second");
  assert.equal(c.get("threads").children.length, 1);
  assert.equal(c.get("threads").children[0].dataset.id, "second");
});

test("cancelled archive does not call Core", async () => {
  const c = client({ confirm: () => false });
  await c.run('archiveSession("thread", "Draft")');
  assert.equal(c.requests.length, 0);
});

test("another client's archive clears the selected session", async () => {
  const c = client();
  const listing = c.run("list()");
  const request = c.requests.at(-1);
  c.run(
    `pending.get(${request.id}).resolve({data:[{id:"thread",preview:"Current"}],nextCursor:null})`,
  );
  await listing;
  emit(c, "areal/thread/archived", { threadId: "thread" });
  assert.equal(c.run("thread"), null);
  assert.equal(c.get("threads").children.length, 0);
  assert.equal(c.get("threads-empty").hidden, false);
});
function emit(client, method, params) {
  client.run(
    `event(${JSON.stringify({ method, params: { threadId: "thread", turnId: "turn", ...params } })})`,
  );
}

test("waiting, thinking and body stay separate; refresh replaces the baseline and discard removes it", () => {
  const c = client();
  assert.match(c.get("progress").textContent, /正在等待模型回复/);
  assert.equal(c.get("history").children.length, 0);
  c.advance(31);
  assert.match(c.get("progress").textContent, /仍未收到正文/);
  emit(c, "item/started", {
    item: { id: "reason", type: "reasoning", summary: [], content: [""] },
  });
  emit(c, "item/reasoning/textDelta", { itemId: "reason", contentIndex: 0, delta: "检查依赖" });
  assert.match(c.get("progress").textContent, /已收到模型思考/);
  const card = c.get("history").children[0];
  assert.equal(card.children[1].textContent, "检查依赖");
  card.open = true;
  c.run('thread.turns[0].items[1].content = ["检查依赖"]; render()');
  emit(c, "item/reasoning/textDelta", { itemId: "reason", contentIndex: 0, delta: "完成" });
  assert.equal(c.get("history").children[0].children[1].textContent, "检查依赖完成");
  assert.equal(c.get("history").children[0].open, true);
  emit(c, "item/agentMessage/delta", { itemId: "answer", delta: "正文" });
  assert.doesNotMatch(c.get("progress").textContent, /仍未收到正文/);
  assert.equal(c.get("history").children[0].children[1].textContent, "正文");
  emit(c, "areal/model/completionDiscarded", { itemIds: ["answer", "reason"] });
  assert.equal(c.get("history").children.length, 0);
});

test("refresh and interrupt expose pending states and tolerate switching threads", async () => {
  const c = client();
  const refresh = c.run("reload()");
  assert.equal(c.get("refresh").getAttribute("aria-label"), "刷新中…");
  assert.equal(c.get("refresh").disabled, true);
  assert.equal(c.get("refresh").getAttribute("aria-busy"), "true");
  assert.equal(c.get("refresh").children[0].tag, "svg");
  const request = c.requests.at(-1);
  c.run(
    `thread = {id:"other",turns:[]}; pending.get(${request.id}).resolve({thread:{id:"thread",turns:[]}})`,
  );
  await refresh;
  assert.equal(c.run("thread.id"), "other");
  assert.equal(c.get("refresh").disabled, false);
  c.run('thread = {id:"thread",turns:[{id:"turn",status:"inProgress",items:[]}]}; render()');
  const stop = c.get("interrupt").onclick();
  assert.equal(c.get("interrupt").disabled, true);
  assert.equal(c.get("interrupt").getAttribute("aria-label"), "正在停止…");
  assert.equal(c.get("interrupt").children[0].tag, "span");
  assert.match(c.get("progress").textContent, /已请求停止/);
  const interrupt = c.requests.at(-1);
  assert.equal(interrupt.method, "turn/interrupt");
  await c.get("interrupt").onclick();
  assert.equal(c.requests.at(-1).id, interrupt.id);
  c.run(`pending.get(${interrupt.id}).reject(Error("connection lost"))`);
  await stop;
  assert.equal(c.get("interrupt").disabled, false);
  emit(c, "turn/completed", { turn: { id: "turn", status: "interrupted", items: [] } });
  assert.equal(c.get("progress").hidden, true);
  assert.equal(c.get("interrupt").disabled, true);
  c.run("connected = false; render()");
  assert.equal(c.get("refresh").disabled, true);
});

test("a successful interrupt clears the stopping label when the terminal event arrives", async () => {
  const c = client();
  const stopping = c.get("interrupt").onclick();
  const interrupt = c.requests.at(-1);
  const turn = { id: "turn", status: "interrupted", items: [] };
  emit(c, "turn/completed", { turn });
  assert.equal(c.get("interrupt").getAttribute("aria-label"), "停止执行");
  assert.equal(c.get("progress").hidden, true);
  c.run(`pending.get(${interrupt.id}).resolve({})`);
  await Promise.resolve();
  const refresh = c.requests.at(-1);
  assert.equal(refresh.method, "areal/thread/observe");
  c.run(
    `pending.get(${refresh.id}).resolve({thread:{id:"thread",turns:[${JSON.stringify(turn)}]}})`,
  );
  await stopping;
  assert.equal(c.get("interrupt").disabled, true);
});

test("Responses summary deltas grow indexed parts and show progress without body text", () => {
  const c = client();
  emit(c, "item/started", {
    item: { id: "response", type: "reasoning", summary: [], content: [] },
  });
  emit(c, "item/reasoning/summaryTextDelta", {
    itemId: "response",
    summaryIndex: 1,
    delta: "摘要",
  });
  emit(c, "item/reasoning/summaryTextDelta", {
    itemId: "response",
    summaryIndex: 1,
    delta: "完成",
  });
  assert.match(c.get("progress").textContent, /已收到模型思考/);
  assert.equal(c.get("history").children[0].children[0].children[0].textContent, "思考摘要");
  assert.equal(c.get("history").children[0].children[1].textContent, "\n摘要完成");
  emit(c, "item/reasoning/textDelta", { itemId: "response", contentIndex: 0, delta: "思考文本" });
  assert.equal(c.get("history").children[0].children[1].textContent, "\n摘要完成\n思考文本");
});

test("stop pauses an active goal during reasoning and between turns", async () => {
  for (const status of ["inProgress", "completed"]) {
    const c = client();
    const goal = {
      id: "goal",
      status: "active",
      objective: "Inspect",
      maxTurns: 10,
      usage: { tokensUsed: 1, timeUsedSeconds: 1, turnsStarted: 1, accountingComplete: true },
    };
    c.run(`thread.turns[0].status = ${JSON.stringify(status)}; goalsSupported = true`);
    emit(c, "areal/goal/updated", { goal, revision: 1, eventSequence: 1 });
    assert.equal(c.get("interrupt").disabled, false);
    const stopping = c.get("interrupt").onclick();
    const pause = c.requests.at(-1);
    assert.equal(pause.method, "areal/goal/pause");
    assert.equal(pause.params.goalId, "goal");
    assert.equal(c.get("interrupt").disabled, true);
    const count = c.requests.length;
    await c.get("interrupt").onclick();
    assert.equal(c.requests.length, count);
    const paused = { ...goal, status: "paused" };
    c.run(
      `pending.get(${pause.id}).resolve(${JSON.stringify({ threadId: "thread", goal: paused, revision: 2, eventSequence: 2 })})`,
    );
    for (let i = 0; i < 4; i++) await Promise.resolve();
    const refresh = c.requests.at(-1);
    assert.equal(refresh.method, "areal/thread/observe");
    const snapshot = {
      id: "thread",
      turns: [{ id: "turn", status: "interrupted", items: [] }],
      goals: { goal: paused, revision: 2, eventSequence: 2 },
    };
    c.run(`pending.get(${refresh.id}).resolve({thread:${JSON.stringify(snapshot)}})`);
    await stopping;
    assert.equal(c.get("interrupt").disabled, true);
    assert.equal(c.get("interrupt").getAttribute("aria-label"), "停止执行");
    assert.equal(c.get("progress").hidden, true);
  }
});

test("approval shows effective arguments, sends exact digest, and resolves across clients", async () => {
  const c = client();
  const interaction = {
    requestId: "approval",
    threadId: "thread",
    turnId: "turn",
    kind: "approval",
    status: "pending",
    tool: "run_command",
    argumentsDigest: "digest",
    effectiveArguments: { argv: ["echo", "<script>fixture</script>"] },
    effectivePermissions: { rememberAllowed: true },
  };
  emit(c, "areal/interaction/requested", { revision: 1, interaction });
  const panel = c.get("permission-request");
  assert.equal(panel.hidden, false);
  assert.match(panel.children[1].textContent, /<script>fixture/);
  const buttons = panel.children.filter((n) => n.tag === "button");
  assert.equal(buttons.length, 4);
  const submitted = buttons[1].onclick();
  const request = c.requests.at(-1);
  assert.equal(request.method, "areal/interaction/respond");
  assert.deepEqual(request.params, {
    threadId: "thread",
    turnId: "turn",
    requestId: "approval",
    decision: "allowSession",
    argumentsDigest: "digest",
  });
  emit(c, "areal/interaction/resolved", {
    revision: 2,
    interaction: { ...interaction, status: "answered" },
  });
  assert.equal(panel.hidden, true);
  c.run(`pending.get(${request.id}).resolve({decision:"allowSession", argumentsDigest:"digest"})`);
  await Promise.resolve();
  const refresh = c.requests.at(-1);
  c.run(`pending.get(${refresh.id}).resolve({thread:{id:"thread",turns:[]}})`);
  await submitted;
  emit(c, "areal/interaction/requested", {
    revision: 3,
    interaction: {
      ...interaction,
      requestId: "forced",
      effectivePermissions: { rememberAllowed: false },
    },
  });
  assert.equal(panel.children.filter((n) => n.tag === "button").length, 2);
});

test("Goal waiting states identify Inbox and worker waits", () => {
  const c = client();
  const goal = {
    id: "goal",
    status: "active",
    objective: "Inspect",
    maxTurns: 10,
    waitingForInput: true,
    usage: { tokensUsed: 1, timeUsedSeconds: 1, turnsStarted: 1, accountingComplete: true },
  };
  emit(c, "areal/goal/updated", { goal, revision: 1, eventSequence: 1 });
  assert.match(c.get("goal-status").textContent, /等待收件箱回复/);
  emit(c, "areal/goal/updated", {
    goal: { ...goal, waitingForInput: false, waitingForAgents: true },
    revision: 2,
    eventSequence: 2,
  });
  assert.match(c.get("goal-status").textContent, /等待协作任务/);
});

test("Task list refresh retains a selected later-page task and ignores stale snapshots", async () => {
  const c = client();
  const selected = {
    id: "selected",
    revision: 5,
    channelSequence: 0,
    objective: "Inspect",
    mode: "background",
    paused: true,
    cancelled: false,
    runs: [],
  };
  c.run(
    `tasksSupported = true; selectedTaskId = "selected"; taskRows.set("selected", ${JSON.stringify(selected)});`,
  );
  const refreshing = c.run("listTasks()");
  const request = c.requests.at(-1);
  assert.equal(request.method, "areal/task/list");
  c.run(`pending.get(${request.id}).resolve({data:[],nextCursor:"later"})`);
  await refreshing;
  assert.equal(c.run('taskRows.get("selected").revision'), 5);
  assert.equal(
    c.get("task-detail").children.find((node) => node.tag === "div").children[0].textContent,
    "恢复任务",
  );
  c.run(`receiveTask(${JSON.stringify({ ...selected, revision: 4, paused: false })})`);
  assert.equal(c.run('taskRows.get("selected").paused'), true);
  const refreshAgain = c.run("listTasks()");
  const next = c.requests.at(-1);
  c.run(
    `pending.get(${next.id}).resolve({data:[${JSON.stringify({ ...selected, revision: 3, paused: false })}],nextCursor:null})`,
  );
  await refreshAgain;
  assert.equal(c.run('taskRows.get("selected").revision'), 5);
});

test("Inbox survives refresh and retries the same reply without borrowing the current Thread", async () => {
  const c = client();
  c.get("inbox-open").append(new Element("span"));
  const row = {
    taskId: "other-task",
    objective: "Inspect another session",
    message: {
      id: "question",
      runId: "run",
      questions: [{ id: "choice", title: "Choose", options: ["A", "B"], allowFreeText: false }],
    },
  };
  c.run(
    `tasksSupported = true; inboxRows.set("other-task/question", ${JSON.stringify(row)}); renderInbox();`,
  );
  const form = c.get("inbox-list").children[0];
  const select = form.children.find((node) => node.tag === "select");
  select.value = "B";
  select.oninput();
  const refresh = c.run("loadInbox()");
  const listing = c.requests.at(-1);
  c.run(`pending.get(${listing.id}).resolve({data:[${JSON.stringify(row)}],nextCursor:null})`);
  await refresh;
  assert.equal(c.get("inbox-list").children[0], form);
  assert.equal(select.value, "B");
  const firstSend = form.onsubmit({ preventDefault() {} });
  const first = c.requests.at(-1);
  assert.equal(first.method, "areal/channel/reply");
  assert.equal(first.params.taskId, "other-task");
  assert.equal(first.params.runId, "run");
  assert.equal(first.params.threadId, undefined);
  assert.equal(first.params.answers.choice, "B");
  c.run(`pending.get(${first.id}).reject(Error("timeout; acceptance unknown"))`);
  await firstSend;
  const retrySend = form.onsubmit({ preventDefault() {} });
  const retry = c.requests.at(-1);
  assert.deepEqual(retry.params, first.params);
  c.run(`pending.get(${retry.id}).resolve({accepted:true})`);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  const after = c.requests.at(-1);
  assert.equal(after.method, "areal/inbox/list");
  c.run(`pending.get(${after.id}).resolve({data:[],nextCursor:null})`);
  await retrySend;
  assert.match(c.get("inbox-list").children[0].textContent, /没有待回答/);
});

test("automatic login clears the fragment before exchange and connects only after success", async () => {
  let resolveExchange;
  const exchange = new Promise((resolve) => {
    resolveExchange = resolve;
  });
  const c = client({
    href: "http://127.0.0.1:4500/ui#bootstrap=one-use-code",
    fetch: () => exchange,
  });
  assert.deepEqual(
    c.startup.map((event) => event.type),
    ["history", "fetch"],
  );
  assert.equal(c.location.href, "http://127.0.0.1:4500/ui");
  const request = c.startup[1];
  assert.equal(request.url, "/areal/auth/bootstrap/exchange");
  assert.equal(request.page, c.location.href);
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body), { code: "one-use-code" });
  assert.equal(request.init.redirect, "error");
  assert.equal(request.init.cache, "no-store");
  assert.equal(request.init.credentials, "same-origin");
  resolveExchange({ ok: true });
  await new Promise(setImmediate);
  assert.deepEqual(
    c.startup.map((event) => event.type),
    ["history", "fetch", "socket"],
  );
  assert.equal(c.get("settings-dialog").open, undefined);
});

test("rejected or unavailable automatic login exposes a manual fallback without retaining the code", async () => {
  for (const fetch of [
    async () => ({ ok: false }),
    async () => {
      throw Error("private response");
    },
  ]) {
    const c = client({ href: "http://127.0.0.1:4500/ui#bootstrap=expired-secret", fetch });
    await new Promise(setImmediate);
    assert.equal(c.location.hash, "");
    assert.equal(c.get("settings-dialog").open, true);
    assert.match(c.get("login-error").textContent, /重新运行 areal web/);
    assert.doesNotMatch(c.get("login-error").textContent, /expired-secret|private response/);
    assert(!c.startup.some((event) => event.type === "socket"));
  }
});

test("ordinary visits and reloads connect with the cookie without minting credentials", () => {
  const c = client();
  assert.deepEqual(
    c.startup.map((event) => event.type),
    ["socket"],
  );
});

test("unified subtasks keep verification and delivery distinct and ignore another task's late list", async () => {
  const c = client();
  c.run("executionsSupported = true");
  const listing = c.run("listExecutions()");
  const request = c.requests.at(-1);
  assert.equal(request.method, "areal/execution/list");
  assert.equal(request.params.parentThreadId, "thread");
  const execution = {
    executionId: "execution-1",
    parentThreadId: "thread",
    title: "修改解析器",
    status: "completed",
    settled: true,
    resourcesReleased: true,
    text: "候选已验证",
    error: null,
    verification: { status: "passed", kind: "trusted" },
    delivery: { status: "conflict" },
  };
  c.run(
    `pending.get(${request.id}).resolve(${JSON.stringify({ data: [execution], nextOffset: null })})`,
  );
  await listing;
  const text = c
    .get("groups")
    .children[0].children.map((child) => child.textContent)
    .join(" ");
  assert.match(text, /检查通过/);
  assert.match(text, /交付存在冲突/);
  assert.doesNotMatch(text, /改动已应用/);
  const cancelled = c.run(
    `executionCard(${JSON.stringify({ ...execution, status: "cancelled", delivery: { status: "cancelled" } })}, "thread", groupObservation)`,
  );
  const cancelledText = cancelled.children.map((child) => child.textContent).join(" ");
  assert.match(cancelledText, /已取消.*交付已取消/);
  assert.doesNotMatch(cancelledText, /改动已应用|等待结果|停止子任务/);
  const stale = c.run("listExecutions()");
  const staleRequest = c.requests.at(-1);
  c.run('thread = {id:"another",turns:[]}');
  c.run(
    `pending.get(${staleRequest.id}).resolve(${JSON.stringify({ data: [execution], nextOffset: null })})`,
  );
  await stale;
  assert.equal(c.get("groups").children.length, 0);
});

test("subtask cancellation stays bound to its owner and an uncertain reply is not retried", async () => {
  const c = client();
  c.run("executionsSupported = true");
  const listing = c.run("listExecutions()");
  const request = c.requests.at(-1);
  const execution = {
    executionId: "execution-2",
    parentThreadId: "thread",
    status: "running",
    settled: false,
    resourcesReleased: false,
    text: "",
    error: null,
    verification: { status: "notRun", kind: "none" },
    delivery: { status: "pending" },
  };
  c.run(
    `pending.get(${request.id}).resolve(${JSON.stringify({ data: [execution], nextOffset: null })})`,
  );
  await listing;
  const cancel = c
    .get("groups")
    .children[0].children.find((child) => child.textContent === "停止子任务");
  c.run('thread = {id:"another",turns:[]}');
  const stopping = cancel.onclick();
  const stopRequest = c.requests.at(-1);
  assert.equal(stopRequest.method, "areal/execution/cancel");
  assert.deepEqual(stopRequest.params, {
    parentThreadId: "thread",
    executionId: "execution-2",
    mode: "graceful",
  });
  c.run(`pending.get(${stopRequest.id}).reject(Error("connection lost"))`);
  await stopping;
  assert.equal(c.requests.filter((item) => item.method === "areal/execution/cancel").length, 1);
  assert.match(c.get("notice").textContent, /不会自动重发/);
});

test("candidate delivery refreshes on an interval without busy-waiting or writing", async () => {
  const timers = [];
  const c = client({
    setTimeout: (callback, delay) => {
      timers.push({ callback, delay });
      return 0;
    },
  });
  const showing = c.run('showExecution("candidate", "thread", groupObservation)');
  const request = c.requests.at(-1);
  const execution = {
    executionId: "candidate",
    parentThreadId: "thread",
    status: "awaitingDelivery",
    settled: false,
    resourcesReleased: true,
    text: "",
    error: null,
    verification: { status: "notRun", kind: "none" },
    delivery: { status: "candidate" },
  };
  c.run(`pending.get(${request.id}).resolve(${JSON.stringify(execution)})`);
  await new Promise(setImmediate);
  assert.equal(c.requests.filter((item) => item.method === "areal/execution/wait").length, 0);
  assert.equal(c.requests.filter((item) => item.method === "areal/execution/read").length, 1);
  const refresh = timers.find((timer) => timer.delay === 2000);
  assert.ok(refresh);
  c.run('thread = {id:"another",turns:[]}');
  refresh.callback();
  await showing;
  assert.equal(c.requests.filter((item) => item.method.startsWith("areal/execution/")).length, 1);
});
