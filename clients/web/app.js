const $ = (id) => document.getElementById(id);
let socket,
  thread = null,
  nextId = 0,
  connected = false,
  refreshing = false,
  listCursor = null,
  listing = false,
  archiving = new Set();
let skills = [],
  slashIndex = 0;
const pending = new Map();
let interactionDisplayed = null;
let goalsSupported = false,
  displayedGoal = null;
let tasksSupported = false,
  taskListing = false,
  taskCursor = null,
  taskCreating = false,
  taskCreateAttempt = null,
  selectedTaskId = null,
  taskObservation = 0,
  channelObservation = 0,
  inboxLoading = false,
  inboxCursor = null;
const taskRows = new Map(),
  inboxRows = new Map(),
  inboxDrafts = new Map();
let waiting = null,
  stopping = null;
const slashCommands = [
  ["/help", "显示可用命令"],
  ["/new", "新建任务"],
  ["/refresh", "刷新当前任务"],
  ["/skills", "选择当前任务的 Skill"],
  ["/skill", "按名称选择 Skill"],
  ["/goal", "创建或查看持续目标"],
  ["/goal-pause", "暂停持续目标"],
  ["/goal-resume", "恢复持续目标"],
  ["/goal-clear", "清除持续目标"],
];
const labels = {
  inProgress: "执行中",
  completed: "已完成",
  interrupted: "已停止",
  failed: "执行失败",
};

const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const mobileLayout = matchMedia("(max-width: 700px)");
let theme = "system",
  sidebarCollapsed = false,
  submitting = false;
