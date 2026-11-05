import { createRemoteWorkbench } from "../src/remote/RemoteWorkbench.tsx";
import { sharedUiEnabled } from "../src/shared-ui-flag.ts";
import {
  SessionBodyReader,
  CommandState,
  acceptSessionMessage,
  RemoteConnection,
} from "@areal/remote-client";
const sessionBodies = new SessionBodyReader();
import { remoteLocator, publicLocator } from "@areal/remote/wire";
import { ResultReviewView } from "./result-review.mjs";
import { BrowserState } from "./browser-state.mjs";
import { browserDeviceName } from "./device-name.mjs";
import { createIdentity, identityId } from "@areal/remote";

const status = document.getElementById("status");
const device = document.getElementById("device");
const host = document.getElementById("host");
const projects = document.getElementById("projects");
const connect = document.getElementById("connect");
const workItems = document.getElementById("work-items");
const workCount = document.getElementById("work-count");
const workError = document.getElementById("work-error");
const filter = document.getElementById("work-filter");
const refreshButton = document.getElementById("work-refresh");
const moreButton = document.getElementById("work-more");
const fragment = new URLSearchParams(location.hash.slice(1));
let expectedHost = fragment.get("host");
let inviteSecret = fragment.get("invite");
fragment.delete("invite");
let relayRoom = null,
  locatorError = null;
try {
  ({ room: relayRoom } = remoteLocator(fragment));
  const locator = publicLocator({ host: expectedHost, room: relayRoom });
  history.replaceState(null, "", location.pathname + (locator ? `#${locator}` : ""));
} catch (error) {
  locatorError = error;
  expectedHost = null;
  inviteSecret = null;
  history.replaceState(null, "", location.pathname);
}
const rememberChoice = document.getElementById("remember-device");
const forgetButton = document.getElementById("forget-device");
const draftChoice = document.getElementById("remember-drafts");
const storageStatus = document.getElementById("device-storage");
const storageError = document.getElementById("storage-error");
const updateStatus = document.getElementById("update-status");
const browserState = new BrowserState({
  createIdentity,
  identityId,
  onInvalidate: browserInvalidated,
});
let browserLoaded = false,
  pinConflict = false,
  connecting = false,
  connectionAttempt = 0;
let reconnectEnabled = false,
  reconnectAttempt = 0,
  reconnectTimer,
  rejectActive;
let activeSocket, request, pollTimer, selectedProject, nextCursor;
let detail,
  detailTarget,
  detailEpoch = 0,
  connectionIdentity;
const commandState = new CommandState();
let resultReview, resultReviewContainer;
let remoteUI,
  projectCatalog = [],
  projectGroups = {},
  displayedTurns;
let taskPause,
  taskPauseTarget,
  taskPauseEpoch = 0;
let attention,
  attentionTarget,
  attentionEpoch = 0,
  attentionBusy = false;
let view = 0,
  busy = false,
  refreshQueued = false,
  serviceGeneration,
  rows = [];
function text(tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  return element;
}
// Presentation follows existing connection events; it never admits requests or restores work.
function connectionPhase(phase) {
  document.body.dataset.connection = phase;
  const connected = phase === "connected";
  const settings = document.getElementById("connection-details");
  settings.open = !connected;
  document.getElementById("project-section").hidden = !connected;
  document.getElementById("work-overview").hidden = !connected;
  document.getElementById("pairing-instructions").hidden = phase !== "pairing";
  document.getElementById("connection-title").textContent =
    phase === "pairing"
      ? "请回到电脑确认"
      : phase === "connecting"
        ? "正在连接电脑"
        : "连接到你的电脑";
  document.getElementById("connection-help").textContent =
    phase === "pairing"
      ? "这台浏览器正在申请访问。邀请自生成起两分钟内有效，过期后请重新生成。"
      : phase === "connecting"
        ? "正在核对电脑身份，请稍候。"
        : "在电脑的「设置 → 手机连接」生成配对链接，再在这里打开。";
}
function clearWork() {
  resultReview?.close();
  invalidateTaskPause();
  invalidateAttention();
  view++;
  rows = [];
  nextCursor = null;
  busy = false;
  refreshQueued = false;
  serviceGeneration = undefined;
  workItems.replaceChildren();
  workCount.textContent = "";
  workError.textContent = "";
  moreButton.hidden = true;
  refreshButton.disabled = !request;
  renderCommandControls();
}
function renderWork(complete) {
  projectGroups[selectedProject] = { rows: [...rows], hasMore: !!nextCursor };
  workItems.replaceChildren();
  workCount.textContent = `已加载 ${rows.length} 项；${complete ? "本次扫描已完整" : "尚未加载完整"}。`;
  moreButton.hidden = !nextCursor;
  renderCommandControls();
}
async function refreshWork(append = false) {
  if (!request || !selectedProject || document.hidden) return;
  if (busy) {
    if (!append) refreshQueued = true;
    return;
  }
  const current = view,
    call = request,
    projectId = selectedProject;
  busy = true;
  refreshButton.disabled = true;
  moreButton.disabled = true;
  workError.textContent = "";
  try {
    const page = await call({
      method: "work.list",
      context: { projectId },
      params: {
        filter: filter.value,
        ...(append && nextCursor ? { cursor: nextCursor } : {}),
      },
    });
    if (view !== current || request !== call) return;
    if (append && serviceGeneration !== undefined && serviceGeneration !== page.serviceGeneration)
      throw new Error("Core 已换代，请刷新概览");
    serviceGeneration = page.serviceGeneration;
    const data = append ? [...rows, ...page.data] : page.data;
    // 分页不是一致事务；同一原生身份更新卡片而不重复追加。
    rows = [
      ...new Map(
        data.map((row) => [
          row.kind === "taskRun" ? `${row.taskId}/${row.runId}` : row.threadId,
          row,
        ]),
      ).values(),
    ];
    nextCursor = page.nextCursor;
    renderWork(page.complete);
  } catch (error) {
    if (view !== current || request !== call) return;
    rows = [];
    nextCursor = null;
    workItems.replaceChildren();
    workCount.textContent = "";
    moreButton.hidden = true;
    workError.textContent = `${error.code ?? "CORE_UNAVAILABLE"}：${error.message}`;
    projectGroups[projectId] = { rows: [], hasMore: false, error: workError.textContent };
  } finally {
    if (view === current) {
      busy = false;
      refreshButton.disabled = !request;
      moreButton.disabled = false;
      if (refreshQueued) {
        refreshQueued = false;
        void refreshWork();
      }
    }
  }
}
function polling() {
  clearInterval(pollTimer);
  pollTimer = null;
  if (request && !document.hidden) pollTimer = setInterval(() => void refreshWork(), 5000);
}
document.addEventListener("visibilitychange", () => {
  polling();
  if (document.hidden) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  } else if (reconnectEnabled) void connectHost(true);
});
// 操作完成方只发布完成事件；概览仍从 Core 重新读取，不推测操作改变了执行状态。
window.addEventListener("remote-operation-complete", () => void refreshWork());
refreshButton.addEventListener("click", () => void refreshWork());
moreButton.addEventListener("click", () => void refreshWork(true));
filter.addEventListener("change", () => {
  clearWork();
  void refreshWork();
});

async function loadProjects(call) {
  const all = [];
  let cursor;
  do {
    const page = await call(
      cursor
        ? { method: "project.list", params: { cursor } }
        : { method: "project.list", params: {} },
    );
    if (request !== call) return;
    all.push(...page.projects);
    cursor = page.nextCursor;
  } while (cursor);
  projectCatalog = all;
  projectGroups = {};
  projects.replaceChildren(
    ...all.map((project) => {
      const row = document.createElement("li");
      const button = text("button", `${project.name}（${project.connectionState}）`);
      button.type = "button";
      button.dataset.projectId = project.projectId;
      button.setAttribute("aria-pressed", String(project.projectId === selectedProject));
      button.addEventListener("click", () => {
        closeSession();
        selectedProject = project.projectId;
        for (const item of projects.querySelectorAll("button"))
          item.setAttribute("aria-pressed", String(item.dataset.projectId === selectedProject));
        clearWork();
        void refreshWork();
      });
      row.append(button);
      return row;
    }),
  );
  selectedProject =
    all.find((value) => value.projectId === selectedProject)?.projectId ?? all[0]?.projectId;
  for (const item of projects.querySelectorAll("button"))
    item.setAttribute("aria-pressed", String(item.dataset.projectId === selectedProject));
  clearWork();
  await refreshWork();
  polling();
  if (detailTarget && detailTarget.projectId === selectedProject)
    void openSession(detailTarget.threadId);
}

