const $ = (id) => document.getElementById(id);
let socket,
  thread = null,
  nextId = 0,
  connected = false,
  refreshing = false,
  listCursor = null,
  listing = false;
const pending = new Map();
const labels = {
  inProgress: "执行中",
  completed: "已完成",
  interrupted: "已停止",
  failed: "执行失败",
};
function notice(error) {
  $("notice").textContent = error?.message ?? String(error ?? "");
}
function call(method, params) {
  if (!connected) return Promise.reject(Error("连接已断开，请重新加载页面。"));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("响应超时。操作结果可能未知，请刷新任务确认。"));
    }, 20000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}
function active() {
  return thread?.turns?.at(-1)?.status === "inProgress";
}
function render() {
  $("workspace").textContent = thread?.cwd ?? "选择或新建任务";
  $("status").textContent = labels[thread?.turns?.at(-1)?.status] ?? "就绪";
  $("send").disabled = !connected || !thread;
  $("send").textContent = active() ? "补充说明" : "发送";
  $("interrupt").disabled = !active();
  const history = $("history"),
    atBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 100;
  const opened = new Set(
    [...history.querySelectorAll("details[open]")].map((item) => item.dataset.id),
  );
  history.replaceChildren();
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items) {
      if (item.type === "dynamicToolCall") {
        const unknown =
            item.execution?.outcome === "unknown" ||
            item.execution?.hooks?.some((hook) => hook.outcome === "unknown"),
          card = node("details", undefined, `item tool${unknown ? " unknown" : ""}`);
        card.dataset.id = item.id;
        card.open = opened.has(item.id) || unknown;
        card.append(
          node(
            "summary",
            `${item.tool} · ${unknown ? "结果未知" : (labels[item.status] ?? item.status)}`,
          ),
        );
        card.append(node("pre", JSON.stringify(item.arguments, null, 2)));
        for (const content of item.contentItems ?? [])
          if (content.type === "inputText") card.append(node("pre", content.text));
        if (item.execution?.hooks?.length) {
          card.append(node("pre", JSON.stringify(item.execution.hooks, null, 2)));
        }
        if (unknown && !item.execution.inspection) {
          const inspection = node("div", undefined, "inspection"),
            label = node("label", "检查工作区和执行结果后，记录你已确认的情况，再允许继续任务。"),
            input = node("textarea");
          input.maxLength = 1024;
          input.placeholder = "例如：文件已修改一次，测试进程已退出，无需重复执行。";
          input.setAttribute("aria-label", "结果检查说明");
          const acknowledge = node("button", "记录检查结果");
          acknowledge.disabled = active();
          acknowledge.onclick = async () => {
            try {
              await call("areal/tool/acknowledge", {
                threadId: thread.id,
                itemId: item.id,
                inspection: input.value,
              });
              await reload();
              notice("检查结果已记录。可以发送新的任务说明。");
            } catch (error) {
              notice(error);
            }
          };
          inspection.append(label, input, acknowledge);
          card.append(inspection);
        } else if (unknown) {
          card.append(node("pre", `检查记录：${item.execution.inspection}`));
        }
        history.append(card);
      } else if (item.type !== "modelContext") {
        const user = item.type === "userMessage",
          card = node("article", undefined, `item${user ? " user" : ""}`);
        card.append(node("h3", user ? "你" : "Agent"));
        card.append(
          node(
            "pre",
            user
              ? item.content.map((part) => part.text ?? `[${part.type}]`).join("\n")
              : item.type === "agentMedia"
                ? `[${item.modality}] ${item.media.uri}`
                : (item.text ?? ""),
          ),
        );
        history.append(card);
      }
    }
    if (turn.status !== "inProgress")
      history.append(
        node(
          "p",
          `${labels[turn.status]}${turn.error ? ` · ${turn.error.message}` : ""}`,
          "turn-end",
        ),
      );
  }
  if (atBottom) history.scrollTop = history.scrollHeight;
}
async function list(more = false) {
  if (listing) return;
  listing = true;
  $("more").disabled = true;
  try {
    const result = await call("thread/list", {
      limit: 100,
      ...(more ? { cursor: listCursor } : {}),
    });
    if (!more) $("threads").replaceChildren();
    const existing = new Set([...$("threads").children].map((button) => button.dataset.id));
    for (const item of result.data) {
      if (existing.has(item.id)) continue;
      const button = node(
        "button",
        item.preview || "未命名任务",
        item.id === thread?.id ? "selected" : "",
      );
      button.dataset.id = item.id;
      button.onclick = () => select(item.id).catch(notice);
      $("threads").append(button);
    }
    listCursor = result.nextCursor;
    $("more").hidden = !listCursor;
  } finally {
    listing = false;
    $("more").disabled = false;
  }
}
async function select(id) {
  const result = await call("thread/resume", { threadId: id });
  thread = result.thread;
  $("permission").textContent =
    result.sandbox.type === "workspaceWrite" ? "工作区可写 · 网络关闭" : "只读工作区";
  render();
  for (const button of $("threads").children)
    button.classList.toggle("selected", button.dataset.id === id);
}
async function reload() {
  if (refreshing || !thread) return;
  refreshing = true;
  try {
    const result = await call("thread/resume", { threadId: thread.id });
    thread = result.thread;
    render();
  } finally {
    refreshing = false;
  }
}
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}
function event(message) {
  const p = message.params ?? {};
  if (!thread || p.threadId !== thread.id) return;
  if (message.method.includes("resync") || message.method.includes("lagged")) {
    reload().catch(notice);
    return;
  }
  if (message.method === "turn/started" || message.method === "turn/completed") {
    const index = thread.turns.findIndex((turn) => turn.id === p.turn.id);
    if (index === -1) thread.turns.push(p.turn);
    else thread.turns[index] = p.turn;
  } else {
    const turn = thread.turns.find((turn) => turn.id === p.turnId);
    if (!turn) return;
    if (
      message.method === "item/started" ||
      message.method === "item/completed" ||
      message.method === "areal/item/agentMedia/available"
    ) {
      const index = turn.items.findIndex((item) => item.id === p.item.id);
      if (index === -1) turn.items.push(p.item);
      else turn.items[index] = p.item;
    }
    if (message.method === "item/agentMessage/delta") {
      const item = turn.items.find((item) => item.id === p.itemId);
      if (item) item.text += p.delta;
    }
  }
  scheduleRender();
}
$("new").onclick = async () => {
  try {
    const result = await call("thread/start", {});
    thread = result.thread;
    $("permission").textContent =
      result.sandbox.type === "workspaceWrite" ? "工作区可写 · 网络关闭" : "只读工作区";
    notice("");
    render();
    await list();
    $("prompt").focus();
  } catch (error) {
    notice(error);
  }
};
$("refresh").onclick = async () => {
  try {
    await reload();
    await list();
  } catch (error) {
    notice(error);
  }
};
$("more").onclick = () => list(true).catch(notice);
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  if (!thread) return;
  const text = $("prompt").value.trim();
  if (!text) return;
  try {
    const input = [{ type: "text", text }];
    if (active())
      await call("turn/steer", {
        threadId: thread.id,
        expectedTurnId: thread.turns.at(-1).id,
        input,
      });
    else await call("turn/start", { threadId: thread.id, input });
    $("prompt").value = "";
    notice("");
  } catch (error) {
    notice(error);
  }
};
$("interrupt").onclick = () =>
  call("turn/interrupt", {
    threadId: thread.id,
    turnId: thread.turns.at(-1).id,
  }).catch(notice);