try {
  theme = localStorage.getItem("areal-web-theme") ?? "system";
} catch {
  // 禁用浏览器存储时仍允许本次页面切换外观。
}
if (!["system", "light", "dark"].includes(theme)) theme = "system";
function applyTheme() {
  document.documentElement.dataset.theme =
    theme === "system" ? (systemTheme.matches ? "dark" : "light") : theme;
  $("theme").value = theme;
}
applyTheme();
systemTheme.addEventListener("change", applyTheme);
$("theme").onchange = () => {
  theme = $("theme").value;
  applyTheme();
  try {
    localStorage.setItem("areal-web-theme", theme);
  } catch {
    // 外观偏好保存失败不影响当前页面。
  }
};
function mobileSidebar(open, restoreFocus = false) {
  document.body.classList.toggle("sidebar-mobile-open", open);
  $("sidebar-backdrop").hidden = !open;
  $("main").inert = open;
  $("sidebar-open").setAttribute("aria-expanded", String(open));
  if (open) $("sidebar-toggle").focus();
  else if (restoreFocus) $("sidebar-open").focus();
}
function updateSidebar() {
  document.body.classList.toggle("sidebar-collapsed", sidebarCollapsed && !mobileLayout.matches);
  const expanded = mobileLayout.matches || !sidebarCollapsed;
  $("sidebar-toggle").setAttribute("aria-expanded", String(expanded));
  $("sidebar-toggle").setAttribute("aria-label", expanded ? "收起侧栏" : "展开侧栏");
  $("sidebar-toggle").title = expanded ? "收起侧栏" : "展开侧栏";
}
$("sidebar-toggle").onclick = () => {
  if (mobileLayout.matches) mobileSidebar(false, true);
  else {
    sidebarCollapsed = !sidebarCollapsed;
    updateSidebar();
  }
};
$("sidebar-open").onclick = () => mobileSidebar(true);
$("sidebar-backdrop").onclick = () => mobileSidebar(false, true);
mobileLayout.addEventListener("change", () => {
  mobileSidebar(false);
  updateSidebar();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("sidebar-mobile-open"))
    mobileSidebar(false, true);
});
$("settings-open").onclick = () => $("settings-dialog").showModal();
$("settings-close").onclick = () => $("settings-dialog").close();
function showView(view) {
  const selectedView = typeof view === "boolean" ? (view ? "groups" : "history") : view;
  $("conversation").hidden = selectedView !== "history";
  $("workgroups").hidden = selectedView !== "groups";
  $("task-center").hidden = selectedView !== "tasks";
  for (const id of ["history-tab", "groups-tab", "tasks-tab"]) {
    const selected = id === `${selectedView}-tab`;
    $(id).setAttribute("aria-selected", String(selected));
    $(id).tabIndex = selected ? 0 : -1;
  }
}
$("history-tab").onclick = () => showView(false);
$("groups-tab").onclick = () => showView(true);
$("tasks-tab").onclick = () => {
  showView("tasks");
  listTasks().catch(notice);
};
for (const id of ["history-tab", "groups-tab", "tasks-tab"])
  $(id).onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const tabs = ["history-tab", "groups-tab", "tasks-tab"].filter((id) => !$(id).hidden);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (tabs.indexOf(id) + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    $(tabs[index]).click();
    $(tabs[index]).focus();
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
function icon(name, className) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}
function active() {
  return thread?.turns?.at(-1)?.status === "inProgress";
}
function isStopping() {
  return Boolean(
    stopping &&
    stopping.threadId === thread?.id &&
    ((active() && stopping.turnId === thread.turns.at(-1).id) ||
      (stopping.goalId &&
        stopping.goalId === thread?.goals?.goal?.id &&
        thread.goals.goal.status === "active")),
  );
}
function renderComposer() {
  const text = $("prompt").value.trim();
  const hasText = Boolean(text);
  const slash = text.startsWith("/");
  $("send").disabled = !connected || (!thread && !slash) || !hasText || submitting;
  const running = active() || thread?.goals?.goal?.status === "active";
  $("send").hidden = running && !hasText;
  const label = active() ? "补充说明" : "发送";
  $("send").setAttribute("aria-label", label);
  $("send").title = label;
  $("interrupt").disabled = !connected || !running || isStopping();
  const stopLabel = isStopping() ? "正在停止…" : "停止执行";
  $("interrupt").setAttribute("aria-label", stopLabel);
  $("interrupt").title = stopLabel;
  $("interrupt").hidden = !running;
}
function renderSlashMenu() {
  const menu = $("slash-menu"),
    text = $("prompt").value;
  const query = text.startsWith("/") && !/[\s\n]/.test(text) ? text.toLowerCase() : "";
  const matches = query ? slashCommands.filter(([name]) => name.startsWith(query)) : [];
  menu.replaceChildren();
  menu.hidden = !matches.length;
  if (!matches.length) {
    slashIndex = 0;
    return;
  }
  slashIndex = Math.min(slashIndex, matches.length - 1);
  for (const [index, [name, description]] of matches.entries()) {
    const button = node("button", undefined, "slash-command");
    button.type = "button";
    button.role = "option";
    button.ariaSelected = String(index === slashIndex);
    button.append(node("strong", name), node("span", description, "slash-command-description"));
    button.onclick = () => {
      $("prompt").value = `${name}${name === "/skill" || name === "/goal" ? " " : ""}`;
      slashIndex = 0;
      renderComposer();
      $("prompt").focus();
    };
    menu.append(button);
  }
}
$("prompt").oninput = () => {
  slashIndex = 0;
  renderComposer();
  renderSlashMenu();
};
$("prompt").onkeydown = (event) => {
  if (!$("slash-menu").hidden && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    const count = $("slash-menu").children.length;
    slashIndex = (slashIndex + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
    renderSlashMenu();
    return;
  }
  if (!$("slash-menu").hidden && event.key === "Tab") {
    event.preventDefault();
    $("slash-menu").children[slashIndex]?.click();
    return;
  }
  // 输入法确认候选字不提交任务，Shift + Enter 保留多行输入。
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    if (!$("send").disabled) $("composer").requestSubmit();
  }
};
async function loadSkills() {
  if (!thread) {
    skills = [];
    return;
  }
  const result = await call("areal/skill/list", { threadId: thread.id });
  skills = result.data ?? [];
  renderSkills();
}
function renderSkills() {
  const list = $("skills-list");
  if (!list) return;
  list.replaceChildren();
  if (!thread) {
    list.append(node("p", "请先新建或选择任务。", "muted"));
    return;
  }
  if (!skills.length) {
    list.append(node("p", "当前任务没有可用 Skill。", "muted"));
    return;
  }
  const selected = new Set(
    (thread.desktop?.configuration?.selectedSkills ?? []).map((s) => `${s.id}/${s.revision}`),
  );
  for (const skill of skills) {
    const button = node(
      "button",
      undefined,
      `skill-option${selected.has(`${skill.id}/${skill.revision}`) ? " selected" : ""}`,
    );
    button.type = "button";
    button.disabled = skill.available === false;
    button.append(
      node("strong", skill.name || skill.id),
      node("small", skill.description || skill.id),
    );
    button.onclick = () => configureSkill(skill).catch(notice);
    list.append(button);
  }
}
async function configureSkill(skill) {
  if (!thread) return;
  const configuration = thread.desktop?.configuration;
  if (!configuration) throw Error("任务配置尚未加载，请刷新后重试。");
  await call("areal/thread/configure", {
    threadId: thread.id,
    expectedRevision: configuration.revision,
    selectedSkills: [{ id: skill.id, revision: skill.revision }],
  });
  await reload();
  $("skills-notice").textContent = `已选择 ${skill.name || skill.id}`;
  renderSkills();
}
async function openSkills() {
  if (!thread) {
    notice("请先新建或选择任务。");
    return;
  }
  await loadSkills();
  $("skills-dialog").showModal();
}
$("skills-open").onclick = () => openSkills().catch(notice);
$("skills-close").onclick = () => $("skills-dialog").close();
function slashHelp() {
  notice(slashCommands.map(([name, description]) => `${name}：${description}`).join(" · "));
}
async function runSlash(text) {
  const [command, ...rest] = text.split(/\s+/);
  const argument = rest.join(" ").trim();
  switch (command) {
    case "/help":
      slashHelp();
      return true;
    case "/new":
      $("new").click();
      return true;
    case "/refresh":
      await reload();
      await list();
      return true;
    case "/skills":
      await openSkills();
      return true;
    case "/skill": {
      if (!argument) {
        await openSkills();
        return true;
      }
      await loadSkills();
      const query = argument.toLowerCase();
      const skill = skills.find(
        (s) => s.id.toLowerCase() === query || (s.name ?? "").toLowerCase() === query,
      );
      if (!skill) throw Error("Skill 未找到，请使用 /skills 查看可选项。");
      await configureSkill(skill);
      return true;
    }
    case "/goal-pause":
    case "/goal-resume":
    case "/goal-clear":
      await goalControl(command.slice(6));
      return true;
    case "/goal":
      if (!argument) {
        renderGoal();
        return true;
      }
      await goalControl(thread.goals?.goal ? "update" : "create", {
        objective: argument,
        tokenBudget: null,
      });
      return true;
    default:
      throw Error("未知命令，请使用 /help。");
  }
}
function render() {
  if (stopping?.threadId === thread?.id && !isStopping()) stopping = null;
  const cwd = thread?.cwd;
  $("workspace").textContent = cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? "工作区";
  $("workspace").title = cwd ?? "工作区";
  const firstMessage = thread?.turns
    ?.flatMap((turn) => turn.items)
    .find((item) => item.type === "userMessage");
  const title =
    thread?.preview || firstMessage?.content.map((part) => part.text ?? "").join(" ") || "新建任务";
  $("task-title").textContent = title;
  $("task-title").title = title;
  const selectedThread = [...$("threads").children].find((row) => row.dataset.id === thread?.id);
  if (selectedThread && firstMessage) {
    selectedThread.querySelector(".thread-title").textContent = title;
    selectedThread.querySelector(".thread-select").title = title;
  }
  $("status").textContent = labels[thread?.turns?.at(-1)?.status] ?? "就绪";
  $("status").dataset.status = thread?.turns?.at(-1)?.status ?? "idle";
  const empty = !thread?.turns?.length;
  $("main").classList.toggle("is-empty", empty);
  $("welcome").hidden = !empty;
  $("welcome-description").textContent = thread
    ? "描述任务，让想法变成结果。"
    : "新建任务，开始你的工作。";
  $("composer-context").querySelector("span").textContent = cwd ?? "从侧栏新建任务以使用当前工作区";
  $("composer-context").title = cwd ?? "";
  $("new").disabled = !connected;
  $("refresh").disabled = !connected || refreshing;
  const refreshLabel = refreshing ? "刷新中…" : "刷新任务";
  $("refresh").setAttribute("aria-label", refreshLabel);
  $("refresh").title = refreshLabel;
  $("refresh").setAttribute("aria-busy", String(refreshing));
  $("groups-refresh").disabled = !connected;
  $("group-start").querySelector("button").disabled = !connected;
  renderComposer();
  renderProgress();
  renderGoal();
  renderTaskControls();
  renderInteractions();
  const history = $("history"),
    atBottom = history.scrollHeight - history.scrollTop - history.clientHeight < 100;
  const opened = new Set(
    [...history.querySelectorAll("details[open]")].map((item) => item.dataset.id),
  );
  history.replaceChildren();
  for (const turn of thread?.turns ?? []) {
    for (const item of turn.items) {
      if (item.type === "agentMessage" && !item.text) continue;
      if (item.type === "reasoning") {
        const card = node("details", undefined, "item tool reasoning");
        card.dataset.id = item.id;
        card.open = opened.has(item.id);
        const summary = node("summary");
        summary.append(
          node(
            "span",
            item.summary?.some(Boolean) && !item.content?.some(Boolean) ? "思考摘要" : "模型思考",
          ),
          icon("chevron", "disclosure-chevron"),
        );
        card.append(summary);
        card.append(node("pre", [...(item.summary ?? []), ...(item.content ?? [])].join("\n")));
        history.append(card);
      } else if (item.type === "dynamicToolCall") {
        const unknown =
            item.execution?.outcome === "unknown" ||
            item.execution?.hooks?.some((hook) => hook.outcome === "unknown"),
          card = node("details", undefined, `item tool${unknown ? " unknown" : ""}`);
        card.dataset.id = item.id;
        card.open = opened.has(item.id) || unknown;
        const summary = node("summary");
        summary.append(
          icon("terminal"),
          node(
            "span",
            `${item.tool} · ${unknown ? "结果未知" : (labels[item.status] ?? item.status)}`,
          ),
          icon("chevron", "disclosure-chevron"),
        );
        card.append(summary);
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
        if (user && turn.goal?.origin === "continuation" && item === turn.items[0])
          card.classList.add("continuation");
        card.append(
          node(
            "h3",
            user
              ? turn.goal?.origin === "continuation" && item === turn.items[0]
                ? "自动续轮"
                : "你"
              : "Agent",
          ),
        );
        card.append(
          node(
            "pre",
            user
              ? item.content.map((part) => part.text ?? `[${part.type}]`).join("\n")
              : item.type === "agentMedia"
                ? `[${item.modality}] ${item.media.uri}`
                : (item.text ?? ""),
            "message-text",
          ),
        );
        history.append(card);
      }
    }
    if (turn.status !== "inProgress") {
      const end = node(
        "p",
        `${labels[turn.status]}${turn.error ? ` · ${turn.error.message}` : ""}`,
        "turn-end",
      );
      end.dataset.status = turn.status;
      history.append(end);
    }
  }
  if (atBottom) history.scrollTop = history.scrollHeight;
}
function renderProgress() {
  const progress = $("progress"),
    turn = thread?.turns?.at(-1);
  progress.hidden = !active();
  if (!active()) {
    waiting = null;
    return;
  }
  const message = turn.items.findLast((item) => item.type === "agentMessage");
  const key = `${thread.id}:${turn.id}:${message?.id ?? "pending"}`;
  if (waiting?.key !== key) waiting = { key, since: Date.now() };
  if (!connected) {
    progress.textContent = "连接已断开，任务可能仍在执行。请重新连接后刷新状态。";
    return;
  }
  if (isStopping()) {
    progress.textContent = "已请求停止，正在等待任务与工具结束…";
    return;
  }
  const tail = message ? turn.items.slice(turn.items.indexOf(message) + 1) : [];
  const tool = tail.findLast((item) => item.type === "dynamicToolCall");
  if (tool) {
    progress.textContent =
      tool.status === "inProgress" ? `正在执行 ${tool.tool}…` : "任务执行中，等待下一步…";
    return;
  }
  if (message?.text?.trim() || tail.some((item) => item.type === "agentMedia")) {
    progress.textContent = "任务执行中…";
    return;
  }
  const reasoning = tail.some(
    (item) =>
      item.type === "reasoning" && [...(item.content ?? []), ...(item.summary ?? [])].some(Boolean),
  );
  const seconds = Math.floor((Date.now() - waiting.since) / 1000);
  progress.textContent = `${reasoning ? "已收到模型思考，等待正文" : "正在等待模型回复"} · 已观察 ${seconds} 秒。${seconds >= 30 ? "仍未收到正文，可继续等待、刷新任务状态或停止执行。" : ""}`;
}
setInterval(renderProgress, 1000);

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
    const existing = new Set([...$("threads").children].map((row) => row.dataset.id));
    for (const item of result.data) {
      if (item.desktop?.archived || existing.has(item.id) || archiving.has(item.id)) continue;
      const row = node("div", undefined, `thread-row${item.id === thread?.id ? " selected" : ""}`);
      const button = node("button", undefined, "thread-select");
      button.type = "button";
      button.append(node("span", item.preview || "未命名任务", "thread-title"));
      button.title = item.preview || "未命名任务";
      if (item.id === thread?.id) button.setAttribute("aria-current", "true");
      button.onclick = () => select(item.id).catch(notice);
      const remove = node("button", undefined, "thread-remove icon-button");
      remove.type = "button";
      remove.setAttribute("aria-label", `删除会话：${button.title}`);
      remove.title = "删除会话";
      remove.append(icon("close"));
      remove.onclick = () => archiveSession(item.id, button.title).catch(notice);
      row.dataset.id = item.id;
      row.append(button, remove);
      $("threads").append(row);
    }
    listCursor = result.nextCursor;
    $("more").hidden = !listCursor;
    $("threads-empty").hidden = $("threads").children.length > 0 || Boolean(listCursor);
    $("threads-empty").textContent = "还没有任务，点击上方新建。";
  } finally {
    listing = false;
    $("more").disabled = false;
  }
}
async function archiveSession(id, title) {
  if (
    archiving.has(id) ||
    !confirm(
      `删除会话“${title}”？\n\n会话将从列表移除，历史仍保留在本地存储中。运行中的任务需先停止。`,
    )
  )
    return;
  archiving.add(id);
  const row = [...$("threads").children].find((item) => item.dataset.id === id);
  const remove = row?.querySelector(".thread-remove");
  if (remove) remove.disabled = true;
  try {
    await call("areal/thread/archive", { threadId: id, requestId: crypto.randomUUID() });
    await removeArchivedSession(id);
    notice("");
  } finally {
    archiving.delete(id);
    if (remove) remove.disabled = false;
  }
}
async function removeArchivedSession(id) {
  [...$("threads").children].find((row) => row.dataset.id === id)?.remove();
  if (thread?.id === id) {
    thread = null;
    skills = [];
    displayedGoal = null;
    const next = $("threads").children[0];
    if (next) await select(next.dataset.id);
    else render();
  }
  $("threads-empty").hidden = $("threads").children.length > 0 || Boolean(listCursor);
}
async function select(id) {
  const result = await call("thread/resume", { threadId: id });
  thread = result.thread;
  renderPermissions(result);
  render();
  showView(false);
  if (mobileLayout.matches) mobileSidebar(false, true);
  for (const row of $("threads").children) {
    row.classList.toggle("selected", row.dataset.id === id);
    const button = row.querySelector(".thread-select");
    if (row.dataset.id === id) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}
async function reload() {
  if (refreshing || !thread) return;
  refreshing = true;
  const id = thread.id;
  render();
  try {
    const result = await call("thread/resume", { threadId: id });
    if (thread?.id === id) {
      thread = result.thread;
      renderPermissions(result);
    }
  } finally {
    refreshing = false;
    render();
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
  if (message.method === "areal/thread/archived") {
    if (!archiving.has(p.threadId)) removeArchivedSession(p.threadId).catch(notice);
    return;
  }
  if (message.method === "areal/task/updated") {
    receiveTask(p.task);
    return;
  }
  if (!thread || (p.threadId ?? p.interaction?.threadId) !== thread.id) return;
  if (
    message.method === "areal/interaction/requested" ||
    message.method === "areal/interaction/resolved"
  ) {
    thread.desktop ??= {};
    if ((thread.desktop.interactionRevision ?? 0) <= p.revision) {
      thread.desktop.interactionRevision = p.revision;
      thread.desktop.interactions = (thread.desktop.interactions ?? []).filter(
        (i) => i.requestId !== p.interaction.requestId,
      );
      thread.desktop.interactions.push(p.interaction);
      renderInteractions();
    }
    return;
  }
  if (message.method.includes("resync") || message.method.includes("lagged")) {
    reload().catch(notice);
    return;
  }
  if (message.method === "areal/server/configurationChanged") {
    const config = p.configuration;
    notice(
      config.error
        ? `配置未生效：${config.error}`
        : config.restartRequired
          ? "配置需要重启；后台任务保留运行，可在工作区运行 areal service restart。"
          : "模型配置已更新，将用于后续新提交；运行中和已排队任务保持原配置。",
    );
    return;
  }
  if (message.method === "areal/goal/updated" || message.method === "areal/goal/cleared") {
    applyGoal(p);
  } else if (message.method === "areal/model/completionDiscarded") {
    const discarded = new Set(p.itemIds);
    for (const turn of thread.turns)
      turn.items = turn.items.filter((item) => !discarded.has(item.id));
  } else if (message.method === "areal/thread/configured") {
    thread.desktop ??= {};
    thread.desktop.configuration = p.configuration;
  } else if (message.method === "turn/started" || message.method === "turn/completed") {
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
    if (
      message.method === "item/reasoning/textDelta" ||
      message.method === "item/reasoning/summaryTextDelta"
    ) {
      const item = turn.items.find((item) => item.id === p.itemId);
      const summary = message.method === "item/reasoning/summaryTextDelta";
      const index = summary ? p.summaryIndex : p.contentIndex;
      if (item?.type === "reasoning" && Number.isInteger(index) && index >= 0 && index < 64) {
        const parts = summary ? item.summary : item.content;
        while (parts.length <= index) parts.push("");
        parts[index] += p.delta;
      }
    }
    if (message.method === "item/agentMessage/delta") {
      const item = turn.items.find((item) => item.id === p.itemId);
      if (item) item.text += p.delta;
    }
  }
  if (message.method === "areal/thread/configured") renderSkills();
  scheduleRender();
}
$("new").onclick = async () => {
  try {
    const result = await call("thread/start", {});
    thread = result.thread;
    renderPermissions(result);
    renderPermissions(result);
    notice("");
    render();
    skills = [];
    showView(false);
    if (mobileLayout.matches) mobileSidebar(false);
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
    notice("");
  } catch (error) {
    notice(error);
  }
};
$("more").onclick = () => list(true).catch(notice);
$("composer").onsubmit = async (e) => {
  e.preventDefault();
  if (submitting || !connected) return;
  const text = $("prompt").value.trim();
  if (!text) return;
  if (!thread && !text.startsWith("/")) return;
  submitting = true;
  renderComposer();
  try {
    if (text.startsWith("/")) {
      await runSlash(text);
      $("prompt").value = "";
      $("slash-menu").hidden = true;
      return;
    }
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
  } finally {
    submitting = false;
    renderComposer();
  }
};
$("interrupt").onclick = async () => {
  const goal = thread?.goals?.goal;
  if (!connected || (!active() && goal?.status !== "active") || isStopping()) return;
  const request = {
    threadId: thread.id,
    turnId: thread.turns.at(-1)?.id,
    goalId: goal?.status === "active" ? goal.id : null,
  };
  stopping = request;
  render();
  try {
    if (request.goalId) await goalControl("pause");
    else await call("turn/interrupt", { threadId: request.threadId, turnId: request.turnId });
    if (thread?.id === request.threadId) await reload();
  } catch (error) {
    if (stopping === request) stopping = null;
    notice(error);
  } finally {
    render();
  }
};

function applyGoal(view) {
  if (!thread || view.threadId !== thread.id) return;
  if ((view.eventSequence ?? 0) >= (thread.goals?.eventSequence ?? 0))
    thread.goals = { revision: view.revision, eventSequence: view.eventSequence, goal: view.goal };
}
function renderGoal() {
  $("goal-panel").hidden = !goalsSupported || !thread;
  const goal = thread?.goals?.goal;
  const busy = active() || goal?.status === "active";
  const status = {
    active: "执行中",
    paused: "已暂停",
    blocked: "等待处理",
    completed: "已完成",
    budgetLimited: "达到预算",
    failed: "执行失败",
  };
  $("goal-status").textContent = goal
    ? `持续目标 · ${goal.status === "active" && goal.waitingForInput ? "等待收件箱回复" : goal.status === "active" && goal.waitingForAgents ? "等待协作任务" : (status[goal.status] ?? goal.status)}`
    : "持续目标";
  $("goal-progress").textContent = goal
    ? `${goal.objective} · ${goal.usage.tokensUsed} tokens${goal.tokenBudget ? ` / ${goal.tokenBudget}` : ""} · ${Math.round(goal.usage.timeUsedSeconds)} 秒 · ${goal.usage.turnsStarted}/${goal.maxTurns} 轮${goal.reason ? ` · ${goal.reason}` : ""}${goal.usage.accountingComplete ? "" : " · 用量不完整，预留额度保留"}`
    : "设置目标后，Agent 会在轮次结束后继续推进。";
  const key = `${thread?.id}:${goal?.id ?? ""}`;
  if (displayedGoal !== key) {
    displayedGoal = key;
    $("goal-objective").value = goal?.objective ?? "";
    $("goal-budget").value = goal?.tokenBudget ?? "";
  }
  $("goal-save").textContent = goal ? "保存修改" : "开始目标";
  $("goal-save").disabled = !connected || busy || goal?.status === "completed";
  $("goal-pause").disabled = !connected || goal?.status !== "active";
  $("goal-resume").disabled = !connected || !goal || busy || goal.status === "completed";
  $("goal-clear").disabled = !connected || !goal || busy;
}
async function goalControl(action, patch = {}) {
  if (!thread) return;
  const params = {
    threadId: thread.id,
    requestId: crypto.randomUUID(),
    expectedRevision: thread.goals?.revision ?? 0,
    ...patch,
  };
  if (action !== "create") params.goalId = thread.goals.goal.id;
  try {
    applyGoal(await call(`areal/goal/${action}`, params));
    render();
  } catch (error) {
    await reload();
    throw error;
  }
}
$("goal-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await goalControl(thread.goals?.goal ? "update" : "create", {
      objective: $("goal-objective").value,
      tokenBudget: $("goal-budget").value ? Number($("goal-budget").value) : null,
    });
  } catch (error) {
    notice(error);
  }
};
for (const action of ["pause", "resume", "clear"])
  $("goal-" + action).onclick = () => goalControl(action).catch(notice);