document.getElementById("paste").addEventListener("click", () => {
  const input = document.getElementById("invitation");
  const value = input.value;
  input.value = "";
  try {
    const invitation = new URL(value);
    const parts = new URLSearchParams(invitation.hash.slice(1));
    if (
      invitation.origin !== location.origin ||
      !parts.get("host") ||
      !/^[a-f0-9]{64}$/.test(parts.get("invite") ?? "")
    )
      throw new Error("请粘贴此 Host 的有效配对链接");
    if (browserState.current() && expectedHost && parts.get("host") !== expectedHost)
      throw new Error("切换 Host 前请先清除此浏览器设备，再重新打开配对链接");
    const locator = remoteLocator(parts);
    reconnectEnabled = false;
    stopConnection("邀请已载入，请连接 Host");
    expectedHost = locator.host;
    relayRoom = locator.room;
    locatorError = null;
    inviteSecret = parts.get("invite");
    history.replaceState(null, "", location.pathname + "#" + publicLocator(locator));
    status.textContent = "邀请已载入，请连接 Host";
  } catch (error) {
    status.textContent = error.message;
  }
});

function renderDeviceStorage() {
  const token = browserState.current();
  rememberChoice.checked =
    token?.mode === "remembered" ||
    token?.mode === "remembering" ||
    (!token && rememberChoice.checked);
  rememberChoice.disabled = !browserLoaded || connecting || Boolean(token);
  draftChoice.disabled = token?.mode !== "remembered";
  device.textContent = token?.peerId ?? "";
  document.getElementById("device-verification").hidden = !token;
  storageStatus.textContent =
    token?.mode === "remembered"
      ? "已记住此设备，仅当前站点可恢复。清除站点数据后需要重新配对。"
      : token?.mode === "remembering"
        ? "已选择记住；验证 Host 并完成配对后才保存。"
        : "仅本次使用：身份与命令只在当前页面内存，刷新后需要重新配对。";
}
function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (
    !reconnectEnabled ||
    connecting ||
    document.hidden ||
    navigator.onLine === false ||
    !expectedHost ||
    pinConflict
  )
    return;
  const base = Math.min(30000, 500 * 2 ** Math.min(reconnectAttempt++, 6));
  const delay = Math.min(30000, base * (1 + Math.random() * 0.2));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectHost(true);
  }, delay);
}
// A4 共享界面：开关打开时，连上后改由与桌面同一份界面经这条连接读写，旧页面只负责配对与重连。
const sharedUi = sharedUiEnabled();
const paired = {
  state: { kind: "connecting" },
  /** @type {any} */ connection: null,
  onSession: (/** @type {unknown} */ _message) => {},
  listeners: new Set(),
  mounted: false,
  snapshot() {
    return this.state;
  },
  subscribe(/** @type {() => void} */ listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  request(/** @type {Record<string, unknown>} */ envelope) {
    if (!this.connection) return Promise.reject(new Error("OFFLINE"));
    return this.connection.request(envelope);
  },
  set(/** @type {string} */ kind, /** @type {any} */ connection) {
    this.state = { kind };
    this.connection = connection;
    for (const listener of this.listeners) listener();
  },
};
async function showSharedUi(connection) {
  paired.set("connected", connection);
  document.querySelector("main").hidden = true;
  if (paired.mounted) return;
  paired.mounted = true;
  const root = document.createElement("div");
  root.id = "shared-root";
  document.body.append(root);
  const { mountSharedPairedWorkbench } = await import("../src/SharedPairedWorkbench.tsx");
  mountSharedPairedWorkbench(root, paired);
}
function stopConnection(message, retry = false) {
  if (sharedUi && paired.connection) {
    paired.set("offline", null);
    document.querySelector("main").hidden = false;
  }
  connectionAttempt++;
  connecting = false;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const socket = activeSocket;
  activeSocket = null;
  request = null;
  connectionIdentity = null;
  rejectActive?.();
  rejectActive = null;
  socket?.close();
  for (const command of commandState.commands.values())
    if (commandState.unresolved(command)) {
      command.admissionState = "unknown";
      command.submissionUnknown = true;
    }
  invalidateDetail(message);
  polling();
  clearWork();
  host.textContent = "";
  projects.replaceChildren();
  status.textContent = message;
  document.getElementById("connection-protocol").textContent = "";
  connectionPhase("disconnected");
  connect.disabled = !browserLoaded || pinConflict;
  renderDeviceStorage();
  if (retry) scheduleReconnect();
}
function clearBrowserView(message) {
  reconnectEnabled = false;
  selectedProject = undefined;
  detailTarget = null;
  attentionTarget = null;
  expectedHost = null;
  inviteSecret = null;
  pinConflict = false;
  commandState.commands.clear();
  commandState.drafts.clear();
  draftInput.value = "";
  draftChoice.checked = false;
  rememberChoice.checked = false;
  stopConnection(message);
}
function browserInvalidated(error) {
  clearBrowserView(`设备状态已变化，已停止此页面连接：${error.message}`);
  storageError.textContent = "请重新打开配对链接或恢复当前站点的设备；旧页面不会重新写入身份。";
}
forgetButton.addEventListener("click", async () => {
  forgetButton.disabled = true;
  const forgetting = browserState.forget();
  clearBrowserView("正在清除此浏览器设备");
  storageError.textContent = "";
  try {
    await forgetting;
    status.textContent = "已清除此浏览器设备；Host 授权需在桌面另行撤销。请重新打开配对链接。";
  } catch (error) {
    storageError.textContent = `本页面已停止使用身份，但未能确认本地清除：${error.message}。请清除此站点数据后重新配对。`;
    status.textContent = "本地清除未完成";
  } finally {
    forgetButton.disabled = false;
    renderDeviceStorage();
  }
});
async function initializeBrowser() {
  connect.disabled = true;
  rememberChoice.disabled = true;
  const attempt = connectionAttempt;
  try {
    const token = await browserState.restore();
    if (attempt !== connectionAttempt) return false;
    if (token) {
      if (expectedHost && expectedHost !== token.hostId) {
        pinConflict = true;
        status.textContent =
          "配对链接的 Host 与已记住的身份绑定不同；请先清除此浏览器设备，再重新打开链接。";
      } else {
        if (!expectedHost) relayRoom = token.relayRoom ?? null;
        expectedHost = token.hostId;
        inviteSecret = null;
        const locators = await browserState.locators(token);
        browserState.assertCurrent(token);
        if (attempt !== connectionAttempt) return false;
        for (const command of locators)
          commandState.commands.set(restoredCommandKey(command), command);
        try {
          const drafts = browserState.drafts(token);
          draftChoice.checked = drafts.enabled;
          for (const draft of drafts.values)
            commandState.drafts.set(
              commandState.key(token.hostId, draft.projectId, draft.threadId),
              draft.text,
            );
        } catch (error) {
          draftChoice.checked = false;
          storageError.textContent = `未恢复本标签草稿：${error.message}`;
        }
      }
    }
    return Boolean(token && !pinConflict);
  } catch (error) {
    if (attempt !== connectionAttempt) return false;
    browserState.invalidate();
    commandState.commands.clear();
    storageError.textContent = `无法恢复已保存设备：${error.message}。仅本次使用不会保存身份。`;
    return false;
  } finally {
    browserLoaded = true;
    connect.disabled = pinConflict;
    renderDeviceStorage();
    renderCommandControls();
  }
}
async function connectHost(automatic = false) {
  await browserLoading;
  if (
    connecting ||
    pinConflict ||
    (automatic && (!reconnectEnabled || document.hidden || navigator.onLine === false))
  )
    return;
  reconnectEnabled = true;
  stopConnection("正在重连，旧基线已清除");
  connecting = true;
  connectionPhase("connecting");
  connect.disabled = true;
  rememberChoice.disabled = true;
  const attempt = connectionAttempt;
  // 定位与邀请属于本次尝试，不能被握手期间粘贴的新链接替换。
  const target = { host: expectedHost, room: relayRoom, invite: inviteSecret, error: locatorError };
  let token = browserState.current(),
    socket,
    connection;
  const current = () => attempt === connectionAttempt && browserState.current() === token;
  const check = () => {
    if (!current()) throw new Error("此连接尝试已失效");
  };
  try {
    token ??= await browserState.guest();
    if (attempt !== connectionAttempt) return;
    if (rememberChoice.checked && token.mode === "guest")
      token = await browserState.prepareRemember(token);
    check();
    await browserState.revalidate(token);
    check();
    if (target.error) throw target.error;
    if (!target.host)
      throw Object.assign(new Error("缺少 Host 身份；请从桌面提供的连接链接打开"), {
        code: "HOST_REQUIRED",
      });
    if (token.mode === "remembered" && token.hostId !== target.host)
      throw Object.assign(new Error("Host 与已记住的身份绑定不同"), { code: "HOST_MISMATCH" });
    renderDeviceStorage();
    status.textContent = "正在验证 Host 身份";
    socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/remote/socket`,
    );
    activeSocket = socket;
    connection = new RemoteConnection({
      socket,
      identity: token.identity,
      host: target.host,
      room: target.room,
      hello: {
        displayName: browserDeviceName(navigator.userAgent, navigator.maxTouchPoints),
        ...(sharedUi ? { capabilities: ["gui-read-v1", "gui-write-v1"] } : {}),
        ...(target.invite ? { inviteSecret: target.invite } : {}),
      },
      isCurrent: () => activeSocket === socket && current(),
      onClose: () => {
        if (activeSocket === socket && current())
          stopConnection("Host 已断开；任务状态未知，恢复后只核对原命令", true);
      },
    });
    rejectActive = () => connection.rejectPending();
    connectionIdentity = await connection.connect({
      onHandshake: (event) => {
        if (event === "hello") {
          inviteSecret = null;
          return;
        }
        status.textContent = "等待桌面确认；请核对设备指纹并选择项目";
        connectionPhase("pairing");
      },
      onReady: async () => {
        if (
          token.mode === "remembering" ||
          (token.mode === "remembered" && token.relayRoom !== target.room)
        )
          token = await browserState.remember(token, target.host, target.room);
        check();
        await browserState.revalidate(token);
        check();
      },
      onSession: (message) => (sharedUi ? paired.onSession(message) : sessionEvent(message)),
    });
    const connected = connectionIdentity;
    host.textContent = connected.hostId;
    status.textContent = `已连接电脑 · ${connected.capabilities.includes("submit") ? "可操作" : "仅查看"}`;
    document.getElementById("connection-protocol").textContent =
      `能力：${connected.capabilities.join("、")}；消息上限：${connected.limits.applicationMessageBytes} 字节`;
    connectionPhase("connected");
    connecting = false;
    reconnectAttempt = 0;
    renderDeviceStorage();
    if (sharedUi) {
      await showSharedUi(connection);
      return;
    }
    const call = (request = (envelope, onResult) => connection.request(envelope, onResult));
    await loadProjects(call);
    check();
    if (attentionTarget?.projectId === selectedProject) void readAttention();
    void recoverCommands();
  } catch (error) {
    connection?.rejectPending();
    if (attempt !== connectionAttempt) {
      socket?.close();
      return;
    }
    const permanent = [
      "HOST_REQUIRED",
      "HOST_MISMATCH",
      "FORBIDDEN",
      "PAIRING_EXPIRED",
      "PAIRING_USED",
      "PROTOCOL_UNSUPPORTED",
      "CORE_INCOMPATIBLE",
    ].includes(error.code);
    if (permanent) reconnectEnabled = false;
    if (error.code === "PROTOCOL_UNSUPPORTED")
      updateStatus.textContent =
        "协议版本不兼容。请关闭所有 Remote 标签后重新打开以更新；不会降级协议。";
    stopConnection(`${error.code ? error.code + "：" : ""}${error.message}`, !permanent);
    if (token?.mode === "remembering")
      storageError.textContent =
        "设备尚未记住；请检查本站存储后重新连接，或清除此页面身份改用仅本次使用。";
  }
}
connect.addEventListener("click", () => connectHost());
window.addEventListener("online", () => {
  if (reconnectEnabled && !document.hidden) void connectHost(true);
});
window.addEventListener("offline", () =>
  stopConnection("网络不可用；未确认提交仅在恢复后核对", true),
);
window.addEventListener("pagehide", () => stopConnection("页面已挂起；恢复后重新验证连接"));
window.addEventListener("pageshow", (event) => {
  if (event.persisted && reconnectEnabled) void connectHost(true);
});

const sessionPanel = document.getElementById("session");
const sessionContent = document.getElementById("session-content");
const sessionError = document.getElementById("session-error");
const historyButton = document.getElementById("session-history");
function invalidateDetail(message = "") {
  sessionBodies.clear();
  resultReview?.close();
  detailEpoch++;
  detail = null;
  sessionContent.replaceChildren();
  historyButton.hidden = true;
  for (const id of ["session-state", "session-attention", "session-range"])
    document.getElementById(id).textContent = "";
  sessionError.textContent = message;
  displayedTurns = undefined;
  sessionPanel.hidden = !detailTarget;
  document.body.dataset.detail = detailTarget ? "open" : "closed";
  document.getElementById("session-summary").textContent = "";
  renderCommandControls();
}
function releaseSession(previous, call) {
  if (previous && call)
    void call({
      method: "subscription.close",
      context: { projectId: previous.projectId },
      params: { subscriptionId: previous.subscriptionId },
    }).catch(() => {});
}
function closeSession() {
  const previous = detail;
  detailTarget = null;
  invalidateDetail();
  releaseSession(previous, request);
}
function renderSession(turns = detail?.snapshot.turns ?? []) {
  displayedTurns = turns;
  sessionBodies.update(detail, turns, request, renderGUI);
  const state = detail.snapshot;
  sessionPanel.hidden = false;
  document.body.dataset.detail = "open";
  document
    .getElementById("session-attention")
    .replaceChildren(...state.attentionRefs.map(attentionSummary));
  historyButton.hidden = !state.history.hasMore;
  renderCommandControls();
}
async function openSession(threadId) {
  if (!request || !selectedProject) return;
  detailTarget = { projectId: selectedProject, threadId };
  invalidateDetail("正在读取会话");
  const epoch = detailEpoch,
    call = request,
    projectId = selectedProject;
  try {
    await call(
      { method: "session.open", context: { projectId }, params: { threadId } },
      (value) => {
        if (epoch !== detailEpoch || request !== call || selectedProject !== projectId) {
          // 关闭/切换发生在响应之前时，仍需释放原连接返回的那一个订阅。
          releaseSession(value, call);
          return;
        }
        if (
          value.connectionId !== connectionIdentity.connectionId ||
          value.gatewayGeneration !== connectionIdentity.gatewayGeneration ||
          value.projectId !== projectId ||
          value.snapshot?.threadId !== threadId ||
          value.sequence !== 0
        )
          throw new Error("会话身份不匹配，请重新打开");
        detail = value;
        sessionError.textContent = "";
        renderSession();
      },
    );
  } catch (error) {
    if (epoch === detailEpoch) {
      invalidateDetail(`${error.code ?? "CORE_UNAVAILABLE"}：${error.message}`);
    }
  }
}
function sessionEvent(message) {
  const result = acceptSessionMessage(detail, message);
  if (result.kind === "ignore") return;
  if (result.kind === "resync") {
    const target = detailTarget;
    invalidateDetail("流有缺口，正在替换基线");
    if (target) void openSession(target.threadId);
    return;
  }
  if (result.kind === "unavailable") {
    invalidateDetail(`${result.error.code}：${result.error.message}`);
    return;
  }
  detail = result.value;
  renderSession();
}
document.getElementById("session-close").addEventListener("click", closeSession);
document.getElementById("session-refresh").addEventListener("click", () => {
  if (detailTarget) void openSession(detailTarget.threadId);
});
historyButton.addEventListener("click", async () => {
  if (!detail?.snapshot.history.nextCursor || !request) return;
  const current = detail,
    epoch = detailEpoch,
    call = request;
  historyButton.disabled = true;
  try {
    await call(
      {
        method: "session.history",
        context: { projectId: current.projectId },
        params: {
          threadId: current.snapshot.threadId,
          cursor: current.snapshot.history.nextCursor,
        },
      },
      (page) => {
        if (
          epoch !== detailEpoch ||
          request !== call ||
          !detail ||
          [
            "connectionId",
            "gatewayGeneration",
            "serviceGeneration",
            "subscriptionId",
            "projectId",
          ].some((key) => detail[key] !== page[key])
        )
          return;
        // 一次只显示一页；不在浏览器累积第二套无界历史。
        detail.snapshot.history = { ...page, turns: undefined };
        renderSession(page.turns);
      },
    );
  } catch (error) {
    if (epoch === detailEpoch)
      sessionError.textContent = `${error.code ?? "CORE_UNAVAILABLE"}：${error.message}`;
  } finally {
    historyButton.disabled = false;
  }
});

const createButton = document.getElementById("session-create");
const createQuery = document.getElementById("create-query");
const sendButton = document.getElementById("session-send");
const sendQuery = document.getElementById("send-query");
const stopButton = document.getElementById("turn-stop");
const stopQuery = document.getElementById("stop-query");
const draftInput = document.getElementById("session-draft");
function commandKey(threadId = "", projectId = selectedProject) {
  return commandState.key(expectedHost, projectId, threadId);
}
function stopKey(threadId, turnId) {
  return `${commandKey(threadId)}:stop:${JSON.stringify(turnId)}`;
}
function lastStop() {
  return [...commandState.commands.values()]
    .reverse()
    .find(
      (command) =>
        command.method === "turn.stop" &&
        command.hostId === expectedHost &&
        command.projectId === selectedProject &&
        command.params.threadId === detail?.snapshot.threadId,
    );
}
function stopObservation(command, state) {
  const turn = state?.turns?.find((turn) => turn.id === command.params.expectedTurnId);
  if (!turn) return "原 Turn 状态不可用，请刷新会话；不能推断已停止";
  if (["completed", "interrupted", "failed"].includes(turn.status))
    return `观察到原 Turn 终态：${turn.status}（不证明本命令导致）`;
  return "等待原 Turn 结算（包括后台工具清理）";
}
function commandLabel(command) {
  if (!command) return "";
  const labels = {
    pending: "等待受理回应",
    accepted: "已受理（不代表执行完成）",
    rejected: "未受理，草稿已保留",
    unknown: "结果未知，仅查询，不自动重发",
    notFound: "暂未找到，不能据此认定未执行",
  };
  return `${labels[command.admissionState]} · commandId ${command.commandId}${command.nativeRequestId ? " · native " + command.nativeRequestId : ""}${command.error ? " · " + command.error.code + "：" + command.error.message : ""}`;
}
function renderCommandControls() {
  renderTaskPause();
  renderUnconfirmed();
  renderAttentionControls();
  const create = commandState.commands.get(commandKey());
  const send = detail && commandState.commands.get(commandKey(detail.snapshot.threadId));
  const canSubmit = request && connectionIdentity?.capabilities?.includes("submit");
  createButton.disabled =
    !canSubmit || !selectedProject || !serviceGeneration || commandState.unresolved(create);
  createQuery.disabled = !request || !commandState.unresolved(create);
  createButton.textContent =
    create?.admissionState === "rejected" ? "以新命令创建会话" : "新建会话";
  document.getElementById("create-command-state").textContent = commandLabel(create);
  const createSummary = document.getElementById("create-summary");
  const createMessages = {
    pending: "正在创建会话…",
    accepted: "会话已创建。",
    rejected: `创建失败：${create?.error?.message ?? "命令未受理，请核对详情后重试。"}`,
    unknown: "创建结果未确认，请展开下方「创建结果与核对」查询；不会自动重试。",
    notFound: "暂未找到创建结果，请继续核对；不能据此认定未创建。",
  };
  createSummary.textContent = create ? (createMessages[create.admissionState] ?? "") : "";
  createSummary.dataset.state = create?.admissionState ?? "";
  const state = detail?.snapshot;
  const key = state && commandKey(state.threadId);
  const stop = lastStop();
  const currentStop =
    state && commandState.commands.get(stopKey(state.threadId, state.activeTurnId));
  stopButton.disabled =
    !request ||
    !connectionIdentity?.capabilities?.includes("interrupt") ||
    !state ||
    state.ownership.kind !== "ordinary" ||
    !state.activeTurnId ||
    !state.turns.some((turn) => turn.id === state.activeTurnId && turn.status === "inProgress") ||
    Boolean(currentStop && currentStop.admissionState !== "rejected");
  stopQuery.disabled = !request || !commandState.unresolved(stop);
  document.getElementById("stop-command-state").textContent = stop
    ? `${commandLabel(stop)} · 原 Turn ${stop.params.expectedTurnId} · ${stopObservation(stop, state)}`
    : state && state.ownership.kind !== "ordinary"
      ? "此会话由 Task 管理，请使用明确的 Task 控制。"
      : "";
  draftInput.value = key ? (commandState.drafts.get(key) ?? "") : "";
  sendButton.disabled =
    !canSubmit ||
    !state ||
    state.ownership.kind !== "ordinary" ||
    (state.status !== "idle" && !state.activeTurnId) ||
    (!state.activeTurnId && state.queue.pendingCount) ||
    !Number.isSafeInteger(state.configRevision) ||
    commandState.unresolved(send) ||
    !draftInput.value.trim();
  sendButton.textContent = send?.admissionState === "rejected" ? "以新命令发送草稿" : "发送新消息";
  sendQuery.disabled = !request || !commandState.unresolved(send);
  document.getElementById("send-summary").textContent = send
    ? ({
        pending: "正在提交，请勿重复发送。",
        accepted: "消息已受理；完成状态见上方会话。",
        rejected: "消息未受理，草稿已保留。",
        unknown: "是否受理尚不确定，请展开操作详情核对；不会自动重发。",
        notFound: "暂未找到回执，请核对原操作；不能认定未执行。",
      }[send.admissionState] ?? "")
    : state?.ownership.kind !== "ordinary" && state
      ? "此会话由任务管理，请在待处理入口操作。"
      : "";
  document.getElementById("send-command-state").textContent =
    commandLabel(send) ||
    (state && state.ownership.kind !== "ordinary"
      ? "Task 管理的会话不能从此处发送；草稿会保留。"
      : "");
  renderGUI();
}
draftInput.addEventListener("input", () => {
  if (detail) {
    commandState.drafts.set(commandKey(detail.snapshot.threadId), draftInput.value);
    saveCurrentDraft(selectedProject, detail.snapshot.threadId);
  }
  renderCommandControls();
});
function commandCurrent(token, key, command) {
  return browserState.current() === token && commandState.commands.get(key) === command;
}
function saveCurrentDraft(projectId, threadId) {
  const token = browserState.current();
  if (token?.mode !== "remembered" || !draftChoice.checked) return;
  try {
    browserState.saveDraft(
      token,
      projectId,
      threadId,
      commandState.drafts.get(commandState.key(token.hostId, projectId, threadId)) ?? "",
    );
  } catch (error) {
    storageError.textContent = `草稿未能保存到本标签会话：${error.message}。当前页面草稿仍保留。`;
  }
}
async function receiveCommand(token, call, key, command, value) {
  if (
    !commandCurrent(token, key, command) ||
    request !== call ||
    value.commandId !== command.commandId
  )
    return false;
  if (token.mode === "remembered") {
    try {
      await browserState.settleLocator(token, command.commandId, value.admissionState);
    } catch (error) {
      // 本地存储失败不是 Host 拒绝，不能再按 rejected 删除已受理命令的定位信息。
      throw Object.assign(new Error(`本地命令核对记录未能收敛：${error.message}`), {
        code: "SUBMISSION_UNKNOWN",
        submissionUnknown: true,
      });
    }
  }
  if (!commandCurrent(token, key, command) || request !== call) return false;
  commandState.receive(key, command, value);
  if (command.method === "session.send" && value.admissionState === "accepted")
    saveCurrentDraft(command.projectId, command.params.threadId);
  return true;
}
async function transmitCommand(key, command, capture) {
  const { token, call, connected, envelope, targetCurrent } = capture;
  let persisted = false,
    dispatched = false;
  try {
    if (!["guest", "remembered"].includes(token.mode)) throw new Error("设备身份尚未完成保存");
    if (token.mode === "remembered") {
      await browserState.persistLocator(token, command);
      persisted = true;
    }
    browserState.assertCurrent(token);
    if (request !== call || connectionIdentity !== connected || !targetCurrent())
      throw Object.assign(new Error("页面或连接已变化，本次未发送；请重新确认原目标"), {
        code: "LOCAL_NOT_SENT",
      });
    dispatched = true;
    const value = await call(envelope);
    return (await receiveCommand(token, call, key, command, value)) ? value : undefined;
  } catch (error) {
    if (!commandCurrent(token, key, command) || (dispatched && request !== call)) return;
    if (error.code === "BROWSER_COMMAND_PENDING" && error.locator) {
      commandState.commands.set(key, error.locator);
      return;
    }
    let failure = dispatched
      ? error
      : Object.assign(new Error(`本次未发送：${error.message}`), { code: "LOCAL_NOT_SENT" });
    if (!commandState.failureIsUnknown(failure) && persisted) {
      try {
        await browserState.settleLocator(token, command.commandId, "rejected");
      } catch (storageFailure) {
        failure = Object.assign(new Error(`本地命令核对记录未能收敛：${storageFailure.message}`), {
          code: "SUBMISSION_UNKNOWN",
          submissionUnknown: true,
        });
      }
    }
    if (commandCurrent(token, key, command)) {
      commandState.failed(key, command, failure);
      if (!dispatched || failure.code === "SUBMISSION_UNKNOWN")
        storageError.textContent = failure.message;
      throw failure;
    }
  }
}
function renderUnconfirmed() {
  const list = document.getElementById("unconfirmed-commands");
  const commands = [...commandState.commands].filter(
    ([, command]) => commandState.unresolved(command) && command.admissionState !== "pending",
  );
  document.getElementById("unconfirmed").hidden = commands.length === 0;
  list.replaceChildren(
    ...commands.map(([key, command]) => {
      const item = text(
        "li",
        `${command.method} · Project ${command.projectId}${command.params.threadId ? " · Thread " + command.params.threadId : ""}${command.params.taskId ? ` · Task ${command.params.taskId} / Run ${command.params.expectedRunId ?? command.params.runId}${command.params.questionId ? " / 问题 " + command.params.questionId : ""}` : ""} · ${commandLabel(command)} `,
      );
      const query = text("button", "核对原命令");
      query.type = "button";
      query.disabled = !request;
      query.addEventListener("click", () => void queryCommand(key, command));
      item.append(query);
      return item;
    }),
  );
}

async function issueCommand(method, extra = {}) {
  if (!request || !selectedProject) return;
  const call = request,
    projectId = selectedProject,
    originalDetail = detail,
    state = detail?.snapshot,
    token = browserState.current(),
    connected = connectionIdentity,
    originalService = method === "session.create" ? serviceGeneration : detail?.serviceGeneration;
  const key =
    method === "turn.stop"
      ? stopKey(state?.threadId, state?.activeTurnId)
      : commandKey(method === "session.send" ? state?.threadId : "");
  let command;
  try {
    if (method !== "session.create" && !state) return;
    if (
      !token ||
      (method === "turn.stop" ? stopButton : method === "session.send" ? sendButton : createButton)
        .disabled
    )
      return;
    const params =
      method === "turn.stop"
        ? { threadId: state.threadId, expectedTurnId: state.activeTurnId }
        : method === "session.send"
          ? {
              threadId: state.threadId,
              expectedConfigRevision: state.configRevision,
              text: commandState.drafts.get(key) ?? "",
              ...(extra.enqueue ? { enqueue: true, expectedTurnId: state.activeTurnId } : {}),
            }
          : {};
    // 先保留业务键及原始条件，再触碰传输；超时和重连只查询这个键。
    command = commandState.begin(key, method, params);
    command.projectId = projectId;
    command.hostId = expectedHost;
    renderCommandControls();
    const envelope = {
      method,
      commandId: command.commandId,
      context: {
        projectId,
        gatewayGeneration: connected.gatewayGeneration,
        grantRevision: connected.grantRevision,
        serviceGeneration: originalService,
      },
      params: command.params,
    };
    const result = await transmitCommand(key, command, {
      token,
      call,
      connected,
      envelope,
      targetCurrent: () =>
        selectedProject === projectId &&
        (method === "session.create"
          ? serviceGeneration === originalService
          : detail === originalDetail),
    });
    if (!result) return;
    if (result.admissionState === "accepted") {
      window.dispatchEvent(new Event("remote-operation-complete"));
      if (method === "session.create" && request === call && selectedProject === projectId)
        void openSession(result.threadId);
    }
    return result;
  } catch (error) {
    if (command) commandState.failed(key, command, error);
  } finally {
    renderCommandControls();
  }
}
async function issueGUIControl(operation, values, revision) {
  if (!detail || !request || !connectionIdentity?.capabilities?.includes("submit"))
    throw new Error("此设备无提交权限");
  const state = detail.snapshot,
    originalDetail = detail,
    call = request,
    connected = connectionIdentity,
    projectId = detail.projectId,
    token = browserState.current(),
    key = commandKey(state.threadId, projectId);
  const ownGoalControl =
    ["goalPause", "goalResume", "goalClear"].includes(operation) &&
    state.goalControlAllowed &&
    state.goals?.goal?.id === values.goalId;
  if (["goalPause", "goalResume", "goalClear"].includes(operation) && !ownGoalControl)
    throw new Error("此目标请在来源桌面处理");
  if (state.ownership.kind !== "ordinary" && !ownGoalControl) throw new Error("此会话由 Task 管理");
  const command = commandState.begin(key, "session.control", {
    threadId: state.threadId,
    operation,
    expectedRevision: revision,
    values,
  });
  command.projectId = projectId;
  command.hostId = expectedHost;
  renderCommandControls();
  try {
    const result = await transmitCommand(key, command, {
      token,
      call,
      connected,
      envelope: {
        method: command.method,
        commandId: command.commandId,
        context: {
          projectId,
          gatewayGeneration: connected.gatewayGeneration,
          grantRevision: connected.grantRevision,
          serviceGeneration: originalDetail.serviceGeneration,
        },
        params: command.params,
      },
      targetCurrent: () => detail === originalDetail && selectedProject === projectId,
    });
    if (result?.admissionState === "accepted") {
      window.dispatchEvent(new Event("remote-operation-complete"));
      if (operation.startsWith("goal") && detail === originalDetail)
        void openSession(state.threadId);
    }
    return result ?? command;
  } finally {
    renderCommandControls();
  }
}
async function selectGUIProject(projectId, force = false) {
  if (!force && projectId === selectedProject && projectGroups[projectId]) return;
  closeSession();
  selectedProject = projectId;
  clearWork();
  await refreshWork();
  renderGUI();
}
function renderGUI() {
  if (!remoteUI) return;
  const state = detail?.snapshot,
    command = state && commandState.commands.get(commandKey(state.threadId)),
    stop = lastStop();
  remoteUI.render({
    sessionOpen: !!detailTarget,
    connected: document.body.dataset.connection === "connected",
    projects: projectCatalog,
    selectedProject,
    groups: projectGroups,
    detail,
    turns: sessionBodies.decorate(displayedTurns ?? state?.turns),
    bodyError: sessionBodies.error,
    bodyLoading: sessionBodies.loading,
    draft: state ? (commandState.drafts.get(commandKey(state.threadId)) ?? "") : "",
    canSubmit: !!request && !!connectionIdentity?.capabilities?.includes("submit"),
    canInterrupt: !!connectionIdentity?.capabilities?.includes("interrupt"),
    canReview: !!connectionIdentity?.capabilities?.includes("review"),
    blocked: !!commandState.unresolved(command) || !!commandState.unresolved(stop),
    sendDisabled: sendButton.disabled,
    stopDisabled: stopButton.disabled,
    notice: state
      ? document.getElementById("send-summary").textContent
      : document.getElementById("create-summary").textContent,
    unknown: !!commandState.unresolved(command) || !!commandState.unresolved(stop),
    error: sessionError.textContent,
    loading: !state,
  });
}
function openGUIReview(turnId) {
  if (!detail || !connectionIdentity?.capabilities?.includes("review")) return;
  resultReview?.close();
  const container = (resultReviewContainer ??= text("section", "")),
    call = request,
    epoch = detailEpoch;
  container.className = "remote-legacy";
  sessionPanel.append(container);
  const target = {
    projectId: detail.projectId,
    threadId: detail.snapshot.threadId,
    turnId,
    connectionId: detail.connectionId,
    gatewayGeneration: detail.gatewayGeneration,
    serviceGeneration: detail.serviceGeneration,
  };
  resultReview = new ResultReviewView(
    container,
    call,
    target,
    () =>
      request === call &&
      detailEpoch === epoch &&
      detail?.serviceGeneration === target.serviceGeneration,
  );
  void resultReview.load();
}
async function queryCommand(key, command) {
  if (!request || !commandState.unresolved(command)) return;
  const call = request,
    token = browserState.current();
  if (!token) return;
  try {
    const value = await call({
      method: "command.read",
      context: { projectId: command.projectId },
      params: { commandId: command.commandId },
    });
    if (!(await receiveCommand(token, call, key, command, value))) return;
    if (value.admissionState === "accepted") {
      window.dispatchEvent(new Event("remote-operation-complete"));
      if (
        command.method === "session.create" &&
        request === call &&
        selectedProject === command.projectId
      )
        void openSession(value.threadId);
    }
  } catch (error) {
    if (!commandCurrent(token, key, command) || request !== call) return;
    commandState.failed(key, command, {
      ...error,
      message: error.message,
      submissionUnknown: true,
    });
  } finally {
    renderCommandControls();
  }
}
async function recoverCommands() {
  const token = browserState.current(),
    call = request;
  if (!token || !call) return;
  try {
    if (token.mode === "remembered") {
      const locators = await browserState.locators(token);
      if (browserState.current() !== token || request !== call) return;
      for (const command of locators) {
        const key = restoredCommandKey(command),
          previous = commandState.commands.get(key);
        if (
          previous &&
          commandState.unresolved(previous) &&
          previous.commandId !== command.commandId
        )
          throw new Error("同一目标存在多个未确认命令，请在桌面核对");
        if (!previous || previous.commandId !== command.commandId)
          commandState.commands.set(key, command);
      }
    }
    const pending = [...commandState.commands].filter(
      ([, command]) => command.hostId === expectedHost && commandState.unresolved(command),
    );
    renderCommandControls();
    for (let index = 0; index < pending.length; index++) {
      if (browserState.current() !== token || request !== call || document.hidden) return;
      await queryCommand(...pending[index]);
      if (index + 1 < pending.length) await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } catch (error) {
    if (browserState.current() === token && request === call)
      stopConnection(`无法恢复原命令核对信息：${error.message}`);
  }
}
createButton.addEventListener("click", () => void issueCommand("session.create"));
sendButton.addEventListener("click", () => void issueCommand("session.send"));
stopButton.addEventListener("click", () => void issueCommand("turn.stop"));
stopQuery.addEventListener("click", () => {
  const command = lastStop();
  if (command)
    void queryCommand(stopKey(command.params.threadId, command.params.expectedTurnId), command);
});
createQuery.addEventListener("click", () => {
  const key = commandKey();
  void queryCommand(key, commandState.commands.get(key));
});
sendQuery.addEventListener("click", () => {
  if (detail) {
    const key = commandKey(detail.snapshot.threadId);
    void queryCommand(key, commandState.commands.get(key));
  }
});
renderCommandControls();

function attentionSummary(item) {
  const row = text("span", `${item.kind}：${item.summary} `);
  if (
    (["approval", "syncQuestion"].includes(item.kind) &&
      item.threadId &&
      item.turnId &&
      item.interactionId) ||
    (item.kind === "asyncQuestion" && item.taskId && item.runId && item.questionId)
  ) {
    const button = text("button", "审阅待处理事项");
    button.type = "button";
    button.addEventListener("click", () => openAttention(item));
    row.append(button);
  }
  return row;
}
function attentionKey(target = attentionTarget) {
  return (
    target &&
    (target.taskId
      ? `${commandKey("", target.projectId)}:task:${JSON.stringify([target.taskId, target.runId, target.questionId])}`
      : `${commandKey(target.threadId, target.projectId)}:interaction:${JSON.stringify([target.turnId, target.interactionId])}`)
  );
}
function invalidateAttention() {
  attentionEpoch++;
  attention = null;
  attentionBusy = false;
  document.getElementById("attention-body").textContent = "";
  document.getElementById("attention-questions").replaceChildren();
  document.getElementById("attention-error").textContent = "";
  document.getElementById("attention").hidden =
    !attentionTarget || attentionTarget.projectId !== selectedProject;
  renderAttentionControls();
}
function openAttention(item) {
  attentionTarget = {
    projectId: selectedProject,
    ...(item.kind === "asyncQuestion"
      ? { taskId: item.taskId, runId: item.runId, questionId: item.questionId }
      : { threadId: item.threadId, turnId: item.turnId, interactionId: item.interactionId }),
  };
  invalidateAttention();
  document.getElementById("attention").hidden = false;
  void readAttention();
}
function renderAttentionControls() {
  const target = attentionTarget,
    command = target && commandState.commands.get(attentionKey());
  const active =
    request &&
    target?.projectId === selectedProject &&
    connectionIdentity?.capabilities?.includes("answer");
  const pending =
    attention?.status === "pending" &&
    (attention.expiresAt === null || attention.expiresAt > Date.now() / 1000) &&
    !attention.taskCancelled &&
    !["completed", "failed", "cancelled"].includes(attention.runStatus);
  const blocked = !active || !pending || Boolean(command && command.admissionState !== "rejected");
  document.getElementById("attention-allow").disabled =
    blocked ||
    attentionBusy ||
    attention?.kind !== "approval" ||
    !attention?.complete ||
    !attention?.reviewToken;
  document.getElementById("attention-deny").disabled =
    blocked || attention?.kind !== "approval" || !attention?.argumentsDigest;
  const questions = attention?.content?.questions;
  const answersValid =
    questions?.length &&
    questions.length <= 8 &&
    questions.every(
      (q) =>
        typeof attention.answers?.[q.id] === "string" &&
        attention.answers[q.id].trim().length > 0 &&
        new TextEncoder().encode(attention.answers[q.id]).length <= 4096 &&
        (q.allowFreeText || q.options.includes(attention.answers[q.id])),
    );
  document.getElementById("attention-answer").disabled =
    blocked ||
    attentionBusy ||
    !["syncQuestion", "asyncQuestion"].includes(attention?.kind) ||
    !attention?.complete ||
    (attention?.kind !== "asyncQuestion" && !attention?.reviewToken) ||
    !answersValid;
  document.getElementById("attention-query").disabled =
    !active || !commandState.unresolved(command);
  document.getElementById("attention-refresh").disabled = !request || attentionBusy || !target;
  document.getElementById("attention-more").hidden = !attention?.nextCursor;
  document.getElementById("attention-more").disabled = !request || attentionBusy;
  document.getElementById("attention-target").textContent = target
    ? target.taskId
      ? `Task ${target.taskId} · Run ${target.runId} · 问题 ${target.questionId}`
      : `Thread ${target.threadId} · Turn ${target.turnId} · 交互 ${target.interactionId}`
    : "";
  document.getElementById("attention-status").textContent = attention
    ? attention.kind === "asyncQuestion"
      ? `异步问题 · ${attention.status} · ${attention.expiresAt === null ? "无到期时间" : "到期 " + new Date(attention.expiresAt * 1000).toLocaleString()} · ${attention.complete ? "原问题已完整加载" : "问题读取不完整，请在桌面查看"} · Agent 等待回答时可以继续工作；回复已暂停的 Task 不会恢复运行。`
      : `${attention.kind} · 原交互 ${attention.status} · 到期 ${new Date(attention.expiresAt * 1000).toLocaleString()} · digest ${attention.argumentsDigest ?? "不适用"} · ${attention.complete ? "审阅内容已完整加载" : "审阅不完整，不能允许；可继续加载或在桌面处理，仍可拒绝"}`
    : "请读取原交互；不会自动改用新请求";
  const observed = command?.observedState ?? (attention ? { status: attention.status } : null);
  document.getElementById("attention-command-state").textContent = command
    ? `${commandLabel(command)}${observed ? ` · 独立观察原交互：${observed.status}（不证明本命令导致或已受理）` : ""}`
    : "";
}
function renderAttentionBody() {
  document.getElementById("attention-body").textContent = attention?.content
    ? JSON.stringify(attention.content, null, 2)
    : (attention?.body ?? "");
  const container = document.getElementById("attention-questions");
  container.replaceChildren();
  if (["syncQuestion", "asyncQuestion"].includes(attention?.kind) && attention.content) {
    for (const question of attention.content.questions) {
      const label = text("label", `${question.title}（每题最多 4096 UTF-8 字节）`);
      const input = document.createElement(question.allowFreeText ? "textarea" : "select");
      input.dataset.questionId = question.id;
      input.value = attention.answers?.[question.id] ?? "";
      if (!question.allowFreeText) {
        const blank = text("option", "请选择");
        blank.value = "";
        blank.disabled = true;
        blank.selected = true;
        input.append(blank);
        for (const option of question.options) {
          const element = text("option", option);
          element.value = option;
          input.append(element);
        }
      } else if (question.options.length)
        label.append(text("p", `Core 选项：${question.options.join("、")}`));
      const reviewed = attention;
      const update = () => {
        if (attention !== reviewed) return;
        attention.answers ??= Object.create(null);
        attention.answers[question.id] = input.value;
        renderAttentionControls();
      };
      input.addEventListener("input", update);
      input.addEventListener("change", update);
      label.append(input);
      container.append(label);
    }
  }
  renderAttentionControls();
}
async function readAttention(append = false) {
  if (
    !request ||
    !attentionTarget ||
    attentionBusy ||
    attentionTarget.projectId !== selectedProject
  )
    return;
  const call = request,
    target = attentionTarget,
    epoch = attentionEpoch;
  const prior = attention;
  attentionBusy = true;
  if (!append && attention)
    attention = {
      ...attention,
      complete: false,
      reviewToken: null,
      nextCursor: null,
      body: "",
      content: null,
    };
  document.getElementById("attention-error").textContent = "";
  renderAttentionControls();
  try {
    const page = await call({
      method: target.taskId ? "task.question.read" : "attention.read",
      context: { projectId: target.projectId },
      params: target.taskId
        ? { taskId: target.taskId, runId: target.runId, questionId: target.questionId }
        : {
            threadId: target.threadId,
            turnId: target.turnId,
            interactionId: target.interactionId,
            ...(append && prior?.nextCursor ? { cursor: prior.nextCursor } : {}),
          },
    });
    if (epoch !== attentionEpoch || request !== call || attentionTarget !== target) return;
    if (
      page.projectId !== target.projectId ||
      (target.taskId
        ? ["taskId", "runId", "questionId"]
        : ["threadId", "turnId", "interactionId"]
      ).some((key) => page[key] !== target[key]) ||
      (append &&
        (page.serviceGeneration !== prior.serviceGeneration ||
          page.argumentsDigest !== prior.argumentsDigest ||
          page.review.totalBytes !== prior.review.totalBytes))
    )
      throw new Error("原交互内容已变化，请刷新原请求");
    if (target.taskId) {
      if (
        !Array.isArray(page.questions) ||
        new TextEncoder().encode(JSON.stringify(page.questions)).length > 32 * 1024
      )
        throw new Error("原 Task 问题超过读取预算");
      attention = {
        ...page,
        body: "",
        answers: Object.create(null),
        content: page.complete ? { questions: page.questions } : null,
      };
      renderAttentionBody();
      return;
    }
    const previous = append ? prior.body : "";
    if (
      page.review.encoding !== "json-utf8" ||
      page.review.offset !== new TextEncoder().encode(previous).length ||
      page.review.totalBytes > 4 * 1024 * 1024
    )
      throw new Error("审阅分页不完整，请刷新原请求");
    const body = previous + page.review.chunk;
    if (
      page.complete &&
      (new TextEncoder().encode(body).length !== page.review.totalBytes || page.nextCursor)
    )
      throw new Error("审阅正文不完整");
    attention = {
      ...page,
      body,
      answers: append ? prior.answers : Object.create(null),
      content: page.complete ? JSON.parse(body) : null,
    };
    renderAttentionBody();
  } catch (error) {
    if (epoch !== attentionEpoch || request !== call || attentionTarget !== target) return;
    if (attention)
      attention = {
        ...attention,
        complete: false,
        reviewToken: null,
        nextCursor: null,
        content: null,
      };
    document.getElementById("attention-error").textContent =
      `${error.code ?? "RESOURCE_UNAVAILABLE"}：${error.message}；未完整读取时不能允许，可拒绝已读取的原请求或在桌面处理。`;
    renderAttentionBody();
  } finally {
    if (epoch === attentionEpoch) {
      attentionBusy = false;
      renderAttentionControls();
    }
  }
}
async function issueInteraction(decision) {
  const button = document.getElementById(
    decision === "allowOnce"
      ? "attention-allow"
      : decision === "deny"
        ? "attention-deny"
        : "attention-answer",
  );
  if (button.disabled || !attention || !request) return;
  const call = request,
    target = attentionTarget,
    reviewed = attention,
    key = attentionKey(target),
    token = browserState.current(),
    connected = connectionIdentity;
  let command;
  try {
    const params = target.taskId
      ? {
          taskId: target.taskId,
          runId: target.runId,
          questionId: target.questionId,
          answers: reviewed.answers,
        }
      : {
          threadId: target.threadId,
          turnId: target.turnId,
          interactionId: target.interactionId,
          ...(decision
            ? { decision, argumentsDigest: reviewed.argumentsDigest }
            : { answers: reviewed.answers }),
          ...(reviewed.reviewToken ? { reviewToken: reviewed.reviewToken } : {}),
        };
    command = commandState.begin(
      key,
      target.taskId ? "task.question.reply" : "interaction.respond",
      params,
    );
    command.projectId = target.projectId;
    command.hostId = expectedHost;
    renderAttentionControls();
    const envelope = {
      method: command.method,
      commandId: command.commandId,
      context: {
        projectId: target.projectId,
        gatewayGeneration: connected.gatewayGeneration,
        grantRevision: connected.grantRevision,
        serviceGeneration: reviewed.serviceGeneration,
      },
      params: command.params,
    };
    const value = await transmitCommand(key, command, {
      token,
      call,
      connected,
      envelope,
      targetCurrent: () =>
        attentionTarget === target &&
        attention === reviewed &&
        selectedProject === target.projectId,
    });
    if (!value) return;
    window.dispatchEvent(new Event("remote-operation-complete"));
    if (value.admissionState === "rejected" && request === call && attentionTarget === target)
      void readAttention();
  } catch (error) {
    if (command) commandState.failed(key, command, error);
    if (
      ["TARGET_CHANGED", "REVIEW_INCOMPLETE", "INVALID_PARAMS"].includes(error.code) &&
      request === call &&
      attentionTarget === target
    )
      void readAttention();
  } finally {
    renderAttentionControls();
  }
}
document.getElementById("attention-close").addEventListener("click", () => {
  attentionTarget = null;
  invalidateAttention();
});
document.getElementById("attention-refresh").addEventListener("click", () => void readAttention());
document.getElementById("attention-more").addEventListener("click", () => void readAttention(true));
document
  .getElementById("attention-allow")
  .addEventListener("click", () => void issueInteraction("allowOnce"));
document
  .getElementById("attention-deny")
  .addEventListener("click", () => void issueInteraction("deny"));
document
  .getElementById("attention-answer")
  .addEventListener("click", () => void issueInteraction());
document.getElementById("attention-query").addEventListener("click", () => {
  const key = attentionKey();
  void queryCommand(key, commandState.commands.get(key));
});

draftChoice.addEventListener("change", () => {
  const token = browserState.current();
  if (!token) return;
  storageError.textContent = "";
  try {
    browserState.setDraftPersistence(token, draftChoice.checked);
    if (draftChoice.checked)
      for (const [key] of commandState.drafts) {
        const [hostId, projectId, threadId] = JSON.parse(key);
        if (hostId === token.hostId && threadId) saveCurrentDraft(projectId, threadId);
      }
  } catch (error) {
    draftChoice.checked = false;
    storageError.textContent = `草稿保存设置未完成：${error.message}`;
  }
});
function pauseKey(target = taskPauseTarget) {
  return (
    target &&
    `${commandKey("", target.projectId)}:pause:${JSON.stringify([target.taskId, target.runId])}`
  );
}
function invalidateTaskPause() {
  taskPauseEpoch++;
  taskPause = null;
  document.getElementById("task-pause-reviewed").checked = false;
  renderTaskPause();
}
function renderTaskPause() {
  const target = taskPauseTarget;
  document.getElementById("task-pause").hidden = !target || target.projectId !== selectedProject;
  const command = commandState.commands.get(pauseKey());
  document.getElementById("task-pause-target").textContent = target
    ? `Task ${target.taskId} · 原 Run ${target.runId} · 版本 ${taskPause?.revision ?? "待读取"}`
    : "";
  const observed = command?.observedState ?? taskPause;
  const observable = observed && observed.status !== "unavailable";
  const taskStatus = !observable
    ? "未知"
    : observed.taskPaused === true
      ? "已暂停"
      : observed.taskPaused === false
        ? "未暂停"
        : "未知";
  const runStatus =
    observable && observed.runStatus && observed.runStatus !== "unavailable"
      ? observed.runStatus
      : "未知";
  const settlementKnown =
    observable &&
    typeof observed.taskPaused === "boolean" &&
    runStatus !== "未知" &&
    typeof observed.workersSettled === "boolean" &&
    typeof observed.settled === "boolean";
  document.getElementById("task-pause-state").textContent = [
    commandLabel(command),
    observed
      ? `独立观察（不证明本命令受理）：Task ${taskStatus} · Run ${runStatus}${observed.reason ? " · " + observed.reason : ""} · ${!settlementKnown ? "原 Run 与 worker 结算状态未知" : observed.settled ? "原 Run 与全部 worker 已结算" : "等待原 Run 与全部 worker 结算"}`
      : "请读取原 Task Run 后审阅",
    taskPause && !taskPause.available
      ? "当前目标不可暂停；历史 Run、首次 Run 之前或缺少安全能力时不可操作"
      : "",
  ]
    .filter(Boolean)
    .join("；");
  document.getElementById("task-pause-confirm").disabled =
    !request ||
    !connectionIdentity?.capabilities?.includes("pauseTask") ||
    !taskPause?.available ||
    !document.getElementById("task-pause-reviewed").checked ||
    Boolean(commandState.unresolved(command));
  document.getElementById("task-pause-refresh").disabled = !request || !target;
  document.getElementById("task-pause-query").disabled = !request || !command;
}
async function readTaskPause() {
  if (!request || !taskPauseTarget) return;
  const call = request,
    target = taskPauseTarget,
    epoch = ++taskPauseEpoch;
  taskPause = null;
  document.getElementById("task-pause-reviewed").checked = false;
  renderTaskPause();
  try {
    const value = await call({
      method: "task.read",
      context: { projectId: target.projectId },
      params: { taskId: target.taskId, runId: target.runId },
    });
    if (
      request !== call ||
      target !== taskPauseTarget ||
      epoch !== taskPauseEpoch ||
      selectedProject !== target.projectId
    )
      return;
    if (
      value.projectId !== target.projectId ||
      value.taskId !== target.taskId ||
      value.runId !== target.runId
    )
      throw Error("原 Task Run 身份不匹配");
    taskPause = value;
    const command = commandState.commands.get(pauseKey(target));
    if (command)
      command.observedState = { ...value, source: "task.read", provesCommandAdmission: false };
    document.getElementById("task-pause-error").textContent = "";
  } catch (error) {
    if (epoch === taskPauseEpoch) {
      const command = commandState.commands.get(pauseKey(target));
      if (command)
        command.observedState = {
          source: "task.read",
          status: "unavailable",
          provesCommandAdmission: false,
        };
      document.getElementById("task-pause-error").textContent =
        `${error.code ?? "RESOURCE_UNAVAILABLE"}：${error.message}`;
    }
  } finally {
    if (epoch === taskPauseEpoch) renderTaskPause();
  }
}
async function issueTaskPause() {
  if (document.getElementById("task-pause-confirm").disabled || !request) return;
  const target = taskPauseTarget,
    reviewed = taskPause,
    call = request,
    connected = connectionIdentity,
    token = browserState.current(),
    key = pauseKey(target);
  let command;
  try {
    command = commandState.begin(key, "task.pause", {
      taskId: target.taskId,
      expectedRunId: target.runId,
      expectedRevision: reviewed.revision,
    });
    command.projectId = target.projectId;
    command.hostId = expectedHost;
    renderTaskPause();
    await transmitCommand(key, command, {
      token,
      call,
      connected,
      envelope: {
        method: command.method,
        commandId: command.commandId,
        context: {
          projectId: target.projectId,
          gatewayGeneration: connected.gatewayGeneration,
          grantRevision: connected.grantRevision,
          serviceGeneration: reviewed.serviceGeneration,
        },
        params: command.params,
      },
      targetCurrent: () =>
        taskPauseTarget === target &&
        taskPause === reviewed &&
        selectedProject === target.projectId &&
        document.getElementById("task-pause-reviewed").checked,
    });
  } catch (error) {
    if (command) commandState.failed(key, command, error);
  } finally {
    // 旧审阅不能授权下一次暂停；本地恢复同一 Run 后须重新读取并明确确认。
    if (taskPauseTarget === target && taskPause === reviewed) invalidateTaskPause();
    renderCommandControls();
  }
}
document.getElementById("task-pause-reviewed").addEventListener("change", renderTaskPause);
document
  .getElementById("task-pause-confirm")
  .addEventListener("click", () => void issueTaskPause());
document.getElementById("task-pause-refresh").addEventListener("click", () => void readTaskPause());
document.getElementById("task-pause-close").addEventListener("click", () => {
  taskPauseTarget = null;
  invalidateTaskPause();
});
document.getElementById("task-pause-query").addEventListener("click", () => {
  const key = pauseKey();
  void queryCommand(key, commandState.commands.get(key));
});

function restoredCommandKey(command) {
  const base = commandState.key(command.hostId, command.projectId, command.params.threadId ?? "");
  if (command.method === "task.pause")
    return `${base}:pause:${JSON.stringify([command.params.taskId, command.params.expectedRunId])}`;
  if (command.method === "task.question.reply")
    return `${base}:task:${JSON.stringify([command.params.taskId, command.params.runId, command.params.questionId])}`;
  if (command.method === "turn.stop")
    return `${base}:stop:${JSON.stringify(command.params.expectedTurnId)}`;
  if (command.method === "interaction.respond")
    return `${base}:interaction:${JSON.stringify([command.params.turnId, command.params.interactionId])}`;
  return base;
}
remoteUI = createRemoteWorkbench({
  select: selectGUIProject,
  open: async (projectId, threadId) => {
    const call = request;
    await selectGUIProject(projectId);
    if (selectedProject === projectId && request === call) await openSession(threadId);
  },
  attention: async (projectId, item) => {
    const call = request;
    await selectGUIProject(projectId);
    if (selectedProject === projectId && request === call) openAttention(item);
  },
  pause: async (projectId, row) => {
    const call = request;
    await selectGUIProject(projectId);
    if (selectedProject === projectId && request === call) {
      taskPauseTarget = { projectId, taskId: row.taskId, runId: row.runId };
      await readTaskPause();
    }
  },
  create: async (projectId) => {
    const call = request;
    await selectGUIProject(projectId);
    if (selectedProject !== projectId || request !== call) return;
    if (!serviceGeneration) await refreshWork();
    if (selectedProject === projectId && request === call) await issueCommand("session.create");
  },
  more: () => void refreshWork(true),
  close: closeSession,
  draft: (value) => {
    draftInput.value = value;
    draftInput.dispatchEvent(new Event("input"));
  },
  send: (enqueue) => issueCommand("session.send", { enqueue }),
  stop: () => issueCommand("turn.stop"),
  control: issueGUIControl,
  query: () => {
    const key = detail && commandKey(detail.snapshot.threadId),
      command = commandState.commands.get(key);
    if (commandState.unresolved(command)) void queryCommand(key, command);
    else stopQuery.click();
  },
  review: openGUIReview,
  history: () => historyButton.click(),
  retryBody: () => sessionBodies.retry(),
});
renderGUI();
const browserLoading = initializeBrowser();
void browserLoading.then((restore) => {
  if (restore) {
    reconnectEnabled = true;
    void connectHost(true);
  }
});

// 更新只提示，不在提交中途接管当前页面。
if (globalThis.isSecureContext && navigator.serviceWorker) {
  void navigator.serviceWorker
    .register("/remote-sw.js", { scope: "/", updateViaCache: "none" })
    .then((registration) => {
      const waiting = () => {
        if (registration.waiting)
          updateStatus.textContent = "新版本已就绪；完成操作后关闭本站所有页面，再重新打开。";
      };
      waiting();
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", waiting);
      });
    })
    .catch(() => {
      updateStatus.textContent = "离线页面暂不可用；当前连接仍可使用。";
    });
}