async function connect() {
  const url = new URL("/", location.href);
  url.protocol = "ws:";
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(Error("无法连接 Core。"));
  });
  connected = true;
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined && data.method) {
      socket.send(
        JSON.stringify({
          id: data.id,
          error: { code: -32601, message: "This client does not implement dynamic tool callbacks" },
        }),
      );
    } else if (data.id !== undefined) {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      if (data.error) waiter.reject(Error(data.error.message));
      else waiter.resolve(data.result);
    } else event(data);
  };
  socket.onclose = () => {
    connected = false;
    for (const request of pending.values())
      request.reject(Error("连接已断开。任务可能仍在执行，请重新加载页面。"));
    pending.clear();
    $("connection").textContent = "连接已断开";
    render();
  };
  await call("initialize", {
    clientInfo: { name: "areal-web", version: "0.1.0" },
  });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  $("connection").textContent = "已连接本地 Core";
  await list();
  render();
}
$("login").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const response = await fetch("/areal/auth/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${$("access-token").value}` },
    });
    $("access-token").value = "";
    if (!response.ok) throw Error("认证失败，请使用可信启动器提供的访问令牌。");
    await connect();
  } catch (error) {
    notice(error);
  }
};
connect().catch(notice);

// Core owns execution across disconnects. Cursor waits avoid busy polling;
// a stopped observer never cancels the actual workgroup.
let groupObservation = 0;
async function showGroup(id, observation) {
  let view = await call("areal/workgroup/read", { id });
  while (observation === groupObservation && connected) {
    const card = node("article", undefined, "item");
    card.append(node("h3", `${view.record.objective} · ${view.record.status}`));
    card.append(
      node(
        "p",
        `并发上限 ${view.record.admission.maxWorkers} · 当前目标 ${view.record.admission.targetWorkers} · 派发峰值 ${view.record.peakWorkers}`,
      ),
    );
    for (const task of view.record.tasks)
      card.append(
        node(
          "p",
          `${task.spec.id}: ${task.status} · 第 ${task.generation} 次执行${task.feedback ? ` · ${task.feedback}` : ""}`,
        ),
      );
    card.append(node("p", `验收结果目录：${view.candidatePath}`));
    if (view.record.error) card.append(node("pre", view.record.error));
    if (view.record.finalCheck) card.append(node("pre", view.record.finalCheck.output));
    if (view.record.status === "running") {
      const cancel = node("button", "停止协同任务");
      cancel.onclick = () => call("areal/workgroup/cancel", { id }).catch(notice);
      card.append(cancel);
      const edit = node("details");
      edit.append(node("summary", "调整尚未开始的任务"));
      const plan = node("textarea");
      plan.rows = 8;
      plan.value = JSON.stringify(
        { objective: view.record.objective, tasks: view.record.tasks.map((t) => t.spec) },
        null,
        2,
      );
      const revise = node("button", "提交计划调整");
      const expectedRevision = view.record.planRevision;
      const requestId = crypto.randomUUID();
      revise.onclick = async () => {
        try {
          await call("areal/workgroup/revise", {
            id,
            requestId,
            expectedRevision,
            plan: JSON.parse(plan.value),
          });
          edit.open = false;
          await showGroup(id, ++groupObservation);
        } catch (error) {
          notice(error);
        }
      };
      edit.append(plan, revise);
      card.append(edit);
    }
    // Keep an expanded edit form stable while its author is typing.
    if (view.record.status !== "running" || !$("groups").querySelector("details[open]"))
      $("groups").replaceChildren(card);
    if (view.record.status !== "running") break;
    view = await call("areal/workgroup/wait", {
      id,
      afterRevision: view.record.revision,
      timeoutMs: 10000,
    });
  }
}
async function listGroups() {
  ++groupObservation;
  const { data } = await call("areal/workgroup/list", {});
  $("groups").replaceChildren();
  for (const group of data) {
    const button = node("button", `${group.objective} · ${group.status}`, "secondary");
    button.onclick = () => showGroup(group.id, ++groupObservation).catch(notice);
    $("groups").append(button);
  }
}
$("groups-refresh").onclick = () => listGroups().catch(notice);
$("group-start").onsubmit = async (event) => {
  event.preventDefault();
  try {
    const value = await call("areal/workgroup/start", JSON.parse($("group-plan").value));
    await showGroup(value.id, ++groupObservation);
  } catch (error) {
    notice(error);
  }
};