async function connect() {
  connected = false;
  for (const request of pending.values()) request.reject(Error("正在重新连接，请重试。"));
  pending.clear();
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  $("connection").textContent = "正在连接…";
  $("connection").dataset.state = "connecting";
  render();
  const url = new URL("/", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  try {
    await new Promise((resolve, reject) => {
      socket.onopen = resolve;
      socket.onerror = () => reject(Error("无法连接 Core，请检查服务或在设置中输入访问令牌。"));
    });
  } catch (error) {
    $("connection").textContent = "未连接";
    $("connection").dataset.state = "disconnected";
    throw error;
  }
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
      if (data.error) waiter.reject(Object.assign(Error(data.error.message), data.error));
      else waiter.resolve(data.result);
    } else event(data);
  };
  socket.onclose = () => {
    connected = false;
    for (const request of pending.values())
      request.reject(Error("连接已断开。任务可能仍在执行，请重新加载页面。"));
    pending.clear();
    $("connection").textContent = "连接已断开";
    $("connection").dataset.state = "disconnected";
    render();
  };
  await call("initialize", {
    clientInfo: { name: "areal-web", version: "0.1.0" },
  });
  socket.send(JSON.stringify({ method: "initialized", params: {} }));
  const capabilities = await call("areal/capabilities", {});
  goalsSupported = capabilities.features?.goals === true;
  tasksSupported = capabilities.features?.taskModes === true;
  $("tasks-tab").hidden = !tasksSupported;
  $("inbox-open").hidden = !tasksSupported;
  $("connection").textContent = "已连接本地 Core";
  $("connection").dataset.state = "connected";
  await list();
  await reload();
  if (tasksSupported) {
    await listTasks();
    await loadInbox();
    if (selectedTaskId) await selectTask(selectedTaskId);
  }
  render();
}
$("login").onsubmit = async (event) => {
  event.preventDefault();
  if ($("connect-button").disabled) return;
  $("connect-button").disabled = true;
  $("login-error").textContent = "";
  try {
    const response = await fetch("/areal/auth/session", {
      method: "POST",
      headers: { Authorization: `Bearer ${$("access-token").value}` },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    $("access-token").value = "";
    if (!response.ok) throw Error("认证失败，请使用可信启动器提供的访问令牌。");
    await connect();
    notice("");
    $("settings-dialog").close();
    if (mobileLayout.matches) mobileSidebar(false, true);
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    $("access-token").value = "";
    $("connect-button").disabled = false;
  }
};
async function startConnection() {
  const url = new URL(location.href);
  if (url.hash.startsWith("#bootstrap=")) {
    const code = url.hash.slice("#bootstrap=".length);
    // 在任何网络请求之前从当前历史记录清除一次性凭据，不写入浏览器存储。
    url.hash = "";
    history.replaceState(null, "", url);
    try {
      const response = await fetch("/areal/auth/bootstrap/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw Error("bootstrap rejected");
    } catch {
      throw Error("自动登录失败或链接已过期，请重新运行 areal web，或输入本地访问令牌。");
    }
  }
  await connect();
}
startConnection().catch((error) => {
  $("login-error").textContent = error.message;
  notice(error);
  $("settings-dialog").showModal();
});

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
  if (!data.length)
    $("groups").append(node("p", "暂无协同任务。提交执行计划后可在这里查看进度。", "muted"));
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

function renderPermissions(result) {
  const sandbox = result.sandbox ?? {};
  const scope =
    sandbox.type === "dangerFullAccess"
      ? "完整访问"
      : sandbox.type === "workspaceWrite"
        ? "工作区可写"
        : "工作区只读";
  $("permission").textContent =
    `${result.permissionMode ?? "部署权限"} · ${scope} · 网络${sandbox.networkAccess ? "开放" : "关闭"}`;
}

function renderInteractions() {
  const request = thread?.desktop?.interactions?.find((i) => i.status === "pending");
  let panel = $("permission-request");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "permission-request";
    panel.setAttribute("aria-live", "polite");
    $("history").before(panel);
  }
  if (interactionDisplayed === request?.requestId && panel.childElementCount) return;
  interactionDisplayed = request?.requestId ?? null;
  panel.replaceChildren();
  panel.hidden = !request;
  if (!request) return;
  const title = document.createElement("h3");
  title.textContent = request.kind === "approval" ? `允许执行 ${request.tool}？` : "需要你的回答";
  panel.append(title);
  const details = document.createElement("pre");
  details.textContent = JSON.stringify(request.effectiveArguments ?? request.questions, null, 2);
  panel.append(details);
  const submit = async (response) => {
    for (const button of panel.querySelectorAll("button")) button.disabled = true;
    try {
      await call("areal/interaction/respond", {
        threadId: request.threadId,
        turnId: request.turnId,
        requestId: request.requestId,
        ...response,
      });
      await reload();
    } catch (error) {
      notice(error);
      for (const button of panel.querySelectorAll("button")) button.disabled = false;
    }
  };
  if (request.kind === "approval") {
    const choices = [["允许一次", "allowOnce"]];
    if (request.effectivePermissions?.rememberAllowed)
      choices.push(
        ["本会话记住相同请求", "allowSession"],
        ["当前项目记住相同请求", "allowProject"],
      );
    choices.push(["拒绝", "deny"]);
    for (const [label, decision] of choices) {
      const button = document.createElement("button");
      button.textContent = label;
      button.onclick = () => submit({ decision, argumentsDigest: request.argumentsDigest });
      panel.append(button);
    }
  } else {
    const inputs = new Map();
    for (const question of request.questions) {
      const label = document.createElement("label");
      label.textContent = question.title;
      const input = document.createElement(question.allowFreeText ? "input" : "select");
      if (!question.allowFreeText)
        for (const value of question.options) {
          const option = document.createElement("option");
          option.textContent = value;
          input.append(option);
        }
      label.append(input);
      panel.append(label);
      inputs.set(question.id, input);
    }
    const button = document.createElement("button");
    button.textContent = "提交回答";
    button.onclick = () =>
      submit({ answers: Object.fromEntries([...inputs].map(([id, input]) => [id, input.value])) });
    panel.append(button);
  }
}

// Task 与 Inbox 不依赖当前会话；只订阅选中的 Task，重连后重新取得权威快照。
const taskStatusLabels = {
  queued: "等待执行",
  running: "执行中",
  waitingForInput: "等待收件箱回复",
  waitingForAgents: "等待协作任务",
  paused: "已暂停",
  blocked: "等待处理",
  completed: "已完成",
  failed: "执行失败",
  cancelled: "已取消",
};
function taskStatus(task) {
  const run = task.runs.at(-1);
  if (task.cancelled)
    return !run || run.status === "cancelled" || run.completedAt ? "已取消" : "正在取消…";
  if (task.paused) return run?.status === "running" ? "正在暂停…" : "已暂停";
  if ((!run || run.completedAt) && task.nextRunAt) return "等待下次执行";
  return taskStatusLabels[run?.status] ?? "等待执行";
}
function renderTaskControls() {
  const scheduled = $("task-mode").value === "scheduled";
  $("task-schedule-fields").hidden = !scheduled;
  $("task-at").required = scheduled;
  $("task-binding").textContent = thread
    ? `执行会话：${thread.preview || "当前新建会话"}`
    : "请先选择或新建一个会话，再添加定时任务。";
  $("task-create").disabled =
    !connected || !tasksSupported || taskCreating || (scheduled && !thread);
  $("task-create").textContent = taskCreating
    ? "正在受理…"
    : scheduled
      ? "添加定时任务"
      : "创建并运行";
  $("tasks-refresh").disabled = !connected || taskListing;
  $("tasks-more").disabled = !connected || taskListing;
  $("inbox-open").disabled = !connected;
  $("inbox-refresh").disabled = !connected || inboxLoading;
  $("inbox-more").disabled = !connected || inboxLoading;
  for (const button of $("task-detail").querySelectorAll("button")) button.disabled = !connected;
  for (const form of $("inbox-list").children) {
    const button = form.querySelector("button");
    if (button) button.disabled = !connected || form.dataset.sending === "true";
  }
}
$("task-mode").onchange = () => {
  $("task-interaction").value = $("task-mode").value === "scheduled" ? "headless" : "asynchronous";
  renderTaskControls();
};
async function listTasks(more = false) {
  if (!tasksSupported || !connected || taskListing) return;
  taskListing = true;
  renderTaskControls();
  try {
    const page = await call("areal/task/list", {
      limit: 30,
      ...(more ? { after: taskCursor } : {}),
    });
    // 列表第一页可能不包含选中项；保留订阅带来的最新 revision，避免控制失效或回退。
    const selected = taskRows.get(selectedTaskId);
    if (!more) {
      taskRows.clear();
      if (selected) taskRows.set(selected.id, selected);
    }
    for (const task of page.data) receiveTask(task, false);
    taskCursor = page.nextCursor;
    $("tasks-more").hidden = !taskCursor;
    renderTaskList();
    const current = taskRows.get(selectedTaskId);
    if (current) {
      renderTaskDetail(current);
      if (current.channelSequence !== selected?.channelSequence)
        loadChannel(current.id).catch(notice);
    }
  } finally {
    taskListing = false;
    renderTaskControls();
  }
}
function renderTaskList() {
  $("task-list").replaceChildren();
  for (const task of taskRows.values()) {
    const button = node("button", undefined, "task-row secondary");
    button.dataset.id = task.id;
    button.setAttribute("aria-pressed", String(task.id === selectedTaskId));
    button.append(
      node("strong", task.objective),
      node(
        "span",
        `${{ foreground: "前台目标", background: "后台任务", scheduled: "定时任务" }[task.mode]} · ${taskStatus(task)}`,
        "muted",
      ),
    );
    button.disabled = !connected;
    button.onclick = () => selectTask(task.id).catch(notice);
    $("task-list").append(button);
  }
  if (!taskRows.size)
    $("task-list").append(node("p", "还没有任务。创建后可在这里查看进度。", "muted"));
}
function receiveTask(task, draw = true) {
  if (!task) return;
  if ((taskRows.get(task.id)?.revision ?? -1) > task.revision) return;
  const previous = taskRows.get(task.id);
  taskRows.set(task.id, task);
  if (!draw) return;
  renderTaskList();
  if (task.id === selectedTaskId) {
    renderTaskDetail(task);
    if (!previous || previous.channelSequence !== task.channelSequence)
      loadChannel(task.id).catch(notice);
  }
}
async function selectTask(id) {
  const previous = selectedTaskId,
    observation = ++taskObservation;
  selectedTaskId = id;
  if (previous && previous !== id) await call("areal/task/unsubscribe", { taskId: previous });
  const task = await call("areal/task/subscribe", { taskId: id });
  if (observation !== taskObservation) {
    if (selectedTaskId !== id) await call("areal/task/unsubscribe", { taskId: id });
    return;
  }
  receiveTask(task);
  await loadChannel(id);
}
function renderTaskDetail(task) {
  const detail = $("task-detail"),
    run = task.runs.at(-1);
  detail.hidden = false;
  // 保留频道 DOM，避免用量更新清掉正在阅读的消息。
  const channel = document.getElementById("task-channel") ?? node("div");
  channel.id = "task-channel";
  detail.replaceChildren(node("h3", task.objective), node("p", taskStatus(task), "task-state"));
  if (task.nextRunAt)
    detail.append(
      node("p", `下次执行：${new Date(task.nextRunAt * 1000).toLocaleString()}`, "muted"),
    );
  if (run) {
    detail.append(
      node(
        "p",
        `${task.runs.length} 次执行 · ${run.usage.turnsStarted} 轮 · ${run.usage.tokensUsed} tokens · ${run.workers.filter((w) => w.settled).length}/${run.workers.length} 个协作任务已结算`,
        "muted",
      ),
    );
    if (run.reason) detail.append(node("p", run.reason));
  }
  const actions = node("div", undefined, "goal-actions");
  const canResume = task.paused || ["paused", "blocked"].includes(run?.status);
  const terminal = !task.nextRunAt && run?.completedAt;
  const choices =
    task.cancelled || terminal
      ? []
      : canResume
        ? [
            ["resume", "恢复任务"],
            ["cancel", "取消任务"],
          ]
        : [
            ["pause", "暂停任务"],
            ["cancel", "取消任务"],
          ];
  for (const [action, label] of choices) {
    const button = node("button", label, "secondary");
    button.disabled = !connected;
    button.onclick = async () => {
      button.disabled = true;
      try {
        const latest = taskRows.get(task.id);
        receiveTask(
          await call(`areal/task/${action}`, {
            requestId: crypto.randomUUID(),
            taskId: task.id,
            expectedRevision: latest.revision,
          }),
        );
      } catch (error) {
        notice(error);
        try {
          receiveTask(await call("areal/task/read", { taskId: task.id }));
        } catch {
          /* 断线后由重连快照恢复。 */
        }
      }
    };
    actions.append(button);
  }
  if (run?.threadId) {
    const open = node("button", "查看执行会话", "secondary");
    open.disabled = !connected;
    open.onclick = () => select(run.threadId).catch(notice);
    actions.append(open);
  }
  detail.append(actions, node("h4", "任务频道"), channel);
}
async function loadChannel(id) {
  const observation = ++channelObservation;
  let afterSequence = 0,
    more = true;
  const messages = new Map();
  while (more && connected && selectedTaskId === id && observation === channelObservation) {
    const page = await call("areal/channel/read", { taskId: id, afterSequence, limit: 100 });
    for (const message of page.data) messages.set(message.id, message);
    afterSequence = page.nextSequence;
    more = page.hasMore;
  }
  if (selectedTaskId !== id || observation !== channelObservation) return;
  const channel = document.getElementById("task-channel");
  if (!channel) return;
  channel.replaceChildren();
  for (const message of [...messages.values()].sort((a, b) => a.sequence - b.sequence)) {
    const card = node("article", undefined, "channel-message");
    card.append(
      node(
        "p",
        `${{ question: "问题", reply: "回复", workerReport: "协作结果", report: "执行结果" }[message.kind] ?? message.kind} · ${{ pending: "待回复", answered: "已回答", expired: "已过期", cancelled: "已取消", published: "已发布" }[message.status]}`,
        "muted",
      ),
    );
    for (const question of message.questions) card.append(node("p", question.title));
    if (message.text) card.append(node("p", message.text));
    if (message.answers)
      for (const answer of Object.values(message.answers)) card.append(node("p", answer));
    if (message.status === "pending") {
      const open = node("button", "前往收件箱回复", "secondary");
      open.onclick = openInbox;
      card.append(open);
    }
    channel.append(card);
  }
  if (!messages.size) channel.append(node("p", "执行结果、协作报告和回复会显示在这里。", "muted"));
}
$("tasks-refresh").onclick = () => listTasks().catch(notice);
$("tasks-more").onclick = () => listTasks(true).catch(notice);
$("task-create-form").onsubmit = async (event) => {
  event.preventDefault();
  if (taskCreating || !connected) return;
  const params = {
    mode: $("task-mode").value,
    objective: $("task-objective").value.trim(),
    interactionMode: $("task-interaction").value,
  };
  if (!params.objective) return;
  if ($("task-budget").value) params.tokenBudget = Number($("task-budget").value);
  if (params.mode === "scheduled") {
    const at = Math.floor(new Date($("task-at").value).getTime() / 1000);
    if (!thread || !Number.isFinite(at) || at < Math.floor(Date.now() / 1000)) {
      $("task-create-status").textContent = "请选择执行会话，并填写未来的执行时间。";
      return;
    }
    params.threadId = thread.id;
    params.schedule = { at };
    if ($("task-interval").value)
      params.schedule.intervalSeconds = Number($("task-interval").value);
  }
  const fingerprint = JSON.stringify(params);
  if (taskCreateAttempt?.fingerprint !== fingerprint)
    taskCreateAttempt = { fingerprint, requestId: crypto.randomUUID() };
  taskCreating = true;
  renderTaskControls();
  try {
    const created = await call("areal/task/create", {
      ...params,
      requestId: taskCreateAttempt.requestId,
    });
    taskCreateAttempt = null;
    $("task-create-status").textContent =
      params.mode === "scheduled" ? "已添加，等待计划时间。" : "任务已受理。";
    $("task-objective").value = "";
    await listTasks();
    await selectTask(created.id);
  } catch (error) {
    $("task-create-status").textContent = error.message;
  } finally {
    taskCreating = false;
    renderTaskControls();
  }
};
async function openInbox() {
  $("inbox-dialog").showModal();
  await loadInbox().catch((error) => {
    $("inbox-notice").textContent = error.message;
  });
}
$("inbox-open").onclick = openInbox;
$("inbox-close").onclick = () => $("inbox-dialog").close();
$("inbox-refresh").onclick = () =>
  loadInbox().catch((error) => {
    $("inbox-notice").textContent = error.message;
  });
$("inbox-more").onclick = () =>
  loadInbox(true).catch((error) => {
    $("inbox-notice").textContent = error.message;
  });
async function loadInbox(more = false) {
  if (!tasksSupported || !connected || inboxLoading) return;
  inboxLoading = true;
  renderTaskControls();
  try {
    const page = await call("areal/inbox/list", {
      limit: 30,
      ...(more ? { after: inboxCursor } : {}),
    });
    if (!more) inboxRows.clear();
    for (const row of page.data) inboxRows.set(`${row.taskId}/${row.message.id}`, row);
    inboxCursor = page.nextCursor;
    $("inbox-more").hidden = !inboxCursor;
    $("inbox-open").querySelector("span").textContent =
      `收件箱${inboxRows.size ? ` · ${inboxRows.size}${inboxCursor ? "+" : ""}` : ""}`;
    renderInbox();
  } finally {
    inboxLoading = false;
    renderTaskControls();
  }
}
function renderInbox() {
  const list = $("inbox-list");
  // 按消息 ID 复用表单，刷新和任务更新不丢失用户正在填写的答案。
  const existing = new Map([...list.children].map((form) => [form.dataset.key, form]));
  const forms = [];
  for (const [key, { taskId, objective, message }] of inboxRows) {
    if (existing.has(key)) {
      forms.push(existing.get(key));
      continue;
    }
    const draft = inboxDrafts.get(key) ?? { answers: {}, attempt: null };
    inboxDrafts.set(key, draft);
    const form = node("form", undefined, "task-card");
    form.dataset.key = key;
    form.append(node("h3", objective));
    if (message.expiresAt)
      form.append(
        node("p", `回复期限：${new Date(message.expiresAt * 1000).toLocaleString()}`, "muted"),
      );
    const fields = new Map();
    for (const [index, question] of message.questions.entries()) {
      const id = `inbox-${message.id}-${index}`;
      const label = node("label", question.title);
      label.setAttribute("for", id);
      const input = node(question.allowFreeText ? "input" : "select");
      input.id = id;
      input.required = true;
      if (question.allowFreeText) {
        input.maxLength = 4096;
        if (question.options.length) input.placeholder = question.options.join(" / ");
      } else {
        const placeholder = node("option", "请选择");
        placeholder.value = "";
        input.append(placeholder);
        for (const value of question.options) {
          const option = node("option", value);
          option.value = value;
          input.append(option);
        }
      }
      input.value = draft.answers[question.id] ?? "";
      input.oninput = () => {
        draft.answers[question.id] = input.value;
      };
      fields.set(question.id, input);
      form.append(label, input);
    }
    const submit = node("button", "发送回复"),
      status = node("p");
    submit.type = "submit";
    status.setAttribute("role", "status");
    form.append(submit, status);
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!connected || form.dataset.sending === "true") return;
      const answers = Object.fromEntries(
        [...fields].map(([id, input]) => [id, input.value.trim()]),
      );
      const fingerprint = JSON.stringify(answers);
      if (draft.attempt?.fingerprint !== fingerprint)
        draft.attempt = { fingerprint, requestId: crypto.randomUUID() };
      form.dataset.sending = "true";
      submit.disabled = true;
      try {
        await call("areal/channel/reply", {
          requestId: draft.attempt.requestId,
          taskId,
          runId: message.runId,
          questionId: message.id,
          answers,
        });
        inboxRows.delete(key);
        inboxDrafts.delete(key);
        $("inbox-notice").textContent = "回复已送达，任务会根据当前状态继续推进。";
        renderInbox();
        await loadInbox();
      } catch (error) {
        status.textContent =
          error.code === -32009 ? "问题已回答、已过期或任务已结束，请刷新收件箱。" : error.message;
      } finally {
        form.dataset.sending = "false";
        submit.disabled = !connected;
      }
    };
    forms.push(form);
  }
  list.replaceChildren(...forms);
  if (!forms.length) list.append(node("p", "没有待回答的问题。", "muted"));
}
setInterval(() => {
  if (connected && tasksSupported) {
    if (!$("inbox-dialog").open) loadInbox().catch(() => {});
    if (!$("task-center").hidden) listTasks().catch(notice);
  }
}, 5000);
