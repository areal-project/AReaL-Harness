"use strict";
const MAX_CACHED_PAGES = 8;
const MAX_WORKSPACE_PAGES = 4;
const workspaceKey = (coreInstanceId, projectId, threadId) => JSON.stringify([coreInstanceId, projectId, threadId]);
const pageKey = (coreInstanceId, projectId, threadId, pageId) => JSON.stringify([coreInstanceId, projectId, threadId, pageId]);
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { isDeepStrictEqual } = require('node:util');
const { basename } = require('node:path');
const { validatePreview } = require('@areal/workbench/desktop-contract');
const { WorkspaceNetworkPolicy } = require('./browser-network.cjs');
const { waitAction } = require('./browser-tool.cjs');
const { validateEdit, mutate: mutateStyleTrial } = require('./browser-style-trial.cjs');

function webUrl(value) {
  const text = String(value ?? "").trim();
  const explicit =
    /^[a-z][a-z\d+.-]*:/i.test(text) &&
    !/^(localhost|[\d.]+):\d+(\/|$)/i.test(text);
  const url = new URL(
    explicit
      ? text
      : `${/^(localhost|127\.|\[::1\])/.test(text) ? "http" : "https"}://${text}`,
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("预览仅支持不含凭据的 HTTP(S) 地址");
  return url.href;
}
function observationUrl(value) {
  const url = new URL(value);
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.href;
}
const sensitive = /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|one.?time.?code|\botp\b|credential/i;
const diagnosticSensitive = /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|bearer|cookie|session.?id|one.?time.?code|\botp\b|credential/i;
const BROWSER_READ_WORLD = 1001;
async function readIsolated(contents, code) {
  const result = await contents.executeJavaScriptInIsolatedWorld(BROWSER_READ_WORLD, [{ code }]);
  if (result === undefined) throw new Error('Browser isolated read failed');
  return result;
}
async function nativeWithin(promise, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error('等待原生输入结算超时，请停止或关闭页面');
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('等待原生输入结算超时，请停止或关闭页面')), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
async function batchWithin(promise, deadline) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw new Error('not_sent');
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('not_sent')), remaining);
    })]);
  } finally { clearTimeout(timer); }
}
const viewportScript = `({width:innerWidth,height:innerHeight,scrollX,scrollY,deviceScaleFactor:devicePixelRatio})`;
const coordinateKinds = new Set(['clickAt', 'drag', 'pressAt']);
const documentReadyWait = (operation, parameters) => operation === 'wait' && parameters?.condition?.kind === 'documentReady';
function invalidateDocumentPlans(page) {
  // Readiness has no element target: keep only same-Origin, same-control waits.
  for (const [id, record] of page.plans) {
    if (!documentReadyWait(record.plan.operation, record.plan.action)) page.plans.delete(id);
  }
}
function viewportFacts(window, page, viewport) {
  const pageZoom = page.view.webContents.getZoomFactor();
  const guiZoom = window.webContents.getZoomFactor();
  const nativeBounds = page.view.getBounds();
  const key = JSON.stringify([viewport.width, viewport.height, viewport.scrollX, viewport.scrollY,
    pageZoom, viewport.deviceScaleFactor, guiZoom, nativeBounds]);
  return { ...viewport, pageZoom, guiZoom, nativeBounds, key };
}
function bitmapPoint(capture, x, y) {
  const { width, height, bitmapWidth, bitmapHeight } = capture;
  if (![width, height, bitmapWidth, bitmapHeight].every(Number.isFinite)
    || width <= 0 || height <= 0 || bitmapWidth <= 0 || bitmapHeight <= 0
    || x < 0 || y < 0 || x >= bitmapWidth || y >= bitmapHeight)
    throw new Error('target_unavailable');
  // CDP Input uses page CSS viewport coordinates; the actual bitmap dimensions
  // are the only safe conversion source across DPR and page/GUI zoom.
  // 使用可精确表示的 1/64 CSS 像素精度，避免 JSON 往返的浮点末位变化
  // 使同一批准计划失配；计划与视口的完整校验仍保留。
  return { x: Math.round(x * width / bitmapWidth * 64) / 64,
    y: Math.round(y * height / bitmapHeight * 64) / 64 };
}
function coordinateTarget(capture, action) {
  if (action.kind === 'drag') return {
    from: bitmapPoint(capture, action.fromX, action.fromY),
    to: bitmapPoint(capture, action.toX, action.toY), steps: action.steps,
  };
  return { point: bitmapPoint(capture, action.x, action.y) };
}
const interactiveRoles = new Set(['button', 'link', 'textbox', 'textfield', 'searchbox', 'combobox',
  'checkbox', 'radiobutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch',
  'slider', 'spinbutton', 'option', 'listbox']);
const MAX_REFS = 1000;
const MAX_DIAGNOSTICS = 200;
const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_FILE_RECEIPTS = 8;
const DOWNLOAD_INTENT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 120000;
const sensitiveCaptureScript = (includeFrames = true) => `(() => {
  const selector = 'input[type="password"],input[name*="token" i],input[name*="secret" i],input[name*="key" i]';
  const sensitiveAutocomplete = new Set(['current-password', 'new-password', 'cc-number', 'cc-csc', 'one-time-code']);
  const scan = root => {
    if (root.querySelector(selector)) return true;
    for (const input of root.querySelectorAll('input[autocomplete]')) {
      if (input.getAttribute('autocomplete').trim().toLowerCase().split(/\\s+/).some(token => sensitiveAutocomplete.has(token))) return true;
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot && scan(element.shadowRoot)) return true;
      if (!['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(element.tagName)
        && [...element.childNodes].some(child => child.nodeType === Node.TEXT_NODE && /password|passcode|secret|token|api.?key|credit.?card|cvv|authorization|one.?time.?code|\\botp\\b|credential/i.test(child.textContent))) return true;
    }
    for (const frame of ${includeFrames ? "root.querySelectorAll('iframe,frame')" : '[]'}) {
      try { if (!frame.contentDocument || scan(frame.contentDocument)) return true; }
      catch { return true; }
    }
    return false;
  };
  return scan(document);
})()`;
const captureGuardStartScript = (token, sequence, includeFrames = true) => `(() => {
  if ((globalThis.__arealCaptureGuardSequence ?? 0) >= ${sequence}) return false;
  globalThis.__arealCaptureGuardSequence = ${sequence};
  const previous = globalThis.__arealCaptureGuard;
  for (const observer of previous?.observers ?? []) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  const guard = { token: ${JSON.stringify(token)}, changed: false, observers: [] };
  const watch = root => {
    const observer = new MutationObserver(() => { guard.changed = true; });
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
    guard.observers.push(observer);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) watch(element.shadowRoot);
      if (${includeFrames} && element.matches('iframe,frame')) {
        if (!element.contentDocument) throw new Error('Frame unavailable');
        watch(element.contentDocument);
      }
    }
  };
  try { watch(document); globalThis.__arealCaptureGuard = guard; return true; }
  catch { for (const observer of guard.observers) observer.disconnect(); return false; }
})()`;
const captureGuardStopScript = (token, sequence) => `(() => {
  globalThis.__arealCaptureGuardSequence = Math.max(globalThis.__arealCaptureGuardSequence ?? 0, ${sequence});
  const guard = globalThis.__arealCaptureGuard;
  if (!guard || guard.token !== ${JSON.stringify(token)}) return true;
  const changed = guard.changed || guard.observers.some(observer => observer.takeRecords().length > 0);
  for (const observer of guard.observers) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  return changed;
})()`;
// 人工冻结截图保留只读变化标记，直到选择/确认结束；不返回页面内容。
const captureGuardChangedScript = token => `(() => {
  const guard = globalThis.__arealCaptureGuard;
  if (!guard || guard.token !== ${JSON.stringify(token)}) return true;
  guard.changed ||= guard.observers.some(observer => observer.takeRecords().length > 0);
  return guard.changed;
})()`;
const clearCaptureGuardScript = `(() => {
  for (const observer of globalThis.__arealCaptureGuard?.observers ?? []) observer.disconnect();
  delete globalThis.__arealCaptureGuard;
  return true;
})()`;
// 仅人工标注使用，所有返回像素对应的 Frame 都必须接受独立隐私检查。
async function captureHumanFrames(c, grant, bounded, valid, token, sequence) {
  if (c.debugger.isAttached()) throw new Error('页面调试器正在使用，无法检查嵌入站点');
  const targets = new Map(), contexts = [];
  let attached = false;
  const current = () => valid() && grant.valid() && grant.status === 'active';
  const command = async (method, params = {}, sessionId) => {
    if (!current()) throw new Error('嵌入站点截图授权已失效');
    const result = await bounded(c.debugger.sendCommand(method, params, sessionId));
    if (!current()) throw new Error('嵌入站点截图授权已失效');
    return result;
  };
  const onMessage = (_event, method, params) => {
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe')
      targets.set(params.targetInfo.targetId, params.sessionId);
    if (method === 'Target.detachedFromTarget')
      for (const [id, sid] of targets) if (sid === params.sessionId) targets.delete(id);
  };
  const snapshot = async () => {
    const root = (await command('Page.getFrameTree')).frameTree, frames = [];
    const walk = (node, parent, sid) => {
      const frame = node.frame;
      frames.push({ id: frame.id, loaderId: frame.loaderId, url: frame.url,
        origin: frame.securityOrigin, parent: parent ?? frame.parentId ?? null, sid });
      for (const child of node.childFrames ?? []) walk(child, frame.id, sid);
    };
    walk(root, null);
    for (const [id, sid] of targets) {
      const child = (await command('Page.getFrameTree', {}, sid)).frameTree;
      if (child.frame.id !== id || child.frame.parentId !== root.frame.id)
        throw new Error('嵌入站点 Frame 归属无法确认');
      walk(child, null, sid);
    }
    const parentOrigin = new URL(grant.parentURL).origin;
    if (frames.length !== c.mainFrame.framesInSubtree.length
      || new Set(frames.map(frame => frame.id)).size !== frames.length || frames.length > 32
      || frames[0].url !== grant.parentURL
      || frames.some(frame => frame.origin !== parentOrigin
        && (frame.origin !== grant.origin || frame.parent !== root.frame.id)))
      throw new Error('嵌入站点 Frame 隐私覆盖不完整');
    return frames.sort((a, b) => a.id.localeCompare(b.id));
  };
  try {
    c.debugger.attach('1.3'); attached = true;
    c.debugger.on('message', onMessage);
    await command('Page.enable');
    await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false,
      flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] });
    const before = await snapshot();
    for (const frame of before) {
      const world = await command('Page.createIsolatedWorld', {
        frameId: frame.id, worldName: `areal-human-capture-${token}` }, frame.sid);
      const context = { id: world.executionContextId, sid: frame.sid };
      contexts.push(context);
      const run = expression => command('Runtime.evaluate', { expression, contextId: context.id,
        returnByValue: true }, context.sid);
      if ((await run(captureGuardStartScript(token, sequence, false))).result?.value !== true
        || (await run(sensitiveCaptureScript(false))).result?.value !== false)
        throw new Error('嵌入站点包含敏感内容或截图保护不可用，未生成图片');
    }
    const image = await bounded(c.capturePage());
    if (!current()) throw new Error('嵌入站点截图授权已失效');
    for (const context of contexts) {
      const run = expression => command('Runtime.evaluate', { expression, contextId: context.id,
        returnByValue: true }, context.sid);
      if ((await run(sensitiveCaptureScript(false))).result?.value !== false
        || (await run(captureGuardStopScript(token, sequence))).result?.value !== false)
        throw new Error('嵌入站点在截图期间发生变化，未生成图片');
    }
    if (!isDeepStrictEqual(before, await snapshot())) throw new Error('嵌入站点 Frame 已变化，未生成图片');
    return { image, frames: before.map(({ id, loaderId, origin }) => ({ id, loaderId, origin })) };
  } finally {
    // 清理即使授权已失效也要执行；仅清理本次固定上下文，不重放截图或页面动作。
    const cleanupDeadline = performance.now() + 500;
    await Promise.allSettled(contexts.map(context => !c.isDestroyed() && c.debugger.isAttached()
      ? nativeWithin(c.debugger.sendCommand('Runtime.evaluate', {
        expression: captureGuardStopScript(token, sequence), contextId: context.id, returnByValue: true,
      }, context.sid), cleanupDeadline) : Promise.resolve()));
    c.debugger.removeListener('message', onMessage);
    if (attached && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
  }
}
function safeText(value, limit = 500) {
  const text = String(value ?? '').slice(0, limit);
  return sensitive.test(text) ? '[redacted]' : text;
}
function diagnosticText(value, limit = 500) {
  const text = String(value ?? '').slice(0, limit);
  if (diagnosticSensitive.test(text)) return '[redacted]';
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
    try { return observationUrl(raw); } catch { return '[redacted URL]'; }
  });
}
function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '[redacted URL]';
    return diagnosticText(observationUrl(url.href), 500);
  } catch { return '[redacted URL]'; }
}
function boundsWithinWindow(value, size) {
  if (
    !value ||
    ["x", "y", "width", "height"].some((key) => !Number.isFinite(value[key]))
  )
    throw new Error("无效预览区域");
  const x = Math.max(0, Math.round(value.x)),
    y = Math.max(0, Math.round(value.y));
  return {
    x: Math.min(x, size[0]),
    y: Math.min(y, size[1]),
    width: Math.max(0, Math.min(Math.round(value.width), size[0] - x)),
    height: Math.max(0, Math.min(Math.round(value.height), size[1] - y)),
  };
}
function rendererBoundsWithinWindow(value, window) {
  const zoom = window.webContents.getZoomFactor();
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error('无效 GUI 缩放');
  if (!value) throw new Error('无效预览区域');
  return boundsWithinWindow(Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, value[key] * zoom])),
    window.getContentSize());
}
/** 网页没有 preload/Node/产品 IPC；任务拥有独立内容与导航历史。 */
class CorePreview {
  constructor(window, WebContentsView, owns, preferences = () => ({}), coreIdentity = () => null,
    controlEndpoints = () => [], confirmDevelopmentOrigin = async () => false) {
    this.window = window;
    this.WebContentsView = WebContentsView;
    this.owns = owns;
    this.preferences = preferences;
    this.coreIdentity = coreIdentity;
    this.controlEndpoints = controlEndpoints;
    this.confirmDevelopmentOrigin = confirmDevelopmentOrigin;
    this.pages = new Map();
    this.contexts = new Map();
    this.selected = new Map();
    this.eventSequences = new Map();
    this.listeners = new Set();
    this.fileReceipts = new Map();
    this.owner = null;
    this.view = null;
    this.browserHostId = randomUUID();
    this.hostGeneration = randomBytes(4).readUInt32BE(0);
    // A call identity is retained for this host lifetime. Losing a transport
    // reply must never turn a repeated call into permission to replay a prefix.
    this.batchCalls = new Map();
    window.on('blur', () => this.cancelHumanGesture(this.humanMouseGesture?.page));
    // 人工输入来源只在 Main 记录；Renderer 没有通用 sendInputEvent 能力。
    window.webContents.on('before-mouse-event', (event, mouse) => {
      const page = this.pages.get(this.owner);
      if (!page?.view || !window.isFocused()) return;
      const bounds = page.view.getBounds();
      const x = Math.round(mouse.x - bounds.x), y = Math.round(mouse.y - bounds.y);
      const inside = x >= 0 && y >= 0 && x < bounds.width && y < bounds.height;
      const gesture = this.humanMouseGesture;
      const continuation = gesture?.page === page && !gesture.cancelled
        && gesture.generation === page.pageGeneration && gesture.document === page.documentGeneration
        && ['mouseUp', 'mouseMove'].includes(mouse.type)
        && (mouse.type !== 'mouseUp' || mouse.button === gesture.button);
      if (['mouseUp', 'mouseMove'].includes(mouse.type) && !continuation) {
        if (mouse.type === 'mouseUp' && gesture?.page === page && mouse.button === gesture.button) this.cancelHumanGesture(page);
        return;
      }
      if (mouse.type === 'mouseDown' && !inside) this.nativeInputOwner = null;
      if ((!inside && !continuation) || (!continuation && page.view.getVisible()) || !page.requestedVisible
        || (!continuation && !['agent', 'transferring'].includes(page.control))
        || !['mouseDown', 'mouseUp', 'mouseWheel', 'mouseMove'].includes(mouse.type)) return;
      event.preventDefault(); this.nativeInputOwner = page.id;
      void this.humanInput(page.projectId, page.threadId, page.id, { ...mouse, x, y }).catch(() => {});
    });
    window.webContents.on('before-input-event', (event, input) => {
      const page = this.pages.get(this.owner);
      if (!page?.view || page.id !== this.nativeInputOwner || page.view.getVisible()
        || !page.requestedVisible || !window.isFocused() || !['agent', 'transferring'].includes(page.control)) return;
      event.preventDefault();
      void this.humanKey(page, input).catch(() => {});
    });
  }
  workspacePages(projectId, threadId) {
    return [...this.pages.values()].filter(page => page.coreInstanceId === this.coreIdentity(projectId)
      && page.projectId === projectId && page.threadId === threadId);
  }
  page(projectId, threadId, id) {
    const selected = id ?? this.selected.get(workspaceKey(this.coreIdentity(projectId), projectId, threadId));
    return selected ? this.pages.get(pageKey(this.coreIdentity(projectId), projectId, threadId, selected)) : null;
  }
  pageStillOwned(page) {
    return this.pages.get(pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id)) === page
      && page.coreInstanceId === this.coreIdentity(page.projectId)
      && this.owns(page.projectId, page.threadId);
  }
  developmentPromptFence(page) {
    return { view: page.view, pageGeneration: page.pageGeneration,
      documentGeneration: page.documentGeneration, controlEpoch: page.controlEpoch };
  }
  currentDevelopmentPrompt(page, fence) {
    if (!this.pageStillOwned(page) || !page.view || page.view.webContents.isDestroyed()) return false;
    const key = pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id);
    const workspace = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    // A blank initial page is bound by the current trusted `show` request even
    // before there is a URL to make its native view visible.
    const initialBlank = !page.url && !page.view.webContents.getURL();
    return this.owner === key && this.view === fence.view && page.view === fence.view
      && this.selected.get(workspace) === page.id && page.control === 'human'
      && !page.annotationCaptureId
      && page.pageGeneration === fence.pageGeneration
      && page.documentGeneration === fence.documentGeneration
      && page.controlEpoch === fence.controlEpoch
      && (page.requestedVisible || initialBlank);
  }
  metadata(page) {
    const c = page.view?.webContents;
    return { coreInstanceId: page.coreInstanceId, pageId: page.id, openerId: page.openerId ?? null, origin: page.origin,
      resource: page.view ? page.crashed ? 'crashed' : 'ready' : 'suspended', control: page.control,
      stateLoss: page.stateLoss ?? null,
      url: c && !c.isDestroyed() ? c.getURL() || page.url : page.url,
      title: c && !c.isDestroyed() ? safeText(c.getTitle(), 256) : safeText(page.title, 256),
      pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch, viewportRevision: page.viewportRevision,
      operation: page.batchProgress ?? null };
  }
  snapshot(projectId, threadId) {
    const key = workspaceKey(this.coreIdentity(projectId), projectId, threadId);
    return { sequence: this.eventSequences.get(key) ?? 0, workspaceId: key,
      selectedPageId: this.selected.get(key) ?? null,
      pages: this.workspacePages(projectId, threadId).map(page => this.metadata(page)),
      fileReceipts: this.fileReceipts.get(key) ?? [] };
  }
  subscribe(projectId, threadId, listener) {
    const item = { key: workspaceKey(this.coreIdentity(projectId), projectId, threadId), listener };
    this.listeners.add(item);
    return { snapshot: this.snapshot(projectId, threadId), unsubscribe: () => this.listeners.delete(item) };
  }
  changed(page, type = 'pageChanged') {
    if (type !== 'pageRemoved' && !this.pageStillOwned(page)) return;
    const key = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    const sequence = (this.eventSequences.get(key) ?? 0) + 1;
    this.eventSequences.set(key, sequence);
    const event = { sequence, type, workspaceId: key,
      page: this.metadata(page) };
    for (const item of this.listeners) if (item.key === event.workspaceId) item.listener(event);
  }
  dispose() {
    for (const key of [...this.pages.keys()]) this.release(key);
    this.view = null; this.owner = null;
    this.fileReceipts.clear();
  }
  fileReceipt(page, record) {
    const key = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    const entries = this.fileReceipts.get(key) ?? [];
    const index = entries.findIndex(value => value.id === record.id);
    if (index >= 0) entries.splice(index, 1);
    const { timer: _timer, ...publicRecord } = record;
    entries.push(publicRecord);
    while (entries.length > MAX_FILE_RECEIPTS) entries.shift();
    this.fileReceipts.delete(key);
    this.fileReceipts.set(key, entries);
    while (this.fileReceipts.size > 32) this.fileReceipts.delete(this.fileReceipts.keys().next().value);
    this.changed(page);
  }
  release(key, { preserveContext = false } = {}) {
    const page = this.pages.get(key);
    if (!page) return;
    this.revoke(page);
    page.activeRead?.cancel();
    page.activeSelection?.cancel();
    this.pages.delete(key);
    this.closeNative(page);
    if (this.owner === key) { this.owner = null; this.view = null; }
    const workspace = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    if (this.selected.get(workspace) === page.id) {
      const next = this.workspacePages(page.projectId, page.threadId)[0];
      if (next) this.selected.set(workspace, next.id); else this.selected.delete(workspace);
    }
    this.changed(page, 'pageRemoved');
    if (!this.owns(page.projectId, page.threadId) || page.coreInstanceId !== this.coreIdentity(page.projectId))
      this.fileReceipts.delete(workspace);
    if (!preserveContext && ![...this.pages.values()].some(other => other.partition === page.partition))
      this.releaseWorkspaceContext(page);
  }
  releaseWorkspaceContext(page) {
    const context = this.contexts.get(page.partition);
    if (!context || context.session !== page.session) return;
    this.contexts.delete(page.partition);
    context.policy.close();
    // The deny-only webRequest listener remains installed while Chromium
    // closes sockets, unregisters workers and clears this in-memory Session.
    void (async () => {
      const results = await Promise.allSettled([
        context.session.closeAllConnections(), context.session.clearStorageData(),
        context.session.clearCache(), context.session.clearAuthCache(),
      ]);
      if (results.some(result => result.status === 'rejected'))
        console.warn('Browser Workspace Session cleanup failed');
    })();
  }
  ensureWorkspaceContext(page) {
    const key = workspaceKey(page.coreInstanceId, page.projectId, page.threadId);
    const existing = this.contexts.get(page.partition);
    if (existing) {
      if (existing.workspace !== key || existing.session !== page.session)
        throw new Error('浏览工作区上下文归属不匹配');
      return existing.policy;
    }
    if (page.session.storagePath !== null) throw new Error('浏览工作区需要临时 Session');
    const policy = new WorkspaceNetworkPolicy(this.controlEndpoints, webContentsId =>
      Number.isSafeInteger(webContentsId) && [...this.pages.values()].some(candidate =>
        candidate.partition === page.partition && this.pageStillOwned(candidate)
        && (candidate.view?.webContents.devToolsWebContents ?? candidate.openingDevTools)?.id === webContentsId));
    policy.install(page.session);
    this.contexts.set(page.partition, { workspace: key, session: page.session, policy });
    return policy;
  }
  releaseInvalidOwners() {
    for (const [key, page] of this.pages) if (!this.owns(page.projectId, page.threadId)
      || page.coreInstanceId !== this.coreIdentity(page.projectId)) this.release(key);
  }
  closeNative(page) {
    this.cancelHumanGesture(page);
    if (!page.view) return;
    page.styleTrial = null;
    const c = page.view.webContents;
    page.networkPolicy?.revokeFrameGrant(c.id);
    page.frameGrant = null;
    this.cancelFileOperations(page, 'page_closed_after_dispatch');
    if (page.openingDevTools && !page.openingDevTools.isDestroyed()) page.openingDevTools.close();
    page.openingDevTools = null;
    if (page.onDownload) c.session.removeListener('will-download', page.onDownload);
    page.diagnosticsReady = false; page.diagnosticRequests?.clear();
    page.claiming?.cancel();
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(page.view);
    if (!c.isDestroyed()) c.close();
    page.view = null;
  }
  cancelFileOperations(page, reason) {
    if (page.fileHandoff?.timer) clearTimeout(page.fileHandoff.timer);
    page.fileHandoff = null;
    for (const item of page.downloads ?? []) {
      const record = page.downloadRecords?.get(item);
      if (record && !['completed', 'cancelled', 'interrupted', 'unknown'].includes(record.status)) {
        record.status = 'unknown'; record.reason = reason;
        this.fileReceipt(page, record);
      }
      item.cancel();
      if (record?.timer) clearTimeout(record.timer);
    }
    page.downloads?.clear();
    page.downloadRecords?.clear();
  }
  pinned(page) {
    return !page.view || page.crashed || page.control !== 'human' || page.requestedVisible || !!page.annotationCaptureId
      || !!page.styleTrial
      || page.activeAction || page.activeRead || page.activeSelection || page.activePrepare || page.claiming || page.plans.size > 0
      || page.inputPending.size > 0 || page.heldButtons.size > 0 || page.heldKeys.size > 0
      || page.dialogPending || page.fileHandoff || (page.downloads?.size ?? 0) > 0;
  }
  suspend(page) {
    if (this.pinned(page)) throw new Error('页面正在使用，不能驱逐');
    const c = page.view.webContents;
    page.url = c.isDestroyed() ? page.url : c.getURL() || page.url;
    page.title = c.isDestroyed() ? page.title : c.getTitle() || page.title;
    page.refs.clear(); page.plans.clear(); page.lastObservation = null; page.needsObservation = true;
    page.stateLoss = '页面已驱逐；只恢复网址，表单和临时登录可能需要重做';
    this.closeNative(page);
    this.changed(page);
  }
  reservePageSlot(projectId, threadId, replacing = false, excluded = null) {
    this.releaseInvalidOwners();
    if (!replacing && this.workspacePages(projectId, threadId).length >= MAX_WORKSPACE_PAGES)
      throw new Error('当前浏览工作区已达4页，请先关闭页面');
    const native = [...this.pages.values()].filter(page => page.view && page !== excluded);
    if (native.length < MAX_CACHED_PAGES) return;
    const idle = native.find(page => !this.pinned(page));
    if (!idle) throw new Error('浏览页面已达8页且都在使用，请先关闭页面');
    this.suspend(idle);
  }
  workspaceOutstanding(projectId, threadId) {
    return this.workspacePages(projectId, threadId).reduce((count, page) => count + page.plans.size
      + Number(!!page.activeRead) + Number(!!page.activePrepare) + Number(!!page.activeAction), 0);
  }
  state(page = this.pages.get(this.owner)) {
    const contents = page?.view?.webContents;
    const c = contents && !contents.isDestroyed() ? contents : null;
    const state = {
      url: c?.getURL() || page?.url || '', title: c?.getTitle() ?? page?.title ?? '',
      loading: c?.isLoading() ?? false,
      canGoBack: c?.navigationHistory.canGoBack() ?? false,
      canGoForward: c?.navigationHistory.canGoForward() ?? false,
      error: page?.error ?? '',
      browser: page ? { pageId: page.id, control: page.control,
        frameOriginGrant: page.frameGrant ? { origin: page.frameGrant.origin, status: page.frameGrant.status } : null,
        trialActive: !!page.styleTrial, trialStale: !!page.styleTrial?.stale,
        transferError: page.transferError ?? null, resource: page.view ? page.crashed ? 'crashed' : 'ready' : 'suspended',
        stateLoss: page.stateLoss ?? null,
        downloadIntentExpiresAt: page.fileHandoff?.kind === 'download' ? page.fileHandoff.expiresAt : null } : null,
    };
    return page ? { ...state, workspace: this.snapshot(page.projectId, page.threadId) } : state;
  }
  revoke(page) {
    if (page.control !== 'agent') return;
    // This local fence runs before any Core request and before awaiting native input.
    page.control = 'transferring'; page.controlEpoch++; page.refs.clear(); page.plans.clear();
    page.approvedActionNavigation = null;
    this.clearDiagnostics(page, 'control_changed');
    page.lastObservation = null; page.lastCapture = null; page.needsObservation = true;
    page.view?.setVisible(false);
    page.activeRead?.cancel();
    page.activeSelection?.cancel();
    page.activeAction?.cancel();
    this.onRevoke?.({ projectId: page.projectId, threadId: page.threadId, pageId: page.id });
    this.changed(page, 'controlChanged');
    void this.convergeInput(page);
  }
  dispatchInput(page, method, params) {
    const c = page.view.webContents;
    // Record the native call before awaiting its receipt. A lost receipt leaves
    // takeover transferring rather than pretending the held input was released.
    if (method === 'Input.dispatchMouseEvent') {
      if (params.type === 'mousePressed') page.heldButtons.set(params.button, { x: params.x, y: params.y });
      if (params.type === 'mouseMoved' && page.heldButtons.has(params.button))
        page.heldButtons.set(params.button, { x: params.x, y: params.y });
    } else if (method === 'Input.dispatchKeyEvent') {
      if (params.type === 'keyDown') page.heldKeys.set(params.key, params);
    }
    const pending = c.debugger.sendCommand(method, params).then(value => {
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') page.heldButtons.delete(params.button);
      if (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp') page.heldKeys.delete(params.key);
      return value;
    });
    page.inputPending.add(pending);
    void pending.finally(() => page.inputPending.delete(pending)).catch(() => {});
    return pending;
  }
  async convergeInput(page) {
    if (page.converging) return page.converging;
    if (!this.pageStillOwned(page) || !page.view) return;
    const c = page.view.webContents;
    const epoch = page.controlEpoch;
    page.converging = (async () => {
      await Promise.resolve();
      try {
        const deadline = performance.now() + 2000;
        // Commands already submitted to CDP must settle before releases are sent.
        // The deadline bounds the first attempt; a late settlement retries safely.
        while (page.inputPending.size) {
          const pending = [...page.inputPending];
          await nativeWithin(Promise.allSettled(pending), deadline);
        }
        if (c.isDestroyed()) return;
        if (!c.debugger.isAttached() && (page.heldButtons.size || page.heldKeys.size))
          throw new Error('原生输入通道已断开，请关闭页面');
        const releases = [
          ...[...page.heldKeys.values()].map(key => ['Input.dispatchKeyEvent', { type: 'keyUp', key: key.key,
            code: key.code, windowsVirtualKeyCode: key.windowsVirtualKeyCode }]),
          ...[...page.heldButtons].map(([button, point]) => ['Input.dispatchMouseEvent',
            { type: 'mouseReleased', button, x: point.x, y: point.y, clickCount: 1 }]),
        ];
        for (const [method, params] of releases) await nativeWithin(this.dispatchInput(page, method, params), deadline);
        if (page.inputPending.size) await nativeWithin(Promise.allSettled([...page.inputPending]), deadline);
        if (page.heldButtons.size || page.heldKeys.size) throw new Error('原生输入释放未确认，请关闭页面');
        if (c.debugger.isAttached()) {
          if (page.fileChooserIntercepted) {
            await nativeWithin(c.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }), deadline);
            page.fileChooserIntercepted = false;
          }
          c.debugger.detach();
        }
        if (page.control === 'transferring' && page.controlEpoch === epoch) {
          page.control = 'human'; page.transferError = null;
          page.view?.setVisible(this.pageStillOwned(page) && this.owner === pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id)
            && page.requestedVisible === true);
          this.changed(page, 'controlChanged');
        }
      } catch (error) {
        page.transferError = error.message;
        // Keep the view hidden. A later native receipt may allow convergence.
        if (page.control === 'transferring' && page.controlEpoch === epoch && page.inputPending.size)
          void Promise.allSettled([...page.inputPending]).then(() => {
            page.converging = null;
            if (page.control === 'transferring' && page.controlEpoch === epoch) void this.convergeInput(page);
          });
      } finally { page.converging = null; }
    })();
    return page.converging;
  }
  revokeAll() { for (const page of this.pages.values()) this.revoke(page); }
  async ensureAgentPage(projectId, threadId) {
    // 仅供已通过 Core 权限的工具回调调用；展示页面不会隐式认领。
    if (!this.owns(projectId, threadId) || !this.coreIdentity(projectId)) throw new Error('Browser thread unavailable');
    let page = this.page(projectId, threadId);
    if (!page) {
      const id = randomUUID();
      page = this.create(pageKey(this.coreIdentity(projectId), projectId, threadId, id), projectId, threadId, { id });
    }
    if (!page.view || page.crashed || page.view.webContents.isDestroyed()) throw new Error('Browser page unavailable');
    const c = page.view.webContents;
    const humanRevision = page.humanRevision ?? 0;
    if (!c.getURL()) await c.loadURL('about:blank');
    if (!this.pageStillOwned(page)) throw new Error('Browser page unavailable');
    if (page.control === 'transferring') await this.convergeInput(page);
    if ((page.humanRevision ?? 0) !== humanRevision) throw new Error('Browser authorization was revoked');
    if (page.control === 'agent') return { protocol: 'areal.browser.host.v1',
      operations: ['describe', 'observe', 'capture', 'act', 'wait', 'navigate', 'newPage', 'diagnostics', 'runBatch'], available: true,
      coreInstanceId: page.coreInstanceId, projectId, threadId, pageId: page.id, browserHostId: this.browserHostId,
      hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration, controlEpoch: page.controlEpoch };
    return this.claim(projectId, threadId, page.id);
  }
  noteHumanInput(page) {
    page.humanRevision = (page.humanRevision ?? 0) + 1;
    page.claiming?.cancel();
    // Human 阶段也撤销等待 Core 审批的潜在认领，防止审批迟到重新观察人工内容。
    if (page.control === 'human') this.onRevoke?.({ projectId: page.projectId, threadId: page.threadId, pageId: page.id });
    this.revoke(page);
  }
  async humanKey(page, input) {
    const modifiers = ['shift', 'control', 'alt', 'meta'].filter(name => input[name]);
    const keyCode = input.key === ' ' ? 'Space' : input.key;
    const pending = [this.humanInput(page.projectId, page.threadId, page.id, { type: input.type, keyCode, modifiers })];
    if (input.type === 'keyDown' && input.key.length === 1 && !input.control && !input.meta && !input.isComposing)
      pending.push(this.humanInput(page.projectId, page.threadId, page.id, { type: 'char', keyCode: input.key, modifiers }));
    await Promise.all(pending);
  }
  cancelHumanGesture(page) {
    const gesture = this.humanMouseGesture;
    if (!gesture || gesture.page !== page) return;
    this.humanMouseGesture = null; gesture.cancelled = true;
    const c = page.view?.webContents;
    if (gesture.delivered && c && !c.isDestroyed() && page.pageGeneration === gesture.generation
      && page.documentGeneration === gesture.document)
      c.sendInputEvent({ type: 'mouseUp', button: gesture.button, x: -1, y: -1 });
  }
  async humanInput(projectId, threadId, pageId, input) {
    const page = this.page(projectId, threadId, pageId);
    const c = page?.view?.webContents;
    const current = () => !!c && !c.isDestroyed() && this.pageStillOwned(page)
      && this.owner === pageKey(page.coreInstanceId, projectId, threadId, pageId)
      && this.selected.get(workspaceKey(page.coreInstanceId, projectId, threadId)) === pageId
      && page.requestedVisible && !page.annotationCaptureId
      && this.window.isVisible() && !this.window.isMinimized() && this.window.isFocused();
    const rejectInput = message => {
      if (input.type === 'mouseUp' && this.humanMouseGesture && this.humanMouseGesture.page === page
        && input.button === this.humanMouseGesture.button) this.cancelHumanGesture(page);
      throw new Error(message);
    };
    if (!current()) rejectInput('人工输入页面已变化');
    const bounds = page.view.getBounds();
    const gesture = this.humanMouseGesture;
    const continuation = gesture?.page === page && gesture.generation === page.pageGeneration
      && gesture.document === page.documentGeneration && ['mouseUp', 'mouseMove'].includes(input.type)
      && (input.type !== 'mouseUp' || input.button === gesture.button);
    if (['mouseUp', 'mouseMove'].includes(input.type) && !continuation) rejectInput('人工输入手势已变化');
    if (input.type.startsWith('mouse') && (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)
      || (!continuation && (input.x < 0 || input.y < 0 || input.x >= bounds.width || input.y >= bounds.height))))
      rejectInput('人工输入坐标已变化');
    // fence 必须在首个 await 之前完成，后续输入按同一代次串行交付。
    // 隐藏 View 仍可能保留焦点；先迁到 Main，让 drain 期间的真实 up/char 继续进入 Main 队列。
    if (c.isFocused?.()) { this.nativeInputOwner = page.id; this.window.webContents.focus(); }
    this.noteHumanInput(page);
    const epoch = page.controlEpoch, generation = page.pageGeneration, document = page.documentGeneration;
    if (input.type === 'mouseDown') this.humanMouseGesture = { page, generation, document, button: input.button };
    const ownedGesture = this.humanMouseGesture;
    const deliver = async () => {
      if (page.control === 'transferring') await this.convergeInput(page);
      if (!current() || ownedGesture?.cancelled || page.control !== 'human' || page.controlEpoch !== epoch
        || page.pageGeneration !== generation || page.documentGeneration !== document)
        throw new Error('人工输入页面已变化');
      c.focus();
      c.sendInputEvent(input);
      if (input.type === 'mouseDown' && ownedGesture) ownedGesture.delivered = true;
      if (input.type === 'mouseUp' && this.humanMouseGesture === ownedGesture) this.humanMouseGesture = null;
      return this.state(page);
    };
    const pending = (page.humanInputPending ?? Promise.resolve()).then(deliver);
    page.humanInputPending = pending;
    try { return await pending; }
    catch (error) {
      if (this.humanMouseGesture === ownedGesture && ['mouseDown', 'mouseUp'].includes(input.type))
        this.cancelHumanGesture(page);
      throw error;
    } finally { if (page.humanInputPending === pending) page.humanInputPending = null; }
  }
  async claim(projectId, threadId, pageId) {
    const page = this.page(projectId, threadId, pageId);
    if (!page?.view || page.crashed || page.view.webContents.isDestroyed() || page.view.webContents.isDevToolsOpened()
      || !page.view.webContents.getURL()
      || !this.owns(projectId, threadId)) throw new Error('当前聊天没有可认领的页面');
    if (page.frameGrant) throw new Error('请先撤销嵌入站点授权并关闭页面，再交还 Agent');
    if (page.control !== 'human' || this.humanMouseGesture?.page === page || page.claiming || page.activeSelection || page.annotationCaptureId
      || page.activeRead || page.activePrepare || page.activeAction || page.fileHandoff || page.downloads.size)
      throw new Error('浏览页面当前不可认领');
    if (page.styleTrial && !(await this.clearStyleTrial(page)).cleared)
      throw new Error('页面试改已失效，请刷新页面后再交还 Agent');
    const c = page.view.webContents;
    const initial = { pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch, url: c.getURL() };
    let rejectClaim;
    const cancelled = new Promise((_, reject) => { rejectClaim = reject; });
    const claim = { cancel: () => rejectClaim(new Error('Browser claim was revoked')) };
    page.claiming = claim;
    page.activeRead = claim;
    const timer = setTimeout(claim.cancel, 5000);
    let grantedEpoch;
    try {
      // Any capture guard left by a revoked read observed only a private
      // boolean; discard it before re-enabling Agent observations.
      await Promise.race([readIsolated(c, clearCaptureGuardScript), cancelled]);
      if (!this.pageStillOwned(page) || page.claiming !== claim || page.control !== 'human'
        || page.pageGeneration !== initial.pageGeneration || page.documentGeneration !== initial.documentEpoch
        || page.controlEpoch !== initial.controlEpoch || c.isDestroyed() || c.getURL() !== initial.url
        || c.isDevToolsOpened()) throw new Error('Browser claim was revoked');
      page.control = 'agent'; grantedEpoch = ++page.controlEpoch; page.refs.clear(); page.plans.clear(); page.batchProgress = null;
      page.lastObservation = null; page.needsObservation = true;
      this.clearDiagnostics(page, 'new_control_epoch');
      if (!c.debugger.isAttached()) c.debugger.attach('1.3');
      // Runtime.enable and Console.enable can replay earlier page messages.
      // Electron's live console-message event supplies Console evidence; CDP
      // Network starts only after this explicit enable receipt.
      await Promise.race([c.debugger.sendCommand('Network.enable', { maxPostDataSize: 0 }), cancelled]);
      // An indirect Agent click may open an <input type=file> chooser. Keep
      // Chromium's chooser suppressed for the entire Agent control epoch.
      await Promise.race([c.debugger.sendCommand('Page.enable'), cancelled]);
      await Promise.race([c.debugger.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }), cancelled]);
      page.fileChooserIntercepted = true;
      if (!this.pageStillOwned(page) || page.claiming !== claim || page.control !== 'agent'
        || page.pageGeneration !== initial.pageGeneration || page.documentGeneration !== initial.documentEpoch
        || page.controlEpoch !== grantedEpoch || c.isDestroyed() || c.getURL() !== initial.url
        || c.isDevToolsOpened()) throw new Error('Browser claim was revoked');
      page.diagnosticsStartedAt = Date.now() / 1000;
      page.diagnosticsReady = true;
      this.changed(page, 'controlChanged');
      return { protocol: 'areal.browser.host.v1', operations: ['describe', 'observe', 'capture', 'act', 'wait', 'navigate', 'newPage', 'diagnostics', 'runBatch'], available: true,
        coreInstanceId: page.coreInstanceId, projectId, threadId, pageId: page.id, browserHostId: this.browserHostId,
        hostGeneration: this.hostGeneration, pageGeneration: initial.pageGeneration, controlEpoch: grantedEpoch };
    } catch (error) {
      if (page.control === 'agent' && page.controlEpoch === grantedEpoch) this.revoke(page);
      throw error;
    } finally {
      clearTimeout(timer);
      if (page.claiming === claim) page.claiming = null;
      if (page.activeRead === claim) page.activeRead = null;
    }
  }
  takeover(projectId, threadId, pageId) {
    const page = this.page(projectId, threadId, pageId);
    if (page) { page.activeSelection?.cancel(); page.claiming?.cancel(); this.revoke(page); }
    return this.state(page);
  }
  async captureElement(projectId, threadId, pageId) {
    const page = this.page(projectId, threadId, pageId);
    if (page?.control === 'transferring') await this.convergeInput(page);
    if (page?.frameGrant?.status === 'active') return {
      capture: await this.captureRegion(projectId, threadId, pageId),
      element: { available: false, reason: 'iframe 内容无法可靠识别，请使用区域标注；未生成选择器' },
    };
    const c = page?.view?.webContents;
    const key = page && pageKey(page.coreInstanceId, projectId, threadId, pageId);
    if (!page || page.id !== pageId || !c || !this.pageStillOwned(page) || !this.owns(projectId, threadId)
      || page.control !== 'human' || page.crashed || c.isDestroyed() || c.isDevToolsOpened()
      || c.debugger.isAttached() || page.claiming || page.activeRead || page.activeSelection || page.activeAction || page.activePrepare
      || page.annotationCaptureId || !page.view.getVisible() || this.owner !== key
      || !this.window.isVisible() || this.window.isMinimized())
      throw new Error('请先接管并显示当前页面，再选择元素');
    const generation = page.pageGeneration, document = page.documentGeneration;
    const control = page.controlEpoch, url = c.getURL(), view = page.view;
    const valid = () => this.pageStillOwned(page) && this.owns(projectId, threadId)
      && page.view === view && this.owner === key && page.control === 'human'
      && page.pageGeneration === generation && page.documentGeneration === document
      && page.controlEpoch === control && !c.isDestroyed() && c.getURL() === url
      && page.activeSelection === selection && !selection.cancelled
      && view.getVisible() && this.window.isVisible() && !this.window.isMinimized();
    let resolvePick, rejectPick, rejectCancel;
    const picked = new Promise((resolve, reject) => { resolvePick = resolve; rejectPick = reject; });
    void picked.catch(() => {});
    const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
    void cancelled.catch(() => {});
    const selection = { cancelled: false, cancel: () => {
      selection.cancelled = true;
      rejectPick(new Error('元素选择已取消'));
      rejectCancel(new Error('元素选择已取消'));
      page.activeRead?.cancel();
    } };
    page.activeSelection = selection;
    let attached = false, timer, domEnabled = false;
    const onMessage = (_event, method, params) => {
      if (method === 'Overlay.inspectNodeRequested') resolvePick(params?.backendNodeId);
      if (method === 'Overlay.inspectModeCanceled') rejectPick(new Error('元素选择已取消'));
    };
    const onDetach = () => rejectPick(new Error('元素选择已中断'));
    let commandDeadline = performance.now() + 5000;
    const command = (method, params = {}) => Promise.race([
      nativeWithin(c.debugger.sendCommand(method, params), commandDeadline), cancelled,
    ]);
    try {
      c.debugger.attach('1.3'); attached = true;
      c.debugger.on('message', onMessage);
      c.debugger.on('detach', onDetach);
      // Chromium's Overlay agent requires DOM to be enabled first.
      await command('DOM.enable'); domEnabled = true;
      await command('Overlay.enable');
      await command('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: {
        showInfo: true, showRulers: false, showExtensionLines: false,
        contentColor: { r: 44, g: 140, b: 255, a: 0.18 },
        borderColor: { r: 44, g: 140, b: 255, a: 0.9 },
      } });
      if (!valid() || page.activeSelection !== selection) throw new Error('元素选择已过期');
      timer = setTimeout(selection.cancel, 30000);
      const backendNodeId = await picked;
      if (!valid() || page.activeSelection !== selection || !Number.isSafeInteger(backendNodeId))
        throw new Error('元素选择已过期');
      commandDeadline = performance.now() + 3000;
      const box = await command('DOM.getBoxModel', { backendNodeId }).catch(() => null);
      if (!valid()) throw new Error('元素选择已过期');
      const quad = box?.model?.border;
      const centerX = Array.isArray(quad) ? (quad[0] + quad[4]) / 2 : null;
      const centerY = Array.isArray(quad) ? (quad[1] + quad[5]) / 2 : null;
      // The native inspect overlay is disabled before the guarded screenshot.
      await command('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} });
      await command('Overlay.disable');
      await command('DOM.disable'); domEnabled = false;
      c.debugger.removeListener('message', onMessage);
      c.debugger.removeListener('detach', onDetach);
      c.debugger.detach(); attached = false;
      if (!valid()) throw new Error('元素选择已过期');
      const capture = await this.captureRegion(projectId, threadId, pageId);
      const x = Number.isFinite(centerX) ? Math.max(0, Math.min(capture.viewport.bitmapWidth - 1,
        Math.floor(centerX * capture.viewport.bitmapWidth / capture.viewport.width))) : null;
      const y = Number.isFinite(centerY) ? Math.max(0, Math.min(capture.viewport.bitmapHeight - 1,
        Math.floor(centerY * capture.viewport.bitmapHeight / capture.viewport.height))) : null;
      let element;
      try { element = x === null || y === null
        ? { available: false, reason: '此元素没有可核查的页面边界，请改用区域标注' }
        : await this.selectElement(projectId, threadId, pageId, capture.captureId, x, y, backendNodeId); }
      catch (error) {
        await this.discardAnnotationCapture(page, capture.captureId);
        throw error;
      }
      if (!valid() || page.annotationCaptureId !== capture.captureId) {
        await this.discardAnnotationCapture(page, capture.captureId);
        throw new Error('元素选择已过期');
      }
      return { capture, element };
    } finally {
      clearTimeout(timer);
      if (!c.isDestroyed() && attached && c.debugger.isAttached()) {
        await nativeWithin(c.debugger.sendCommand('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }), performance.now() + 1000).catch(() => {});
        await nativeWithin(c.debugger.sendCommand('Overlay.disable'), performance.now() + 1000).catch(() => {});
        if (domEnabled) await nativeWithin(c.debugger.sendCommand('DOM.disable'), performance.now() + 1000).catch(() => {});
        c.debugger.detach();
      }
      c.debugger.removeListener('message', onMessage);
      c.debugger.removeListener('detach', onDetach);
      if (page.activeSelection === selection) page.activeSelection = null;
    }
  }
  async captureRegion(projectId, threadId, pageId) {
    const page = this.page(projectId, threadId, pageId);
    if (!page || page.id !== pageId || !this.owns(projectId, threadId)) throw new Error('页面已关闭');
    // A requested takeover is not human control until the native input barrier completes.
    if (page.control === 'transferring') await this.convergeInput(page);
    if (!page.view || !this.pageStillOwned(page)) throw new Error('页面已关闭');
    const c = page.view.webContents;
    const bounds = page.view.getBounds();
    if (page.control !== 'human' || page.crashed || c.isDestroyed() || c.isDevToolsOpened()
      || !this.window.isVisible() || this.window.isMinimized() || !page.view.getVisible()
      || this.owner !== pageKey(page.coreInstanceId, projectId, threadId, pageId)
      || bounds.width <= 0 || bounds.height <= 0 || !c.getURL()
      || page.activeRead || page.activePrepare || page.activeAction || page.annotationCaptureId)
      throw new Error('请先接管并显示当前页面，再截图标注');
    const epoch = page.controlEpoch, documentEpoch = page.documentGeneration, sourceUrl = c.getURL();
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(new Error('页面截图已取消或超时')); });
    const read = { requestId: randomUUID(), cancel };
    page.activeRead = read;
    const timer = setTimeout(cancel, 10000);
    const bounded = promise => Promise.race([promise, cancelled]);
    const guardToken = randomUUID();
    const guardSequence = page.nextGuardSequence = (page.nextGuardSequence ?? 0) + 1;
    const valid = () => page.control === 'human' && page.controlEpoch === epoch
      && page.documentGeneration === documentEpoch && this.pageStillOwned(page) && this.owns(projectId, threadId)
      && !c.isDestroyed() && c.getURL() === sourceUrl && page.view?.getVisible()
      && this.owner === pageKey(page.coreInstanceId, projectId, threadId, pageId)
      && page.activeRead === read && this.window.isVisible() && !this.window.isMinimized();
    let changed = true, frameEvidence;
    try {
      const viewport = await bounded(readIsolated(c, viewportScript));
      if (!valid() || ![viewport.width, viewport.height, viewport.scrollX, viewport.scrollY, viewport.deviceScaleFactor]
        .every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0 || viewport.deviceScaleFactor <= 0)
        throw new Error('页面截图条件已变化');
      const facts = viewportFacts(this.window, page, viewport);
      const viewportKey = facts.key;
      if (page.viewportKey !== viewportKey) { page.viewportKey = viewportKey; page.viewportRevision++; }
      let image;
      if (page.frameGrant?.status === 'active') {
        const captured = await captureHumanFrames(c, page.frameGrant, bounded, valid, guardToken, guardSequence);
        image = captured.image; frameEvidence = captured.frames; changed = false;
      } else {
        if (await bounded(readIsolated(c, captureGuardStartScript(guardToken, guardSequence))) !== true)
          throw new Error('页面截图保护不可用');
        if (await bounded(readIsolated(c, sensitiveCaptureScript())) !== false) throw new Error('页面包含敏感输入框，无法截图标注');
        image = await bounded(c.capturePage());
        if (!valid() || await bounded(readIsolated(c, sensitiveCaptureScript())) !== false)
          throw new Error('页面截图条件已变化');
        changed = await bounded(readIsolated(c, captureGuardChangedScript(guardToken)));
      }
      if (changed !== false || !valid()
        || viewportFacts(this.window, page, await bounded(readIsolated(c, viewportScript))).key !== viewportKey)
        throw new Error('页面在截图期间发生变化，请重试');
      const size = image.getSize();
      if (size.width <= 0 || size.height <= 0 || size.width * size.height > 8_000_000
        || size.width > 4096 || size.height > 4096) throw new Error('截图像素超出限制');
      const png = image.toPNG();
      if (png.length > 2 * 1024 * 1024) throw new Error('截图大小超出限制');
      if (!valid()) throw new Error('页面截图条件已变化');
      const captureId = randomUUID();
      page.annotationCaptureId = captureId;
      page.annotationCapture = { documentEpoch, controlEpoch: epoch, pageGeneration: page.pageGeneration,
        guardToken: frameEvidence ? null : guardToken, guardSequence,
        nativeWebContentsId: c.id,
        sourceUrl, viewport, zoom: facts.pageZoom, guiZoom: facts.guiZoom,
        nativeBounds: facts.nativeBounds, viewportKey, viewportRevision: page.viewportRevision,
        bitmapWidth: size.width, bitmapHeight: size.height };
      page.annotationElement = null;
      return { captureId, projectId, threadId, pageId,
        coreInstanceId: page.coreInstanceId, pageGeneration: page.pageGeneration,
        documentEpoch, controlEpoch: epoch, viewportRevision: page.viewportRevision,
        url: observationUrl(c.getURL()), capturedAt: new Date().toISOString(),
        viewport: { ...viewport, pageZoom: facts.pageZoom, guiZoom: facts.guiZoom,
          nativeBounds: facts.nativeBounds, bitmapWidth: size.width, bitmapHeight: size.height },
        ...(frameEvidence ? { frameEvidence, unavailableReason: 'iframe 内容无法可靠识别，请使用区域标注；未生成选择器' } : {}),
        mimeType: 'image/png', imageBase64: png.toString('base64') };
    } finally {
      clearTimeout(timer);
      if (page.annotationCapture?.guardToken !== guardToken && !c.isDestroyed())
        await nativeWithin(readIsolated(c, captureGuardStopScript(guardToken, guardSequence)), performance.now() + 1000).catch(() => {});
      if (page.activeRead === read) page.activeRead = null;
    }
  }
  async discardAnnotationCapture(page, captureId) {
    // 迟到的结束/失败只清理自身截图，不能移除新截图的变化保护。
    if (page.annotationCaptureId !== captureId) return;
    const frozen = page.annotationCapture, contents = page.view?.webContents;
    page.annotationCaptureId = null; page.annotationCapture = null; page.annotationElement = null;
    if (frozen?.guardToken && contents && !contents.isDestroyed())
      await nativeWithin(readIsolated(contents, captureGuardStopScript(frozen.guardToken, frozen.guardSequence)),
        performance.now() + 1000).catch(() => {});
  }
  // Human-only inspection of a point on the frozen native bitmap. The returned
  // evidence Ref deliberately never enters page.refs, which is Agent-owned.
  async selectElement(projectId, threadId, pageId, captureId, x, y, expectedBackendNodeId = null) {
    const page = this.page(projectId, threadId, pageId);
    const frozen = page?.annotationCapture;
    const c = page?.view?.webContents;
    if (!page || page.id !== pageId || page.annotationCaptureId !== captureId || !frozen || !c
      || !this.pageStillOwned(page) || !this.owns(projectId, threadId)) throw new Error('标注页面已变化');
    if (page.claiming || page.activeRead || page.activeAction || page.activePrepare || page.control !== 'human'
      || c.isDestroyed() || c.isDevToolsOpened() || c.debugger.isAttached()) throw new Error('元素选择当前不可用，请使用区域标注');
    if (page.frameGrant?.status === 'active') return {
      available: false, reason: 'iframe 内容无法可靠识别，请使用区域标注；未生成选择器',
    };
    if (![x, y].every(value => Number.isSafeInteger(value) && value >= 0)
      || x >= frozen.bitmapWidth || y >= frozen.bitmapHeight) throw new Error('选择位置超出截图');
    const same = () => page.annotationCaptureId === captureId && page.annotationCapture === frozen
      && this.pageStillOwned(page) && this.owns(projectId, threadId)
      && page.control === 'human' && page.controlEpoch === frozen.controlEpoch
      && page.pageGeneration === frozen.pageGeneration && page.documentGeneration === frozen.documentEpoch
      && page.view?.webContents === c && c.id === frozen.nativeWebContentsId
      && !c.isDestroyed() && c.getURL() === frozen.sourceUrl && c.getZoomFactor() === frozen.zoom
      && this.window.webContents.getZoomFactor() === frozen.guiZoom
      && isDeepStrictEqual(page.view.getBounds(), frozen.nativeBounds)
      && page.viewportRevision === frozen.viewportRevision;
    if (!same()) throw new Error('元素选择已过期，请重新截图');
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(new Error('元素选择已取消')); });
    void cancelled.catch(() => {});
    const read = { requestId: randomUUID(), cancel };
    page.activeRead = read;
    let attached = false;
    const unavailable = reason => ({ available: false, reason });
    const deadline = performance.now() + 3000;
    const bounded = promise => Promise.race([nativeWithin(promise, deadline), cancelled]);
    try {
      const currentViewport = await bounded(readIsolated(c, viewportScript));
      if (!same() || !isDeepStrictEqual(currentViewport, frozen.viewport)
        || viewportFacts(this.window, page, currentViewport).key !== frozen.viewportKey)
        throw new Error('元素选择已过期，请重新截图');
      if (!frozen.guardToken || await bounded(readIsolated(c, captureGuardChangedScript(frozen.guardToken))) !== false)
        return unavailable('页面在截图后发生变化，请重新截图或使用区域标注');
      c.debugger.attach('1.3'); attached = true;
      const command = (method, parameters = {}) => bounded(c.debugger.sendCommand(method, parameters));
      const cssX = Math.floor(x * frozen.viewport.width / frozen.bitmapWidth);
      const cssY = Math.floor(y * frozen.viewport.height / frozen.bitmapHeight);
      const [hit, frames] = await Promise.all([
        command('DOM.getNodeForLocation', { x: cssX, y: cssY, includeUserAgentShadowDOM: false }),
        command('Page.getFrameTree'),
      ]);
      if (!same()) throw new Error('元素选择已过期，请重新截图');
      if (!hit.backendNodeId || (hit.frameId && hit.frameId !== frames.frameTree?.frame?.id))
        return unavailable('iframe 内容无法可靠识别，请改用区域标注');
      if (expectedBackendNodeId && hit.backendNodeId !== expectedBackendNodeId)
        return unavailable('页面元素在选择与截图之间变化，请改用区域标注');
      const described = await command('DOM.describeNode', { backendNodeId: hit.backendNodeId, depth: 0 });
      const node = described.node;
      if (!same()) throw new Error('元素选择已过期，请重新截图');
      if (!node || ['IFRAME', 'FRAME'].includes(node.nodeName)) return unavailable('iframe 内容无法可靠识别，请改用区域标注');
      if (node.nodeName === 'CANVAS') return unavailable('Canvas 内部元素没有可核查的 DOM 身份，请改用区域标注');
      if (node.nodeName === '#document-fragment' || node.shadowRootType)
        return unavailable('Shadow DOM 内容无法可靠识别，请改用区域标注');
      const [ax, box] = await Promise.all([
        command('Accessibility.getPartialAXTree', { backendNodeId: hit.backendNodeId }),
        command('DOM.getBoxModel', { backendNodeId: hit.backendNodeId }),
      ]);
      if (!same()) throw new Error('元素选择已过期，请重新截图');
      const semantic = ax.nodes?.find(item => item.backendDOMNodeId === hit.backendNodeId && !item.ignored);
      const quad = box.model?.border;
      if (!semantic || !Array.isArray(quad) || quad.length !== 8)
        return unavailable('此位置没有可核查的语义元素，请改用区域标注');
      const xs = [quad[0], quad[2], quad[4], quad[6]], ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.max(0, Math.floor(Math.min(...xs) * frozen.bitmapWidth / frozen.viewport.width));
      const top = Math.max(0, Math.floor(Math.min(...ys) * frozen.bitmapHeight / frozen.viewport.height));
      const right = Math.min(frozen.bitmapWidth, Math.ceil(Math.max(...xs) * frozen.bitmapWidth / frozen.viewport.width));
      const bottom = Math.min(frozen.bitmapHeight, Math.ceil(Math.max(...ys) * frozen.bitmapHeight / frozen.viewport.height));
      if (right <= left || bottom <= top) return unavailable('元素已离开截图视口，请改用区域标注');
      const elementId = randomUUID();
      const result = { available: true, elementId, evidenceRef: `human:${elementId}`,
        role: safeText(semantic.role?.value ?? 'unknown', 80), name: safeText(semantic.name?.value ?? '', 200),
        bounds: { x: left, y: top, width: right - left, height: bottom - top },
        pageGeneration: frozen.pageGeneration, documentEpoch: frozen.documentEpoch,
        controlEpoch: frozen.controlEpoch, frameId: hit.frameId ?? frames.frameTree?.frame?.id ?? 'main', sourceMapping: 'unavailable' };
      if (await bounded(readIsolated(c, captureGuardChangedScript(frozen.guardToken))) !== false)
        return unavailable('页面在截图后发生变化，请重新截图或使用区域标注');
      if (!same()) throw new Error('元素选择已过期，请重新截图');
      page.annotationElement = { elementId, captureId, backendNodeId: hit.backendNodeId, result };
      return result;
    } catch (error) {
      if (!same()) throw new Error('元素选择已过期，请重新截图');
      throw error;
    } finally {
      if (attached && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
      if (page.activeRead === read) page.activeRead = null;
    }
  }
  async checkElement(projectId, threadId, pageId, captureId, elementId) {
    const page = this.page(projectId, threadId, pageId);
    const selected = page?.annotationElement;
    const frozen = page?.annotationCapture;
    const c = page?.view?.webContents;
    if (!selected || selected.elementId !== elementId || selected.captureId !== captureId || !frozen || !c)
      return { stale: true };
    if (page.control !== 'human' || page.controlEpoch !== frozen.controlEpoch
      || page.pageGeneration !== frozen.pageGeneration || page.documentGeneration !== frozen.documentEpoch
      || !this.pageStillOwned(page) || !this.owns(projectId, threadId) || c.isDestroyed()
      || page.view?.webContents !== c || c.id !== frozen.nativeWebContentsId
      || c.getURL() !== frozen.sourceUrl || c.isDevToolsOpened() || c.debugger.isAttached()
      || page.viewportRevision !== frozen.viewportRevision
      || this.window.webContents.getZoomFactor() !== frozen.guiZoom
      || !isDeepStrictEqual(page.view.getBounds(), frozen.nativeBounds)) return { stale: true };
    let cancel;
    const cancelled = new Promise((_, reject) => { cancel = () => reject(new Error('元素检查已取消')); });
    void cancelled.catch(() => {});
    const read = { requestId: randomUUID(), cancel };
    if (page.claiming || page.activeRead || page.activeAction || page.activePrepare) return { stale: true };
    page.activeRead = read;
    let attached = false;
    const deadline = performance.now() + 3000;
    const bounded = promise => Promise.race([nativeWithin(promise, deadline), cancelled]);
    try {
      const viewport = await bounded(readIsolated(c, viewportScript));
      if (!isDeepStrictEqual(viewport, frozen.viewport)
        || viewportFacts(this.window, page, viewport).key !== frozen.viewportKey) return { stale: true };
      if (!frozen.guardToken || await bounded(readIsolated(c, captureGuardChangedScript(frozen.guardToken))) !== false) return { stale: true };
      c.debugger.attach('1.3'); attached = true;
      const box = await bounded(c.debugger.sendCommand('DOM.getBoxModel', { backendNodeId: selected.backendNodeId }));
      const quad = box.model?.border;
      const centerX = quad && (quad[0] + quad[4]) / 2, centerY = quad && (quad[1] + quad[5]) / 2;
      const hit = Number.isFinite(centerX) && Number.isFinite(centerY)
        ? await bounded(c.debugger.sendCommand('DOM.getNodeForLocation', { x: Math.round(centerX), y: Math.round(centerY), includeUserAgentShadowDOM: false })) : null;
      const ax = await bounded(c.debugger.sendCommand('Accessibility.getPartialAXTree', { backendNodeId: selected.backendNodeId }));
      const semantic = ax.nodes?.find(item => item.backendDOMNodeId === selected.backendNodeId && !item.ignored);
      const xs = Array.isArray(quad) && quad.length === 8 ? [quad[0], quad[2], quad[4], quad[6]] : null;
      const ys = Array.isArray(quad) && quad.length === 8 ? [quad[1], quad[3], quad[5], quad[7]] : null;
      const bounds = xs && ys ? {
        x: Math.max(0, Math.floor(Math.min(...xs) * frozen.bitmapWidth / frozen.viewport.width)),
        y: Math.max(0, Math.floor(Math.min(...ys) * frozen.bitmapHeight / frozen.viewport.height)),
        right: Math.min(frozen.bitmapWidth, Math.ceil(Math.max(...xs) * frozen.bitmapWidth / frozen.viewport.width)),
        bottom: Math.min(frozen.bitmapHeight, Math.ceil(Math.max(...ys) * frozen.bitmapHeight / frozen.viewport.height)),
      } : null;
      const original = selected.result.bounds;
      return { stale: await bounded(readIsolated(c, captureGuardChangedScript(frozen.guardToken))) !== false
        || page.annotationElement !== selected || page.annotationCapture !== frozen
        || page.control !== 'human' || page.controlEpoch !== frozen.controlEpoch
        || page.documentGeneration !== frozen.documentEpoch || page.viewportRevision !== frozen.viewportRevision
        || !this.pageStillOwned(page)
        || !this.owns(projectId, threadId) || c.isDestroyed() || c.getURL() !== frozen.sourceUrl
        || this.window.webContents.getZoomFactor() !== frozen.guiZoom
        || !isDeepStrictEqual(page.view.getBounds(), frozen.nativeBounds)
        || hit?.backendNodeId !== selected.backendNodeId
        || !bounds || Math.abs(bounds.x - original.x) > 1 || Math.abs(bounds.y - original.y) > 1
        || Math.abs(bounds.right - (original.x + original.width)) > 1
        || Math.abs(bounds.bottom - (original.y + original.height)) > 1
        || safeText(semantic?.role?.value ?? 'unknown', 80) !== selected.result.role
        || safeText(semantic?.name?.value ?? '', 200) !== selected.result.name };
    } catch { return { stale: true }; }
    finally {
      if (attached && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
      if (page.activeRead === read) page.activeRead = null;
    }
  }
  async beginStyleTrial(projectId, threadId, pageId, captureId, elementId) {
    const page = this.page(projectId, threadId, pageId);
    const selected = page?.annotationElement;
    const frozen = page?.annotationCapture;
    if (!selected || selected.captureId !== captureId || selected.elementId !== elementId || !frozen
      || page.styleTrial || page.control !== 'human' || page.claiming) throw new Error('请重新选择当前页面元素');
    if ((await this.checkElement(projectId, threadId, pageId, captureId, elementId)).stale
      || page.annotationElement !== selected || page.annotationCapture !== frozen) throw new Error('选择的元素已变化');
    if (!frozen.guardToken || await nativeWithin(readIsolated(page.view.webContents,
      captureGuardStopScript(frozen.guardToken, frozen.guardSequence)), performance.now() + 1000) !== false
      || page.annotationCapture !== frozen) throw new Error('选择的元素已变化');
    const trialId = randomUUID();
    page.styleTrial = { trialId, backendNodeId: selected.backendNodeId,
      pageGeneration: frozen.pageGeneration, documentEpoch: frozen.documentEpoch,
      controlEpoch: frozen.controlEpoch, nativeWebContentsId: frozen.nativeWebContentsId,
      sourceUrl: frozen.sourceUrl, evidence: selected.result,
      history: [], cursor: 0, commandCount: 0, busy: false, stale: false };
    page.annotationCaptureId = null; page.annotationCapture = null; page.annotationElement = null;
    return { trialId, element: selected.result, active: true, sourceMapping: selected.result.sourceMapping };
  }
  async styleTrialCommand(projectId, threadId, pageId, trialId, operation, property, value) {
    const page = this.page(projectId, threadId, pageId), trial = page?.styleTrial;
    const c = page?.view?.webContents;
    if (!trial || trial.trialId !== trialId || !c || trial.busy) throw new Error('页面试改已失效');
    if (operation === 'applyStyleTrial') validateEdit(property, value);
    if (operation === 'applyStyleTrial' && trial.cursor >= 20) throw new Error('页面试改最多20步；请先撤销或发送意图');
    if (trial.commandCount >= 60) throw new Error('页面试改操作已达上限；请清除并重新选择元素');
    let read = null;
    const valid = () => page.styleTrial === trial && !trial.stale && this.pageStillOwned(page)
      && this.owns(projectId, threadId) && page.control === 'human' && !page.claiming
      && page.pageGeneration === trial.pageGeneration && page.documentGeneration === trial.documentEpoch
      && page.controlEpoch === trial.controlEpoch && page.view?.webContents === c
      && c.id === trial.nativeWebContentsId && !c.isDestroyed() && !c.isDevToolsOpened()
      && c.getURL() === trial.sourceUrl && !page.activeAction && page.activeRead === read && !page.activePrepare;
    if (!valid()) { trial.stale = true; throw new Error('页面试改已失效，请刷新页面'); }
    const step = operation === 'undoStyleTrial' ? trial.history[trial.cursor - 1]
      : operation === 'redoStyleTrial' ? trial.history[trial.cursor] : null;
    if (operation !== 'applyStyleTrial' && !step) return this.styleTrialState(trial);
    const editedProperty = step?.property ?? property;
    const latest = new Map();
    for (const applied of trial.history.slice(0, trial.cursor)) latest.set(applied.property, applied.after);
    if (operation === 'redoStyleTrial' && !latest.has(editedProperty)) latest.set(editedProperty, step.before);
    const checks = [...latest].map(([property, expected]) => ({ property, expected }));
    const replacement = operation === 'applyStyleTrial' ? { value, priority: '' }
      : operation === 'undoStyleTrial' ? step.before : step.after;
    trial.busy = true;
    trial.commandCount++;
    const deadline = performance.now() + 3000;
    let rejectCancel;
    const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
    void cancelled.catch(() => {});
    read = { requestId: randomUUID(), cancel: () => rejectCancel(new Error('页面试改已取消')) };
    page.activeRead = read;
    try {
      const result = await mutateStyleTrial(c, trial.backendNodeId, editedProperty, checks, replacement,
        promise => Promise.race([nativeWithin(promise, deadline), cancelled]));
      if (!valid() || result.stale) { trial.stale = true; throw new Error('应用已修改或替换目标，试改已失效'); }
      if (operation === 'applyStyleTrial' && isDeepStrictEqual(result.before, result.after))
        throw new Error('试改值未改变当前属性');
      if (operation === 'applyStyleTrial') {
        trial.history.length = trial.cursor;
        trial.history.push({ property, before: result.before, after: result.after });
        trial.cursor++;
      } else if (operation === 'undoStyleTrial') trial.cursor--;
      else trial.cursor++;
      return this.styleTrialState(trial);
    } finally { trial.busy = false; if (page.activeRead === read) page.activeRead = null; }
  }
  styleTrialState(trial) {
    return { trialId: trial.trialId, active: !trial.stale, stale: trial.stale,
      canUndo: trial.cursor > 0, canRedo: trial.cursor < trial.history.length,
      edits: trial.history.slice(0, trial.cursor).map(step => ({ property: step.property,
        before: step.before.value, after: step.after.value })),
      element: trial.evidence, sourceMapping: trial.evidence.sourceMapping };
  }
  async captureStyleTrialAfter(projectId, threadId, pageId, trialId) {
    const page = this.page(projectId, threadId, pageId), trial = page?.styleTrial;
    if (!trial || trial.trialId !== trialId || trial.stale || trial.busy || !trial.cursor)
      throw new Error('请先在当前页面完成试改');
    const c = page.view?.webContents;
    let read = null;
    const same = () => page.styleTrial === trial && !trial.stale && !trial.busy
      && this.pageStillOwned(page) && this.owns(projectId, threadId)
      && page.control === 'human' && !page.claiming && page.activeRead === read && !page.activeAction
      && !page.activePrepare && page.pageGeneration === trial.pageGeneration
      && page.documentGeneration === trial.documentEpoch && page.controlEpoch === trial.controlEpoch
      && page.view?.webContents === c && c && !c.isDestroyed() && !c.isDevToolsOpened()
      && c.id === trial.nativeWebContentsId && c.getURL() === trial.sourceUrl;
    if (!same() || c.debugger.isAttached()) throw new Error('试改目标已变化，请刷新页面');
    const deadline = performance.now() + 3000;
    let rejectCancel;
    const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
    void cancelled.catch(() => {});
    read = { requestId: randomUUID(), cancel: () => rejectCancel(new Error('试改截图已取消')) };
    page.activeRead = read;
    const bounded = promise => Promise.race([nativeWithin(promise, deadline), cancelled]);
    let attached = false, cssX, cssY, viewportKey;
    try {
      const viewport = await bounded(readIsolated(c, viewportScript));
      if (!same()) throw new Error('试改目标已变化，请刷新页面');
      viewportKey = viewportFacts(this.window, page, viewport).key;
      c.debugger.attach('1.3'); attached = true;
      const send = (method, params = {}) => bounded(c.debugger.sendCommand(method, params));
      const [frames, box] = await Promise.all([
        send('Page.getFrameTree'), send('DOM.getBoxModel', { backendNodeId: trial.backendNodeId }),
      ]);
      if (!same() || !frames.frameTree?.frame?.id) throw new Error('试改目标已变化，请刷新页面');
      const quad = box.model?.border;
      if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite))
        throw new Error('试改目标已离开页面，请刷新页面');
      const xs = [quad[0], quad[2], quad[4], quad[6]];
      const ys = [quad[1], quad[3], quad[5], quad[7]];
      const left = Math.max(0, Math.min(...xs)), right = Math.min(viewport.width, Math.max(...xs));
      const top = Math.max(0, Math.min(...ys)), bottom = Math.min(viewport.height, Math.max(...ys));
      if (right <= left || bottom <= top) throw new Error('试改目标已离开截图视口，请刷新页面');
      cssX = (left + right) / 2; cssY = (top + bottom) / 2;
    } finally {
      if (attached && !c.isDestroyed() && c.debugger.isAttached()) c.debugger.detach();
      if (page.activeRead === read) page.activeRead = null;
      read = null;
    }
    if (!same() || viewportFacts(this.window, page, await nativeWithin(readIsolated(c, viewportScript), deadline)).key !== viewportKey)
      throw new Error('试改目标已变化，请刷新页面');
    const capture = await this.captureRegion(projectId, threadId, pageId);
    try {
      // Recheck the current private node against a new privacy-guarded bitmap.
      // The original screenshot coordinates are invalid after a layout edit.
      if (!same() || page.annotationCapture?.viewportKey !== viewportKey)
        throw new Error('截图期间试改目标已变化，请刷新页面');
      const x = Math.min(capture.viewport.bitmapWidth - 1, Math.floor(cssX * capture.viewport.bitmapWidth / capture.viewport.width));
      const y = Math.min(capture.viewport.bitmapHeight - 1, Math.floor(cssY * capture.viewport.bitmapHeight / capture.viewport.height));
      const element = await this.selectElement(projectId, threadId, pageId, capture.captureId,
        x, y, trial.backendNodeId);
      if (!element.available || page.styleTrial !== trial || trial.stale)
        throw new Error('试改目标在截图时已变化，请撤销或刷新');
      return { capture, element, trial: this.styleTrialState(trial) };
    } catch (error) {
      await this.discardAnnotationCapture(page, capture.captureId);
      throw error;
    }
  }
  async clearStyleTrial(page) {
    const trial = page?.styleTrial;
    if (!trial) return { cleared: true, stale: false };
    if (trial.busy) throw new Error('页面试改操作仍在进行');
    const c = page.view?.webContents;
    const same = c && !c.isDestroyed() && this.pageStillOwned(page)
      && page.control === 'human' && page.pageGeneration === trial.pageGeneration
      && page.documentGeneration === trial.documentEpoch && page.controlEpoch === trial.controlEpoch
      && c.id === trial.nativeWebContentsId && c.getURL() === trial.sourceUrl;
    if (!same || trial.stale) { trial.stale = true; return { cleared: false, stale: true }; }
    trial.busy = true;
    const deadline = performance.now() + 3000;
    let cleared = false;
    let rejectCancel;
    const cancelled = new Promise((_, reject) => { rejectCancel = reject; });
    void cancelled.catch(() => {});
    const read = { requestId: randomUUID(), cancel: () => rejectCancel(new Error('页面试改已取消')) };
    if (page.activeRead) { trial.busy = false; throw new Error('页面正在执行其他原生操作'); }
    page.activeRead = read;
    try {
      while (trial.cursor > 0) {
        const step = trial.history[trial.cursor - 1];
        const latest = new Map();
        for (const applied of trial.history.slice(0, trial.cursor)) latest.set(applied.property, applied.after);
        const checks = [...latest].map(([property, expected]) => ({ property, expected }));
        const result = await mutateStyleTrial(c, trial.backendNodeId, step.property, checks, step.before,
          promise => Promise.race([nativeWithin(promise, deadline), cancelled]));
        if (result.stale || page.styleTrial !== trial || !this.pageStillOwned(page)
          || page.documentGeneration !== trial.documentEpoch || c.getURL() !== trial.sourceUrl) {
          trial.stale = true; return { cleared: false, stale: true };
        }
        trial.cursor--;
      }
      cleared = true;
      return { cleared: true, stale: false };
    } finally {
      trial.busy = false;
      if (page.activeRead === read) page.activeRead = null;
      if (cleared && page.styleTrial === trial) page.styleTrial = null;
    }
  }
  cancelRead({ projectId, threadId, pageId, requestId, hostGeneration }) {
    if (hostGeneration !== this.hostGeneration) return;
    const batch = this.page(projectId, threadId, pageId)?.activeBatch;
    if (batch?.requestId === requestId) batch.cancel();
    const active = this.page(projectId, threadId, pageId)?.activeRead;
    if (active?.requestId === requestId) active.cancel();
    const action = this.page(projectId, threadId, pageId)?.activeAction;
    if (action?.requestId === requestId) action.cancel();
  }
  clearDiagnostics(page, reason) {
    page.diagnosticsReady = false;
    page.diagnosticsStartedAt = null;
    page.diagnosticRequests?.clear();
    page.diagnosticEvents = [];
    page.diagnosticBytes = 0;
    page.diagnosticLoss = { after: page.diagnosticSequence ?? 0, reason };
  }
  addDiagnostic(page, event) {
    if (!this.pageStillOwned(page) || page.control !== 'agent' || !page.diagnosticsReady) return;
    const record = { sequence: ++page.diagnosticSequence, at: new Date().toISOString(),
      pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch, ...event };
    const bytes = Buffer.byteLength(JSON.stringify(record));
    page.diagnosticEvents.push({ record, bytes }); page.diagnosticBytes += bytes;
    while (page.diagnosticEvents.length > MAX_DIAGNOSTICS || page.diagnosticBytes > MAX_DIAGNOSTIC_BYTES) {
      const removed = page.diagnosticEvents.shift();
      page.diagnosticBytes -= removed.bytes;
      page.diagnosticLoss = { after: removed.record.sequence, reason: 'buffer_evicted' };
    }
    this.changed(page, 'diagnosticsAvailable');
  }
  async diagnostics(request) {
    const { page, c } = this.actionPage(request);
    if (!page.diagnosticsReady || !c.debugger.isAttached()) throw new Error('Browser diagnostics unavailable');
    const epoch = page.controlEpoch;
    const cursor = request.parameters.cursor ?? 0;
    const limit = request.parameters.limit ?? 50;
    const events = page.diagnosticEvents.filter(item => item.record.sequence > cursor
      && item.record.kind === request.parameters.kind).slice(0, limit).map(item => item.record);
    if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch)
      throw new Error('Browser observation was revoked');
    const first = page.diagnosticEvents[0]?.record.sequence ?? page.diagnosticSequence + 1;
    return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
      projectId: request.projectId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
      pageId: page.id, browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
      pageGeneration: page.pageGeneration, controlEpoch: epoch, kind: request.parameters.kind,
      events, cursor: events.at(-1)?.sequence ?? page.diagnosticSequence,
      loss: cursor < first - 1 || (['request_map_evicted', 'unattributed_request'].includes(page.diagnosticLoss?.reason)
        && cursor <= page.diagnosticLoss.after)
        ? { after: cursor, before: first, reason: page.diagnosticLoss?.reason ?? 'unavailable_interval' } : null,
      bounded: { entries: MAX_DIAGNOSTICS, bytes: MAX_DIAGNOSTIC_BYTES },
      coverage: 'live Electron Console and CDP Network metadata; no bodies or headers' };
  }
  actionPage(request) {
    const { projectId, threadId, pageId, browserHostId, hostGeneration, pageGeneration, controlEpoch } = request;
    const page = this.page(projectId, threadId, pageId);
    if (!page || page.id !== pageId || page.projectId !== projectId || page.threadId !== threadId
      || request.coreInstanceId !== page.coreInstanceId
      || browserHostId !== this.browserHostId || hostGeneration !== this.hostGeneration
      || pageGeneration !== page.pageGeneration || !this.owns(projectId, threadId)) throw new Error('plan_stale');
    if (page.control !== 'agent' || page.controlEpoch !== controlEpoch) throw new Error('plan_stale');
    const c = page.view?.webContents;
    if (!c) throw new Error('plan_stale');
    if (page.crashed || c.isDestroyed() || c.isDevToolsOpened()) throw new Error('plan_stale');
    return { page, c };
  }
  refNode(page, ref) {
    const identity = [...page.refs].find(([, value]) => value === ref)?.[0];
    if (!identity) throw new Error('stale_ref');
    const [generation, documentEpoch, controlEpoch, frameId, backendNodeId] = JSON.parse(identity);
    if (generation !== page.pageGeneration || documentEpoch !== page.documentGeneration
      || controlEpoch !== page.controlEpoch || frameId !== 'main') throw new Error('stale_ref');
    return { identity, backendNodeId };
  }
  async actionTarget(page, c, ref) {
    const { identity, backendNodeId } = this.refNode(page, ref);
    const ax = await c.debugger.sendCommand('Accessibility.getPartialAXTree', { backendNodeId });
    const dom = await c.debugger.sendCommand('DOM.describeNode', { backendNodeId, depth: 2 });
    const isFileInput = value => value?.nodeName?.toUpperCase() === 'INPUT'
      && value.attributes?.some((attribute, index, attributes) => index % 2 === 0
        && attribute.toLowerCase() === 'type' && attributes[index + 1]?.toLowerCase() === 'file');
    if (isFileInput(dom.node) || dom.node?.children?.some(isFileInput))
      throw new Error('human_takeover_required');
    const node = ax.nodes?.find(value => value.backendDOMNodeId === backendNodeId);
    if (!node || node.ignored || node.properties?.some(property => property.name === 'disabled' && property.value?.value === true))
      throw new Error('target_unavailable');
    const box = await c.debugger.sendCommand('DOM.getBoxModel', { backendNodeId });
    const quad = box.model?.content;
    if (!Array.isArray(quad) || quad.length !== 8) throw new Error('target_unavailable');
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    const viewport = await readIsolated(c, viewportScript);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
      throw new Error('target_unavailable');
    const hit = await c.debugger.sendCommand('DOM.getNodeForLocation', { x: Math.round(x), y: Math.round(y), includeUserAgentShadowDOM: false });
    if (hit.backendNodeId !== backendNodeId) throw new Error('target_unavailable');
    return { identity, backendNodeId, x, y, viewport,
      role: safeText(node.role?.value, 80), name: safeText(node.name?.value, 256) };
  }
  async publicActionSemantics(page, c, target, action, requireQueryField = false) {
    const frames = await c.debugger.sendCommand('Page.getFrameTree');
    const world = await c.debugger.sendCommand('Page.createIsolatedWorld', { frameId: frames.frameTree.frame.id,
      worldName: 'areal-browser-action-semantics' });
    const resolved = await c.debugger.sendCommand('DOM.resolveNode', { backendNodeId: target.backendNodeId,
      executionContextId: world.executionContextId });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error('target_unavailable');
    let facts;
    try {
      const result = await c.debugger.sendCommand('Runtime.callFunctionOn', { objectId, returnByValue: true,
        arguments: [{ value: action.kind }, { value: action.key ?? null }],
        functionDeclaration: `function (kind, key) {
          const el = this, form = el.form || el.closest('form');
          const field = /^(INPUT|TEXTAREA)$/.test(el.tagName);
          const tokens = [el.type, el.name, el.id, el.autocomplete, el.getAttribute('aria-label')].join(' ');
          const sensitive = /password|passcode|secret|token|api.?key|credit.?card|cc-|cvv|authorization|one.?time.?code|credential|file/i;
          const search = !!form && (form.getAttribute('role') === 'search' || el.type === 'search'
            || Array.from(form.elements).some(item => /^(q|query|search|search_query)$/i.test(item.name)));
          const controls = form ? Array.from(form.elements) : [];
          // 空的无名文件辅助控件不参与表单提交；按钮文案不能把相邻搜索字段变成文件操作。
          const privateForm = sensitive.test(tokens) || controls.some(item => item.type !== 'button'
            && !(item.type === 'file' && !item.name && item.files?.length === 0)
            && sensitive.test([item.type, item.name, item.id, item.autocomplete, item.getAttribute('aria-label')].join(' ')));
          const submits = kind === 'click' && /^(submit|image)$/.test(el.type) || kind === 'press' && key === 'Enter' && field;
          const submitter = kind === 'click' ? el : controls.find(item => /^(submit|image)$/.test(item.type));
          let submittedFields = null, query = null, queryName = null, isQueryField = false;
          if (search && submits && !privateForm && controls.length <= 128) {
            const fields = [];
            const target = submitter?.getAttribute('formtarget') || form.target;
            const charset = (form.acceptCharset || document.characterSet).toLowerCase().replace(/-/g, '');
            let valid = (!target || target === '_self') && charset === 'utf8'
              && (!submitter || (submitter.type !== 'image' && !submitter.matches(':disabled')));
            // 不构造 FormData(form)：该 API 会触发网页 formdata 事件，审批读取不能改变页面。
            for (const item of controls) {
              if (!/^(INPUT|TEXTAREA|SELECT|BUTTON|FIELDSET|OUTPUT)$/.test(item.tagName)) { valid = false; break; }
              if (!item.name || item.matches(':disabled') || /^(FIELDSET|OUTPUT)$/.test(item.tagName)) continue;
              if (item.hasAttribute('dirname')) { valid = false; break; }
              if (/^(button|reset)$/.test(item.type) || /^(submit|image)$/.test(item.type) && item !== submitter) continue;
              if (/^(checkbox|radio)$/.test(item.type) && !item.checked) continue;
              if (item.type === 'image' || item.type === 'file') { valid = false; break; }
              const values = item.tagName === 'SELECT'
                ? Array.from(item.selectedOptions).filter(option => !option.disabled && !option.closest('optgroup[disabled]')).map(option => option.value)
                : [item.name === '_charset_' && item.type === 'hidden' ? 'UTF-8' : item.value];
              for (const value of values) {
                if (typeof value !== 'string' || item.name.length > 128 || value.length > 4096 || fields.length >= 64) { valid = false; break; }
                fields.push([item.name.replace(/\\r?\\n|\\r/g, '\\r\\n'), value.replace(/\\r?\\n|\\r/g, '\\r\\n')]);
              }
              if (!valid) break;
            }
            const queryControls = controls.filter(item => /^(INPUT|TEXTAREA)$/.test(item.tagName)
              && /^(text|search|textarea)$/.test(item.type)
              && (/^(q|query|search|search_query)$/i.test(item.name) || item.type === 'search'));
            const queryControl = queryControls.includes(el) ? el : queryControls.length === 1 ? queryControls[0] : null;
            queryName = queryControl?.name ?? null;
            isQueryField = queryControl === el;
            const queryField = fields.find(entry => entry[0] === queryName);
            if (valid && queryField && new TextEncoder().encode(JSON.stringify(fields)).length <= 8192) {
              submittedFields = fields; query = queryField[1];
            }
          }
          return { field, sensitive: privateForm, submittedFields, query, queryName, queryField: isQueryField,
            search, method: form ? (submits && submitter?.getAttribute('formmethod') || form.method || 'get').toLowerCase() : null,
            destination: el.closest('a[href]')?.href || (form ? submits && submitter?.hasAttribute('formaction') ? submitter.formAction : form.action : null),
            link: !!el.closest('a[href]'), download: !!el.closest('a[download]'),
            submit: !!form && /^(submit|image)$/.test(el.type),
            type: el.type || '', role: el.getAttribute('role') || '' };
        }` });
      facts = result.result?.value;
    } finally { await c.debugger.sendCommand('Runtime.releaseObject', { objectId }).catch(() => {}); }
    if (!facts || facts.sensitive || (requireQueryField && !facts.queryField)) throw new Error('human_takeover_required');
    if (action.kind === 'fill' && facts.field && /^(text|search|textarea)$/.test(facts.type))
      return { kind: 'edit_field' };
    if (action.kind === 'press' && action.key !== 'Enter' && facts.field) return { kind: 'field_key' };
    const searchSubmit = facts.search && facts.method === 'get'
      && ((action.kind === 'press' && action.key === 'Enter' && facts.field) || (action.kind === 'click' && facts.submit));
    if (searchSubmit && (!Array.isArray(facts.submittedFields) || typeof facts.query !== 'string' || typeof facts.queryName !== 'string'))
      throw new Error('human_takeover_required');
    if (searchSubmit || (action.kind === 'click' && facts.link && !facts.download)) {
      let destination;
      try { destination = new URL(webUrl(facts.destination)); } catch { throw new Error('human_takeover_required'); }
      if (!page.networkPolicy.canAuthorize(destination.href)) throw new Error('human_takeover_required');
      return { kind: searchSubmit ? 'public_search' : 'link_navigation', method: 'GET',
        targetOrigin: destination.origin, targetPath: destination.pathname,
        ...(searchSubmit ? { query: facts.query, queryName: facts.queryName, submittedFields: facts.submittedFields,
          encodedQuery: new URLSearchParams(facts.submittedFields).toString() } : { targetUrl: destination.href }) };
    }
    if (action.kind === 'click' && facts.field) return { kind: 'focus_field' };
    throw new Error('human_takeover_required');
  }
  acceptActionNavigation(page, url) {
    const intent = page.approvedActionNavigation;
    page.approvedActionNavigation = null;
    if (!intent || page.control !== 'agent' || intent.controlEpoch !== page.controlEpoch) return false;
    try {
      const destination = new URL(webUrl(url));
      if (destination.origin !== intent.targetOrigin || destination.pathname !== intent.targetPath) return false;
      if (intent.kind !== 'public_search') return intent.targetUrl === destination.href;
      if (intent.pageGeneration !== page.pageGeneration || intent.expiresAt < Date.now()) return false;
      if (typeof intent.queryName !== 'string' || !intent.queryName) return false;
      const values = new URLSearchParams(intent.submittedFields).getAll(intent.queryName);
      // 网站脚本可改写辅助参数；延续权限仅绑定已批准查询的完整值与重数。
      if (!values.length || !isDeepStrictEqual(destination.searchParams.getAll(intent.queryName), values)) return false;
      // 保留一次搜索的短时跳转链；导航不续期，人工撤权或下一次动作会清除此意图。
      page.approvedActionNavigation = intent;
      return true;
    } catch { return false; }
  }
  async prepareNavigation(request) {
    const { page, c } = this.actionPage(request);
    if (page.needsObservation && c.getURL() !== 'about:blank') throw new Error('stale_ref');
    if (page.activeRead || page.activePrepare || page.activeAction
      || this.workspaceOutstanding(page.projectId, page.threadId) >= 16)
      throw new Error('not_sent');
    const target = webUrl(request.parameters.url);
    if (!page.networkPolicy.canAuthorize(target)) throw new Error('not_sent');
    const source = c.getURL();
    if (!source) throw new Error('plan_stale');
    const plan = { preparedActionId: randomUUID(), operation: request.operation, pageId: page.id,
      origin: new URL(source).origin, targetOrigin: new URL(target).origin,
      url: observationUrl(source), targetUrl: target,
      pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
      controlEpoch: page.controlEpoch, browserHostId: this.browserHostId,
      hostGeneration: this.hostGeneration, threadId: request.threadId, turnId: request.turnId,
      callId: request.callId, expiresAt: Date.now() + 300000 };
    plan.fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    page.plans.set(plan.preparedActionId, { plan, pageUrl: source });
    return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
      projectId: request.projectId, threadId: request.threadId, turnId: request.turnId,
      callId: request.callId, pageId: page.id, browserHostId: this.browserHostId,
      hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration,
      controlEpoch: page.controlEpoch, plan };
  }
  batchIdentity(request) {
    return JSON.stringify([this.hostGeneration, request.coreInstanceId, request.projectId,
      request.threadId, request.turnId, request.callId]);
  }
  batchStep(request, step) {
    return { ...request, operation: step.operation, parameters: step.operation === 'act'
      ? { pageId: request.pageId, snapshotId: step.snapshotId, action: step.action }
      : { pageId: request.pageId, timeoutMs: step.timeoutMs,
        ...(step.condition === undefined ? {} : { condition: step.condition }) } };
  }
  async prepareBatch(request) {
    const key = this.batchIdentity(request);
    const parameters = JSON.stringify(request.parameters);
    const existing = this.batchCalls.get(key);
    if (existing) {
      if (existing.parameters !== parameters) throw new Error('not_sent');
      return existing.preparePromise;
    }
    const { page, c } = this.actionPage(request);
    if (this.batchCalls.size >= 256) throw new Error('not_sent');
    const record = { parameters, page, plan: null, result: null, executePromise: null, cancelled: false };
    this.batchCalls.set(key, record);
    record.preparePromise = (async () => {
      const stepPlans = [];
      const deadline = performance.now() + 9000; // Adapter preparation expires at 10s.
      try {
        if (page.needsObservation || page.lastObservation !== request.parameters.snapshotId) throw new Error('stale_ref');
        for (const step of request.parameters.steps) {
          if (performance.now() >= deadline) throw new Error('not_sent');
          const prepared = await this.prepare({ ...this.batchStep(request, step), batchDeadline: deadline });
          stepPlans.push(prepared.plan);
          if (performance.now() >= deadline || page.view?.webContents !== c || page.controlEpoch !== request.controlEpoch)
            throw new Error('plan_stale');
        }
        // 批量外层计划也占用同一工作区预算；失败时沿现有路径清除子计划。
        if (this.workspaceOutstanding(page.projectId, page.threadId) >= 16) throw new Error('not_sent');
        const plan = { preparedActionId: randomUUID(), operation: 'runBatch', pageId: page.id,
          origin: new URL(c.getURL()).origin, url: observationUrl(c.getURL()),
          snapshotId: request.parameters.snapshotId, steps: stepPlans,
          pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
          controlEpoch: page.controlEpoch, viewportRevision: page.viewportRevision,
          browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
          threadId: request.threadId, turnId: request.turnId, callId: request.callId,
          expiresAt: Date.now() + 300000 };
        plan.fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
        record.plan = plan;
        page.plans.set(plan.preparedActionId, { plan, pageUrl: c.getURL() });
        return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
          projectId: request.projectId, threadId: request.threadId, turnId: request.turnId,
          callId: request.callId, pageId: page.id, browserHostId: this.browserHostId,
          hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration,
          controlEpoch: page.controlEpoch, plan };
      } catch (error) {
        for (const plan of stepPlans) page.plans.delete(plan.preparedActionId);
        throw error;
      }
    })();
    return record.preparePromise;
  }
  async executeBatch(request) {
    const record = this.batchCalls.get(this.batchIdentity(request));
    if (!record || record.parameters !== JSON.stringify(request.parameters)) throw new Error('plan_stale');
    if (record.executePromise) return record.executePromise;
    const approved = request.browserApproval?.plan;
    const saved = approved && record.page.plans.get(approved.preparedActionId);
    const { page, c } = this.actionPage(request);
    if (record.page !== page || !record.plan || !saved || !isDeepStrictEqual(approved, record.plan)
      || !isDeepStrictEqual(saved.plan, record.plan) || approved.expiresAt < Date.now()
      || saved.pageUrl !== c.getURL() || page.controlEpoch !== approved.controlEpoch
      || page.documentGeneration !== approved.documentEpoch) throw new Error('plan_stale');
    // Register before the first asynchronous step so concurrent equal callIds
    // share one execution; a different argument body is rejected above.
    record.executePromise = (async () => {
      page.plans.delete(approved.preparedActionId);
      const receipts = [];
      page.batchProgress = { callId: request.callId, completed: 0,
        total: request.parameters.steps.length, status: 'running' };
      this.changed(page, 'operationChanged');
      const deadline = performance.now() + 29000;
      let expired = false;
      const batch = { requestId: request.requestId, cancel: () => {
        record.cancelled = true;
        if (page.activeAction?.requestId === request.requestId) page.activeAction.cancel();
      } };
      page.activeBatch = batch;
      const timer = setTimeout(() => {
        expired = true;
        batch.cancel();
      }, 29000);
      const base = { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        projectId: request.projectId, threadId: request.threadId, turnId: request.turnId,
        callId: request.callId, pageId: page.id, browserHostId: this.browserHostId,
        hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration,
        controlEpoch: approved.controlEpoch, preparedActionId: approved.preparedActionId };
      try {
        for (const [index, step] of request.parameters.steps.entries()) {
          const remaining = deadline - performance.now();
          if (record.cancelled || expired || remaining <= 1000 || (step.operation === 'wait' && step.timeoutMs + 1000 > remaining)) {
            const result = { ...base, error: 'budget_exceeded', dispatch: 'not_sent',
              receipts, failedStep: index, remaining: 'not_sent', remainingSteps: request.parameters.steps.length - index };
            page.batchProgress = { callId: request.callId, completed: receipts.length,
              total: request.parameters.steps.length, status: 'rejected' };
            this.changed(page, 'operationChanged');
            record.result = result; return result;
          }
          try {
            this.actionPage(request); // Page, host generation and local control fence.
            if (page.controlEpoch !== approved.controlEpoch || page.documentGeneration !== approved.documentEpoch)
              throw new Error('plan_stale');
            const result = await this.execute({ ...this.batchStep(request, step), batchDeadline: deadline,
              browserApproval: { plan: approved.steps[index] },
              batchGuard: () => record.cancelled || performance.now() >= deadline });
            receipts.push({ stepIndex: index, operation: step.operation, status: 'confirmed', dispatch: result.dispatch,
              verification: result.verification ?? 'not_checked', preparedActionId: result.preparedActionId });
            page.batchProgress = { callId: request.callId, completed: receipts.length,
              total: request.parameters.steps.length, status: 'running' };
            this.changed(page, 'operationChanged');
          } catch (error) {
            const unknown = error.message === 'outcome_unknown';
            const result = { ...base, error: unknown ? 'outcome_unknown' : error.message,
              dispatch: unknown ? 'unknown' : 'not_sent', receipts,
              failedStep: index, remaining: 'not_sent', remainingSteps: request.parameters.steps.length - index - 1 };
            page.batchProgress = { callId: request.callId, completed: receipts.length,
              total: request.parameters.steps.length, status: unknown ? 'unknown' : 'rejected' };
            this.changed(page, 'operationChanged');
            record.result = result; return result;
          }
        }
        const result = { ...base, dispatch: 'confirmed', receipts,
          verification: 'not_checked' };
        page.batchProgress = { callId: request.callId, completed: receipts.length,
          total: receipts.length, status: 'confirmed' };
        this.changed(page, 'operationChanged');
        record.result = result; return result;
      } finally {
        clearTimeout(timer);
        for (const plan of approved.steps) page.plans.delete(plan.preparedActionId);
        if (page.activeBatch === batch) page.activeBatch = null;
      }
    })();
    return record.executePromise;
  }
  async executeNavigation(request) {
    const { page, c } = this.actionPage(request);
    const approved = request.browserApproval?.plan;
    const saved = approved && page.plans.get(approved.preparedActionId);
    const target = webUrl(request.parameters.url);
    if (!saved || !isDeepStrictEqual(saved.plan, approved)
      || approved.operation !== request.operation || approved.pageId !== page.id
      || approved.threadId !== request.threadId || approved.turnId !== request.turnId
      || approved.callId !== request.callId || approved.expiresAt < Date.now()
      || approved.targetUrl !== target || approved.origin !== new URL(c.getURL()).origin
      || saved.pageUrl !== c.getURL() || approved.pageGeneration !== page.pageGeneration
      || approved.documentEpoch !== page.documentGeneration || approved.controlEpoch !== page.controlEpoch)
      throw new Error('plan_stale');
    page.plans.delete(approved.preparedActionId);
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error('not_sent');
    if (!page.networkPolicy.allowApprovedNavigation(target)) throw new Error('not_sent');
    let cancel;
    const stopped = new Promise((_, reject) => { cancel = () => reject(new Error('outcome_unknown')); });
    const action = { requestId: request.requestId, dispatched: false, cancelled: false,
      cancel() { this.cancelled = true; cancel(); } };
    page.activeAction = action;
    let child;
    const deadline = setTimeout(() => action.cancel(), 12000);
    try {
      page.approvedActionNavigation = null;
      if (request.operation === 'navigate') {
        page.approvedNavigation = target; page.url = target; page.error = '';
        action.dispatched = true;
        await Promise.race([c.loadURL(target), stopped]);
      } else {
        const id = randomUUID();
        child = this.create(pageKey(page.coreInstanceId, page.projectId, page.threadId, id), page.projectId, page.threadId,
          { id, openerId: page.id, origin: 'agent' });
        child.approvedNavigation = target; child.url = target;
        action.dispatched = true;
        await Promise.race([child.view.webContents.loadURL(target), stopped]);
      }
      if (action.cancelled || !this.pageStillOwned(page) || !this.owns(page.projectId, page.threadId)
        || page.controlEpoch !== approved.controlEpoch || (child && !this.pageStillOwned(child)))
        throw new Error('outcome_unknown');
      if (child) {
        const claimed = await Promise.race([this.claim(page.projectId, page.threadId, child.id), stopped]);
        if (action.cancelled || !this.pageStillOwned(page) || !this.owns(page.projectId, page.threadId)
          || page.controlEpoch !== approved.controlEpoch || !this.pageStillOwned(child)
          || child.control !== 'agent' || child.controlEpoch !== claimed.controlEpoch)
          throw new Error('outcome_unknown');
      }
      this.changed(child ?? page);
      return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        projectId: request.projectId, threadId: request.threadId, turnId: request.turnId,
        callId: request.callId, pageId: page.id, browserHostId: this.browserHostId,
        hostGeneration: this.hostGeneration, pageGeneration: page.pageGeneration,
        controlEpoch: page.controlEpoch, ...(child ? { createdPage: { pageId: child.id,
          pageGeneration: child.pageGeneration, controlEpoch: child.controlEpoch } } : {}),
        url: target, dispatch: 'confirmed' };
    } catch (error) {
      page.approvedNavigation = null;
      if (child) {
        child.approvedNavigation = null;
        child.claiming?.cancel();
        if (child.control === 'agent') this.revoke(child);
      }
      if (action.dispatched) throw new Error('outcome_unknown');
      throw error;
    } finally {
      clearTimeout(deadline);
      if (page.activeAction === action) page.activeAction = null;
    }
  }
  prepareRead(request) {
    const { page, c } = this.actionPage(request);
    for (const [id, record] of page.plans) if (record.plan.expiresAt < Date.now()) page.plans.delete(id);
    if (page.activeRead || page.activePrepare || page.activeAction
      || this.workspaceOutstanding(page.projectId, page.threadId) >= 16) throw new Error('not_sent');
    const plan = { preparedActionId: randomUUID(), operation: request.operation, pageId: page.id,
      origin: new URL(c.getURL()).origin, url: observationUrl(c.getURL()), parameters: request.parameters,
      pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration, controlEpoch: page.controlEpoch,
      browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
      threadId: request.threadId, turnId: request.turnId, callId: request.callId, expiresAt: Date.now() + 300000 };
    plan.fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    page.plans.set(plan.preparedActionId, { plan, pageUrl: c.getURL() });
    return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
      projectId: request.projectId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
      pageId: page.id, browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
      pageGeneration: page.pageGeneration, controlEpoch: page.controlEpoch, plan };
  }
  async executeRead(request) {
    const { page, c } = this.actionPage(request);
    const approved = request.browserApproval?.plan;
    const saved = approved && page.plans.get(approved.preparedActionId);
    if (!saved || !isDeepStrictEqual(saved.plan, approved) || saved.pageUrl !== c.getURL()
      || approved.operation !== request.operation || approved.threadId !== request.threadId
      || approved.turnId !== request.turnId || approved.callId !== request.callId || approved.expiresAt < Date.now()
      || approved.pageGeneration !== page.pageGeneration || approved.documentEpoch !== page.documentGeneration
      || approved.controlEpoch !== page.controlEpoch || !isDeepStrictEqual(approved.parameters, request.parameters))
      throw new Error('plan_stale');
    page.plans.delete(approved.preparedActionId);
    return request.operation === 'diagnostics' ? this.diagnostics(request) : this.observe(request);
  }
  async prepare(request) {
    if (request.phase !== 'prepare') throw new Error('not_sent');
    if (['observe', 'capture', 'diagnostics'].includes(request.operation)) return this.prepareRead(request);
    if (!['act', 'wait', 'navigate', 'newPage', 'runBatch'].includes(request.operation)) throw new Error('not_sent');
    if (request.operation === 'runBatch') return this.prepareBatch(request);
    if (['navigate', 'newPage'].includes(request.operation)) return this.prepareNavigation(request);
    const { page, c } = this.actionPage(request);
    const initialDocument = page.documentGeneration;
    const readiness = documentReadyWait(request.operation, request.parameters);
    for (const [id, record] of page.plans) if (record.plan.expiresAt < Date.now()) page.plans.delete(id);
    if (page.activeRead || page.activePrepare || page.activeAction
      || page.activeBatch
      || this.workspaceOutstanding(page.projectId, page.threadId) >= 16) throw new Error('not_sent');
    const url = new URL(c.getURL());
    const local = ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!local && !['http:', 'https:'].includes(url.protocol)) throw new Error('human_takeover_required');
    const needsRefs = request.operation === 'act' || request.parameters.condition?.kind === 'accessibleName';
    if ((needsRefs && (page.needsObservation || page.lastObservationTurnId !== request.turnId))
      || (request.operation === 'act' && request.parameters.snapshotId !== page.lastObservation)) throw new Error('stale_ref');
    const coordinate = request.operation === 'act' && coordinateKinds.has(request.parameters.action.kind);
    const capture = coordinate ? page.lastCapture : null;
    if (coordinate && (!capture || capture.observationId !== request.parameters.snapshotId
      || capture.pageGeneration !== page.pageGeneration || capture.documentEpoch !== page.documentGeneration
      || capture.controlEpoch !== page.controlEpoch || capture.viewportRevision !== page.viewportRevision)) throw new Error('stale_ref');
    let target = null;
    page.activePrepare = true;
    try {
      if (!c.debugger.isAttached()) c.debugger.attach('1.3');
      if (coordinate && !local) throw new Error('human_takeover_required');
      if (coordinate) target = coordinateTarget(capture, request.parameters.action);
      else if (request.operation === 'act') target = await (request.batchDeadline
        ? batchWithin(this.actionTarget(page, c, request.parameters.action.ref), request.batchDeadline)
        : this.actionTarget(page, c, request.parameters.action.ref));
      if (request.parameters.action?.kind === 'fill'
        && !/^(textField|textbox|searchbox|comboBox|spinbutton)$/i.test(target.role))
        throw new Error('target_unavailable');
      const semantics = !local && target ? await this.publicActionSemantics(page, c, target, request.parameters.action) : null;
      const viewport = readiness ? null : await (request.batchDeadline
        ? batchWithin(readIsolated(c, viewportScript), request.batchDeadline)
        : readIsolated(c, viewportScript));
      const viewportKey = readiness ? null : viewportFacts(this.window, page, viewport).key;
      if ((request.batchDeadline && performance.now() >= request.batchDeadline)
        || !this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== request.controlEpoch
        || page.pageGeneration !== request.pageGeneration || (!readiness && page.documentGeneration !== initialDocument) || c.isDestroyed()
        || (readiness ? new URL(c.getURL()).origin !== url.origin : c.getURL() !== url.href)) throw new Error('plan_stale');
      if (!readiness && page.viewportKey !== viewportKey) { page.viewportKey = viewportKey; page.viewportRevision++; }
      if (coordinate && (capture.viewportKey !== viewportKey || capture.url !== url.href)) throw new Error('plan_stale');
      const plan = { preparedActionId: randomUUID(), operation: request.operation, pageId: page.id,
        origin: url.origin, url: observationUrl(url.href),
        snapshotId: request.operation === 'act' ? request.parameters.snapshotId : null,
        target: target ? coordinate ? { ...target, captureId: capture.observationId,
          bitmapWidth: capture.bitmapWidth, bitmapHeight: capture.bitmapHeight }
          : { ref: request.parameters.action.ref, role: target.role, name: target.name, x: target.x, y: target.y, ...(semantics ? { semantics } : {}) } : null,
        action: request.operation === 'act' ? request.parameters.action : waitAction(request.parameters),
        pageGeneration: page.pageGeneration, documentEpoch: page.documentGeneration,
        controlEpoch: page.controlEpoch, viewportRevision: page.viewportRevision, viewportKey,
        browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
        threadId: request.threadId, turnId: request.turnId, callId: request.callId,
        expiresAt: Date.now() + 300000 };
      plan.fingerprint = createHash('sha256').update(JSON.stringify({ plan, targetIdentity: target?.identity })).digest('hex');
      page.plans.set(plan.preparedActionId, { plan, targetIdentity: target?.identity, pageUrl: url.href,
        waitIdentity: request.parameters.condition?.kind === 'accessibleName'
          ? this.refNode(page, request.parameters.condition.ref).identity : null });
      return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        projectId: request.projectId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
        pageId: page.id, browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
        pageGeneration: page.pageGeneration, controlEpoch: page.controlEpoch, plan };
    } finally {
      page.activePrepare = false;
      // Takeover convergence owns this channel after the Agent epoch ends.
      if (page.control === 'agent' && page.controlEpoch === request.controlEpoch
        && c.debugger.isAttached() && !page.diagnosticsReady) c.debugger.detach();
    }
  }
  async execute(request) {
    if (request.phase !== 'execute') throw new Error('not_sent');
    if (['observe', 'capture', 'diagnostics'].includes(request.operation)) return this.executeRead(request);
    if (!['act', 'wait', 'navigate', 'newPage', 'runBatch'].includes(request.operation)) throw new Error('not_sent');
    if (request.operation === 'runBatch') return this.executeBatch(request);
    if (['navigate', 'newPage'].includes(request.operation)) return this.executeNavigation(request);
    const { page, c } = this.actionPage(request);
    const approved = request.browserApproval?.plan;
    const saved = approved && page.plans.get(approved.preparedActionId);
    const readiness = documentReadyWait(request.operation, request.parameters);
    const nowViewport = readiness ? null : await (request.batchDeadline
      ? batchWithin(readIsolated(c, viewportScript), request.batchDeadline)
      : readIsolated(c, viewportScript));
    const nowKey = readiness ? null : viewportFacts(this.window, page, nowViewport).key;
    if (request.batchGuard?.()) throw new Error('not_sent');
    if (!saved || !isDeepStrictEqual(approved, saved.plan)
      || saved.plan.threadId !== request.threadId || saved.plan.turnId !== request.turnId
      || saved.plan.callId !== request.callId || saved.plan.operation !== request.operation
      || saved.plan.pageId !== request.pageId || saved.plan.expiresAt < Date.now()
      || saved.plan.origin !== new URL(c.getURL()).origin || (!readiness && saved.pageUrl !== c.getURL())
      || saved.plan.pageGeneration !== page.pageGeneration || (!readiness && saved.plan.documentEpoch !== page.documentGeneration)
      || saved.plan.controlEpoch !== page.controlEpoch || (!readiness && saved.plan.viewportRevision !== page.viewportRevision)
      || (!readiness && saved.plan.viewportKey !== nowKey)
      || (coordinateKinds.has(request.parameters.action?.kind)
        && page.lastCapture?.observationId !== saved.plan.target?.captureId)
      || saved.plan.snapshotId !== (request.operation === 'act' ? request.parameters.snapshotId : null)
      || !isDeepStrictEqual(saved.plan.action, request.operation === 'act'
        ? request.parameters.action : waitAction(request.parameters))) throw new Error('plan_stale');
    page.plans.delete(approved.preparedActionId);
    if (page.activeRead || page.activePrepare || page.activeAction || (page.activeBatch && !request.batchGuard)) throw new Error('not_sent');
    let cancelled;
    const stop = new Promise((_, reject) => { cancelled = reject; });
    const action = { requestId: request.requestId, syntheticInput: request.operation === 'act', dispatched: false, cancelled: false,
      cancel: () => { action.cancelled = true; cancelled(new Error(action.dispatched ? 'outcome_unknown' : 'not_sent')); } };
    page.activeAction = action;
    if (request.operation === 'act') {
      // A hidden View can retain keyboard focus. Move focus only if this page
      // owns the foreground window's native focus; never raise a background app.
      if (this.window.isFocused() && c.isFocused()) { this.nativeInputOwner = page.id; this.window.webContents.focus(); }
      page.view.setVisible(false);
    }
    const stepTimeout = request.operation === 'wait'
      ? Math.min(30000, request.parameters.timeoutMs + 1000)
      : request.parameters.action.kind === 'drag' ? 12000 : 5000;
    let waitResult;
    const deadline = setTimeout(() => action.cancel(), request.batchDeadline
      ? Math.max(1, Math.min(stepTimeout, request.batchDeadline - performance.now())) : stepTimeout);
    try {
      if (request.operation === 'wait') {
        const started = performance.now(), expires = started + request.parameters.timeoutMs;
        const condition = request.parameters.condition;
        if (!condition) {
          await Promise.race([new Promise(resolve => setTimeout(resolve, request.parameters.timeoutMs)), stop]);
        } else {
          if (!c.debugger.isAttached()) c.debugger.attach('1.3');
          const current = () => {
            this.actionPage(request);
            if (action.cancelled || request.batchGuard?.() || new URL(c.getURL()).origin !== saved.plan.origin
              || (!readiness && (c.getURL() !== saved.pageUrl || page.documentGeneration !== saved.plan.documentEpoch))) throw new Error('plan_stale');
          };
          const read = async promise => {
            const document = page.documentGeneration;
            try { return await Promise.race([nativeWithin(promise, expires), stop]); }
            catch (error) {
              current();
              if (performance.now() >= expires) throw new Error('condition_timeout');
              if (readiness && (c.isLoadingMainFrame() || page.documentGeneration !== document)) return null;
              throw error;
            }
          };
          for (;;) {
            current();
            let matched;
            if (condition.kind === 'documentReady') {
              const document = page.documentGeneration;
              const state = c.isLoadingMainFrame() ? null : await read(readIsolated(c, 'document.readyState'));
              matched = page.documentGeneration === document && !c.isLoadingMainFrame()
                && (state === condition.state || (condition.state === 'interactive' && state === 'complete'));
            } else {
              const node = this.refNode(page, condition.ref);
              if (node.identity !== saved.waitIdentity) throw new Error('stale_ref');
              const ax = await read(c.debugger.sendCommand('Accessibility.getPartialAXTree',
                { backendNodeId: node.backendNodeId, fetchRelatives: false }));
              const value = ax.nodes?.find(value => value.backendDOMNodeId === node.backendNodeId && !value.ignored);
              if (!value) throw new Error('stale_ref');
              matched = value.name?.value === condition.name;
            }
            current();
            if (matched) break;
            const remaining = expires - performance.now();
            if (remaining <= 0) throw new Error('condition_timeout');
            await Promise.race([new Promise(resolve => setTimeout(resolve, Math.min(100, remaining))), stop]);
            if (performance.now() >= expires) throw new Error('condition_timeout');
          }
        }
        waitResult = { condition: condition ?? null, satisfied: true,
          elapsedMs: Math.round(performance.now() - started) };
      } else {
        if (!c.debugger.isAttached()) c.debugger.attach('1.3');
        const coordinate = coordinateKinds.has(request.parameters.action.kind);
        let target = coordinate ? saved.plan.target
          : await Promise.race([this.actionTarget(page, c, request.parameters.action.ref), stop]);
        if (!coordinate && (target.identity !== saved.targetIdentity || target.x !== saved.plan.target.x || target.y !== saved.plan.target.y
          || target.role !== saved.plan.target.role || target.name !== saved.plan.target.name))
          throw new Error('plan_stale');
        await Promise.race([new Promise(resolve => setTimeout(resolve, 50)), stop]);
        if (!coordinate) target = await Promise.race([this.actionTarget(page, c, request.parameters.action.ref), stop]);
        const currentViewport = await Promise.race([readIsolated(c, viewportScript), stop]);
        if ((!coordinate && (target.identity !== saved.targetIdentity || target.x !== saved.plan.target.x || target.y !== saved.plan.target.y
          || target.role !== saved.plan.target.role || target.name !== saved.plan.target.name))
          || viewportFacts(this.window, page, currentViewport).key !== saved.plan.viewportKey
          || c.getURL() !== saved.pageUrl || page.controlEpoch !== saved.plan.controlEpoch)
          throw new Error('plan_stale');
        let navigationIntent = null;
        if (saved.plan.target?.semantics) {
          const semantics = await this.publicActionSemantics(page, c, target, request.parameters.action);
          if (!isDeepStrictEqual(semantics, saved.plan.target.semantics)) throw new Error('plan_stale');
          if (['public_search', 'link_navigation'].includes(semantics.kind)) navigationIntent = semantics;
        }
        // If the native page still owns local keyboard focus, do not dispatch.
        // before-input-event cannot distinguish a physical key from CDP echo.
        if (this.window.isFocused() && c.isFocused()) throw new Error('not_sent');
        const live = (releaseFrame = null) => {
          // Ref press 仅接受主文档；已确认 keyDown 的单次释放可跨子 Frame 失效，不能继续旧 Ref 动作。
          const releaseCurrent = releaseFrame !== null && (page.frameDocumentGeneration ?? 0) === releaseFrame
            && page.view?.webContents === c && page.pageGeneration === saved.plan.pageGeneration
            && this.browserHostId === request.browserHostId && this.hostGeneration === request.hostGeneration
            && page.coreInstanceId === request.coreInstanceId;
          if (action.cancelled || request.batchGuard?.() || !this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== saved.plan.controlEpoch
            || (page.documentGeneration !== saved.plan.documentEpoch && page.documentGeneration !== action.navigationDocument && !releaseCurrent)
            || page.viewportRevision !== saved.plan.viewportRevision
            || c.isDestroyed()) throw new Error(action.dispatched ? 'outcome_unknown' : 'plan_stale');
        };
        const input = params => { live(); action.dispatched = true; return this.dispatchInput(page, 'Input.dispatchMouseEvent', params); };
        const keyboard = (params, releaseFrame = null) => {
          live(params.type === 'keyUp' && page.heldKeys.has(params.key) ? releaseFrame : null);
          action.dispatched = true; return this.dispatchInput(page, 'Input.dispatchKeyEvent', params);
        };
        const click = async point => {
          await input({ type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
          await input({ type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
        };
        await Promise.race([(async () => {
          live();
          page.approvedActionNavigation = navigationIntent ? { ...navigationIntent,
            controlEpoch: page.controlEpoch, pageGeneration: page.pageGeneration, expiresAt: Date.now() + 30000 } : null;
          if (request.parameters.action.kind === 'drag') {
            const { from, to, steps } = target;
            await input({ type: 'mouseMoved', x: from.x, y: from.y, button: 'none' });
            await input({ type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1 });
            for (let step = 1; step <= steps; step++) await input({ type: 'mouseMoved',
              x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps,
              button: 'left', buttons: 1 });
            await input({ type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1 });
          } else if (request.parameters.action.kind === 'press') {
            live(); action.dispatched = true;
            await this.dispatchInput(page, 'DOM.focus', { backendNodeId: target.backendNodeId });
          } else await click(coordinate ? target.point : target);
          if (request.parameters.action.kind === 'fill') {
            const modifier = process.platform === 'darwin' ? 4 : 2;
            // macOS 的 CDP 输入还需显式编辑命令，单独的 Command+A 不会执行全选。
            await keyboard({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier,
              ...(process.platform === 'darwin' ? { commands: ['selectAll'] } : {}) });
            await keyboard({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: modifier });
            live(); action.dispatched = true;
            await this.dispatchInput(page, 'Input.insertText', { text: request.parameters.action.value });
          } else if (['press', 'pressAt'].includes(request.parameters.action.kind)) {
            const key = request.parameters.action.key;
            const code = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8,
              ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key];
            const text = key === 'Enter' ? '\r' : undefined;
            const releaseFrame = request.parameters.action.kind === 'press' ? page.frameDocumentGeneration ?? 0 : null;
            await keyboard({ type: 'keyDown', key, code: key, windowsVirtualKeyCode: code,
              ...(text ? { text, unmodifiedText: text } : {}) });
            // 仅成功 await 原生 keyDown ACK 后授予该 keyUp 释放资格；丢失 ACK 仍由撤权清理收敛。
            await keyboard({ type: 'keyUp', key, code: key, windowsVirtualKeyCode: code }, releaseFrame);
          }
        })(), stop]);
      }
      if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== saved.plan.controlEpoch)
        throw new Error(action.dispatched ? 'outcome_unknown' : 'not_sent');
      return { coreInstanceId: request.coreInstanceId, coreGeneration: request.coreGeneration,
        projectId: request.projectId, threadId: request.threadId, turnId: request.turnId, callId: request.callId,
        pageId: page.id, browserHostId: this.browserHostId, hostGeneration: this.hostGeneration,
        pageGeneration: page.pageGeneration, controlEpoch: page.controlEpoch,
        dispatch: action.dispatched ? 'confirmed' : 'not_sent', inputConfirmed: action.dispatched,
        verification: 'not_checked', ...(waitResult ? { wait: waitResult } : {}),
        preparedActionId: saved.plan.preparedActionId };
    } catch (error) {
      if (action.dispatched || action.cancelled) page.approvedActionNavigation = null;
      if (action.dispatched) throw new Error('outcome_unknown');
      throw error;
    } finally {
      clearTimeout(deadline);
      if (page.activeAction === action) page.activeAction = null;
      if (request.operation === 'act') page.lastCapture = null;
      if (page.control === 'agent' && page.controlEpoch === saved.plan.controlEpoch
        && page.inputPending.size === 0
        && page.heldButtons.size === 0 && page.heldKeys.size === 0) {
        if (!c.isDestroyed() && c.debugger.isAttached() && !page.diagnosticsReady) c.debugger.detach();
        page.view?.setVisible(this.pageStillOwned(page) && this.owner === pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id)
          && page.requestedVisible === true);
      } else if (page.control === 'agent' && page.controlEpoch === saved.plan.controlEpoch) {
        // Even a failed action must release native input before local input resumes.
        page.control = 'transferring'; page.controlEpoch++;
        page.refs.clear(); page.plans.clear(); page.lastObservation = null; page.needsObservation = true;
        this.onRevoke?.({ projectId: page.projectId, threadId: page.threadId, pageId: page.id });
        void this.convergeInput(page);
      }
    }
  }
  async observe(request) {
    const { projectId, threadId, pageId, browserHostId, hostGeneration, pageGeneration, controlEpoch,
      coreInstanceId, coreGeneration, turnId, callId } = request ?? {};
    const page = this.page(projectId, threadId, pageId);
    if (browserHostId !== this.browserHostId || hostGeneration !== this.hostGeneration || !page
      || coreInstanceId !== page.coreInstanceId
      || page.id !== pageId || page.pageGeneration !== pageGeneration || !this.owns(projectId, threadId))
      throw new Error('Browser page identity is stale');
    if (page.control !== 'agent' || page.controlEpoch !== controlEpoch) throw new Error('Human controls this page');
    const c = page.view?.webContents;
    if (!c) throw new Error('Browser page is unavailable');
    if (page.crashed || c.isDestroyed() || c.isDevToolsOpened()) throw new Error('Browser page is unavailable');
    if (page.activeRead || page.activePrepare || page.activeAction) throw new Error('Browser page is busy');
    const epoch = page.controlEpoch, documentGeneration = page.documentGeneration;
    let cancel;
    const invalidation = () => page.control !== 'agent' || page.controlEpoch !== epoch ? 'human_control' : 'plan_stale';
    const cancelled = new Promise((_, reject) => { cancel = reason => reject(new Error(reason ?? invalidation())); });
    const read = { requestId: request.requestId, cancel };
    page.activeRead = read;
    const timer = setTimeout(() => cancel('condition_timeout'), 10000);
    try {
      if (!c.debugger.isAttached()) c.debugger.attach('1.3');
      const operation = request.operation;
      if (operation !== 'observe' && operation !== 'capture') throw new Error('Unsupported browser operation');
      if (operation === 'capture') {
        const bounds = page.view.getBounds();
        if (!this.window.isVisible() || this.window.isMinimized() || !page.view.getVisible()
          || !page.requestedVisible || this.owner !== pageKey(page.coreInstanceId, projectId, threadId, pageId)
          || bounds.width <= 0 || bounds.height <= 0) throw new Error('Browser viewport unavailable');
      }
      const parameters = request.parameters ?? {};
      const tree = operation === 'observe'
        ? await Promise.race([c.debugger.sendCommand('Accessibility.getFullAXTree'), cancelled]) : null;
      const frames = operation === 'observe'
        ? await Promise.race([c.debugger.sendCommand('Page.getFrameTree'), cancelled]) : null;
      const viewport = await Promise.race([readIsolated(c, viewportScript), cancelled]);
      if (![viewport.width, viewport.height, viewport.scrollX, viewport.scrollY, viewport.deviceScaleFactor]
        .every(Number.isFinite) || viewport.width <= 0 || viewport.height <= 0 || viewport.deviceScaleFactor <= 0)
        throw new Error('Browser viewport unavailable');
      const facts = viewportFacts(this.window, page, viewport);
      const viewportKey = facts.key;
      if (page.viewportKey !== viewportKey) { page.viewportKey = viewportKey; page.viewportRevision++; }
      if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch
        || page.documentGeneration !== documentGeneration || c.isDestroyed()) throw new Error(invalidation());
      const base = { observationId: randomUUID(), coreInstanceId, coreGeneration, projectId, threadId, turnId, callId, pageId,
        browserHostId, hostGeneration, pageGeneration, nativeWebContentsId: c.id,
        url: observationUrl(c.getURL()), title: safeText(c.getTitle(), 256), documentEpoch: documentGeneration,
        controlEpoch: epoch, capturedAt: new Date().toISOString(), scope: operation === 'capture' ? 'viewport' : (parameters.scope ?? 'document'),
        viewport: { ...viewport, pageZoom: facts.pageZoom, guiZoom: facts.guiZoom,
          nativeBounds: facts.nativeBounds, viewportRevision: page.viewportRevision } };
      if (operation === 'capture') {
        // A known sensitive form or a DOM change during capture cannot be safely represented unmasked.
        const guardToken = randomUUID();
        const guardSequence = page.nextGuardSequence = (page.nextGuardSequence ?? 0) + 1;
        let image, postSensitive, changed = true;
        try {
          const watching = await Promise.race([readIsolated(c, captureGuardStartScript(guardToken, guardSequence)), cancelled]);
          if (watching !== true) throw new Error('Browser capture guard unavailable');
          const hasSensitive = await Promise.race([readIsolated(c, sensitiveCaptureScript()), cancelled]);
          if (typeof hasSensitive !== 'boolean') throw new Error('Browser sensitive-field check unavailable');
          if (hasSensitive) throw new Error('Sensitive field prevents automatic screenshot');
          image = await Promise.race([c.capturePage(), cancelled]);
          if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch
            || page.documentGeneration !== documentGeneration)
            throw new Error(invalidation());
          postSensitive = await Promise.race([readIsolated(c, sensitiveCaptureScript()), cancelled]);
        } finally {
          if (page.control === 'agent' && page.controlEpoch === epoch) changed = await Promise.race([
            readIsolated(c, captureGuardStopScript(guardToken, guardSequence)).catch(() => true),
            new Promise(resolve => setTimeout(() => resolve(true), 1000)),
          ]);
        }
        if (postSensitive !== false || changed !== false) throw new Error('Browser content changed during capture');
        const currentViewport = await Promise.race([readIsolated(c, viewportScript), cancelled]);
        if (viewportFacts(this.window, page, currentViewport).key !== viewportKey
          || !this.window.isVisible() || this.window.isMinimized() || !page.view.getVisible()
          || !page.requestedVisible || this.owner !== pageKey(page.coreInstanceId, projectId, threadId, pageId))
          throw new Error('Browser viewport changed during capture');
        const size = image.getSize();
        if (size.width <= 0 || size.height <= 0 || size.width * size.height > 8_000_000 || size.width > 4096 || size.height > 4096) throw new Error('Screenshot pixel budget exceeded');
        const png = image.toPNG();
        if (png.length > 2 * 1024 * 1024) throw new Error('Screenshot byte budget exceeded');
        if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch)
          throw new Error(invalidation());
        page.lastObservation = base.observationId;
        page.lastObservationTurnId = turnId;
        page.lastCapture = { observationId: base.observationId, pageGeneration: page.pageGeneration,
          documentEpoch: documentGeneration, controlEpoch: epoch, viewportRevision: page.viewportRevision,
          viewportKey, url: c.getURL(), width: viewport.width, height: viewport.height,
          bitmapWidth: size.width, bitmapHeight: size.height };
        page.needsObservation = false;
        return { ...base, capturedAt: new Date().toISOString(), viewport: { ...base.viewport, bitmapWidth: size.width, bitmapHeight: size.height }, mimeType: 'image/png', imageBase64: png.toString('base64'), byteLength: png.length };
      }
      const lines = [], entries = [], nodes = [], rawNodes = tree.nodes ?? [];
      const nodesById = new Map(rawNodes.map(node => [node.nodeId, node])), visitedNodes = new Set();
      // 原生数组可按增量分配次序返回；预算按 AX 父子阅读顺序裁剪，避免顶部控件被尾部索引遗漏。
      const appendTree = root => {
        const pending = [root];
        while (pending.length) {
          const node = pending.pop();
          if (visitedNodes.has(node.nodeId)) continue;
          visitedNodes.add(node.nodeId); nodes.push(node);
          for (const id of [...(node.childIds ?? [])].reverse()) {
            const child = nodesById.get(id);
            if (child) pending.push(child);
          }
        }
      };
      for (const node of rawNodes) if (!node.parentId || !nodesById.has(node.parentId)) appendTree(node);
      for (const node of rawNodes) appendTree(node);
      const liveIdentities = new Set(nodes.filter(node => node.backendDOMNodeId).map(node =>
        JSON.stringify([page.pageGeneration, documentGeneration, epoch, node.frameId ?? 'main', node.backendDOMNodeId])));
      const requestedIdentity = parameters.rootRef && [...page.refs].find(([, ref]) => ref === parameters.rootRef)?.[0];
      if (parameters.rootRef && !requestedIdentity) throw new Error('stale_ref');
      const requestedBackend = requestedIdentity && JSON.parse(requestedIdentity)[4];
      const rootNode = requestedBackend && nodes.find(node => node.backendDOMNodeId === requestedBackend);
      if (parameters.rootRef && !rootNode) throw new Error('stale_ref');
      const parent = new Map(nodes.map(node => [node.nodeId, node.parentId]));
      const descendant = node => { for (let id = node.nodeId; id; id = parent.get(id)) if (id === rootNode?.nodeId) return true; return false; };
      const sensitiveNodes = new Set(nodes.filter(node => /passwordField/i.test(String(node.role?.value ?? ''))
        || sensitive.test(String(node.name?.value ?? ''))
        || (/textField|textbox|searchbox|comboBox/i.test(String(node.role?.value ?? ''))
          && (node.properties ?? []).some(property => sensitive.test(String(property.name)) || sensitive.test(String(property.value?.value)))))
        .map(node => node.nodeId));
      const fieldNodes = new Set(nodes.filter(node => /^(textField|passwordField|textbox|searchbox|comboBox)$/i
        .test(String(node.role?.value ?? ''))).map(node => node.nodeId));
      const sensitiveChild = node => { for (let id = node.parentId; id; id = parent.get(id)) if (sensitiveNodes.has(id)) return true; return false; };
      const fieldChild = node => { for (let id = node.parentId; id; id = parent.get(id)) if (fieldNodes.has(id)) return true; return false; };
      const searchIntent = page.approvedActionNavigation, publicSearchFields = new Set();
      // 只豁免已批准且实际到达当前结果页的搜索字段；字段值及其子树仍不向模型投影。
      // 重用隔离世界的 GET/敏感表单判据，未知字段或同值私密字段继续污染回显集合。
      if (searchIntent?.kind === 'public_search' && searchIntent.controlEpoch === epoch
        && searchIntent.pageGeneration === page.pageGeneration && searchIntent.expiresAt >= Date.now()) {
        const destination = new URL(c.getURL());
        const queries = new URLSearchParams(searchIntent.submittedFields).getAll(searchIntent.queryName);
        if (destination.origin === searchIntent.targetOrigin && destination.pathname === searchIntent.targetPath
          && queries.length && isDeepStrictEqual(destination.searchParams.getAll(searchIntent.queryName), queries)) {
          for (const node of nodes) {
            if (!fieldNodes.has(node.nodeId) || sensitiveNodes.has(node.nodeId) || sensitiveChild(node)
              || !node.backendDOMNodeId || String(node.value?.value ?? '') !== searchIntent.query) continue;
            const semantics = await Promise.race([this.publicActionSemantics(page, c,
              { backendNodeId: node.backendDOMNodeId }, { kind: 'press', key: 'Enter' }, true).catch(() => null), cancelled]);
            if (semantics?.kind === 'public_search' && semantics.method === 'GET'
              && semantics.query === searchIntent.query && semantics.queryName === searchIntent.queryName
              && semantics.targetOrigin === searchIntent.targetOrigin && semantics.targetPath === searchIntent.targetPath
              && isDeepStrictEqual(new URLSearchParams(semantics.submittedFields).getAll(semantics.queryName), queries))
              publicSearchFields.add(node.nodeId);
          }
        }
        if (page.approvedActionNavigation !== searchIntent || searchIntent.expiresAt < Date.now()) publicSearchFields.clear();
      }
      if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch
        || page.documentGeneration !== documentGeneration || c.isDestroyed()) throw new Error(invalidation());
      const fieldValues = [...new Set(nodes.filter(node => fieldNodes.has(node.nodeId) && !publicSearchFields.has(node.nodeId))
        .map(node => String(node.value?.value ?? '')).filter(Boolean))];
      const fieldEcho = text => fieldValues.some(value => text === value || (value.length >= 3 && text.includes(value)));
      const limitNodes = parameters.budget?.nodes ?? 200;
      const limitBytes = parameters.budget?.textBytes ?? 32 * 1024;
      const nextRefs = new Map();
      const entryByNodeId = new Map();
      let textBytes = 0, truncated = false;
      for (const node of nodes) {
        if (node.ignored) continue;
        const role = String(node.role?.value ?? '').slice(0, 80);
        const rawName = String(node.name?.value ?? '');
        const propertySensitive = (node.properties ?? []).some(property => sensitive.test(String(property.name)) || sensitive.test(String(property.value?.value)));
        const sensitiveNode = sensitiveNodes.has(node.nodeId) || sensitiveChild(node) || propertySensitive;
        const concealed = sensitiveNode || fieldChild(node) || fieldEcho(rawName);
        // 隐私集合已覆盖完整 AX 树；只在最终投影省略无信息结构和逐字重复的行内文本。
        // 带名称、状态、值、描述或 Frame 身份的节点保留，父关联仍指向最近已输出祖先。
        const metadata = node.frameId || String(node.value?.value ?? '')
          || String(node.description?.value ?? '') || (node.properties ?? []).length;
        const nativeParent = nodesById.get(node.parentId);
        if (!concealed && !metadata && (role === 'generic' && !rawName
          || role === 'InlineTextBox' && String(nativeParent?.role?.value ?? '') === 'StaticText'
            && rawName === String(nativeParent.name?.value ?? '')
            && node.frameId === nativeParent.frameId)) continue;
        const name = concealed ? '[redacted]' : safeText(rawName);
        const value = concealed || /textField|passwordField|textbox|searchbox|comboBox/i.test(role)
          || sensitive.test(rawName) || propertySensitive || fieldEcho(String(node.value?.value ?? ''))
          ? '' : safeText(node.value?.value);
        const identity = node.backendDOMNodeId && JSON.stringify([page.pageGeneration, documentGeneration, epoch, node.frameId ?? 'main', node.backendDOMNodeId]);
        const interactive = interactiveRoles.has(role.toLowerCase()) && !concealed
          && (!fieldNodes.has(node.nodeId) || name.trim().length > 0);
        let ref;
        if (identity && interactive) {
          ref = page.refs.get(identity) ?? `r${++page.nextRef}`;
        }
        if (rootNode && !descendant(node)) continue;
        const line = [ref, role, name, value].filter(Boolean).join(': ');
        if (!line) continue;
        let ancestor = node.parentId;
        while (ancestor && !entryByNodeId.has(ancestor)) ancestor = parent.get(ancestor);
        const entry = { id: `n${entries.length + 1}`, role, name,
          ...(ancestor ? { parent: entryByNodeId.get(ancestor) } : {}),
          ...(node.frameId ? { frameId: node.frameId } : {}),
          ...(ref ? { ref } : {}),
          ...(value ? { value } : {}),
          ...(node.description?.value ? { description: concealed
            ? '[redacted]' : safeText(node.description.value) } : {}),
          state: Object.fromEntries((node.properties ?? [])
            .filter(property => ['checked', 'selected', 'disabled', 'expanded', 'required', 'invalid'].includes(property.name))
            .map(property => [property.name, safeText(property.value?.value, 80)])) };
        const bytes = Buffer.byteLength(line, 'utf8') + Buffer.byteLength(JSON.stringify(entry), 'utf8');
        if (lines.length >= limitNodes || textBytes + bytes > limitBytes) { truncated = true; break; }
        lines.push(line);
        if (ref) nextRefs.set(identity, ref);
        entries.push(entry);
        entryByNodeId.set(node.nodeId, entry.id);
        textBytes += bytes;
      }
      const retainedRefs = new Map([...page.refs].filter(([identity]) => liveIdentities.has(identity)));
      for (const [identity, ref] of nextRefs) {
        retainedRefs.delete(identity);
        retainedRefs.set(identity, ref);
      }
      let refsEvicted = 0;
      while (retainedRefs.size > MAX_REFS) {
        retainedRefs.delete(retainedRefs.keys().next().value);
        refsEvicted++;
      }
      page.refs = retainedRefs;
      const seenFrames = new Set(nodes.map(node => node.frameId).filter(Boolean));
      const childFrames = [];
      const walkFrames = (branch, root = false) => {
        if (!root) childFrames.push({ frameId: branch.frame.id, url: branch.frame.url ? observationUrl(branch.frame.url) : '',
          coverage: seenFrames.has(branch.frame.id) ? 'covered' : 'unavailable' });
        for (const child of branch.childFrames ?? []) walkFrames(child);
      };
      walkFrames(frames.frameTree, true);
      if (!this.pageStillOwned(page) || page.control !== 'agent' || page.controlEpoch !== epoch)
        throw new Error(invalidation());
      page.lastObservation = base.observationId;
      page.lastObservationTurnId = turnId;
      page.needsObservation = false;
      return { ...base, frameCoverage: { main: 'covered', childFrames },
        shadowCoverage: 'not-distinguished-by-accessibility-tree', dynamicCoverage: 'snapshot-at-capturedAt',
        truncated, truncationReason: truncated ? 'budget' : null,
        refCache: { capacity: MAX_REFS, evicted: refsEvicted },
        budget: { nodes: limitNodes, textBytes: limitBytes }, nodes: entries, text: lines.join('\n') };
    } finally {
      clearTimeout(timer);
      if (page.activeRead === read) {
        page.activeRead = null;
        try { if (page.control === 'agent' && page.controlEpoch === epoch
          && !c.isDestroyed() && c.debugger.isAttached() && !page.diagnosticsReady) c.debugger.detach(); }
        catch { /* A detached/crashed target already revoked this read. */ }
      }
    }
  }
  create(owner, projectId, threadId, options = {}) {
    this.reservePageSlot(projectId, threadId, options.replacing === true);
    const siblings = this.workspacePages(projectId, threadId);
    const partition = options.partition ?? siblings[0]?.partition ?? `areal-preview-${randomUUID()}`;
    const view = new this.WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition,
      },
    });
    const page = { id: options.id ?? randomUUID(), pageGeneration: options.pageGeneration ?? 1, view, partition,
      session: view.webContents.session, coreInstanceId: this.coreIdentity(projectId), projectId, threadId,
      openerId: options.openerId ?? null, origin: options.origin ?? 'human', title: '', error: '', url: '', committedUrl: '', crashed: false,
      control: 'human', controlEpoch: 0, documentGeneration: 0, viewportRevision: 0, refs: new Map(),
      plans: new Map(), lastObservation: null, needsObservation: true, nextRef: 0,
      heldButtons: new Map(), heldKeys: new Map(), inputPending: new Set(), requestedVisible: false,
      downloads: new Set(), downloadRecords: new Map(), dialogPending: false, fileHandoff: null,
      fileChooserIntercepted: false,
      stateLoss: options.stateLoss ?? null,
      diagnosticsReady: false, diagnosticsStartedAt: null, diagnosticEvents: [], diagnosticRequests: new Map(), diagnosticBytes: 0,
      diagnosticSequence: 0, diagnosticLoss: null },
      c = view.webContents;
    try { page.networkPolicy = this.ensureWorkspaceContext(page); }
    catch (error) { if (!c.isDestroyed()) c.close(); throw error; }
    c.on('console-message', details => {
      if (page.control !== 'agent' || !page.diagnosticsReady) return;
      const value = details && typeof details === 'object' ? details : {};
      this.addDiagnostic(page, { kind: 'console', level: ['error', 'warning', 'info', 'debug'].includes(value.level) ? value.level : 'log',
        message: diagnosticText(value.message), source: diagnosticUrl(value.sourceId),
        line: Number.isSafeInteger(value.lineNumber) ? value.lineNumber : null });
    });
    c.debugger.on('message', (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') {
        if (page.control === 'agent') this.revoke(page);
        return;
      }
      if (!page.diagnosticsReady || page.control !== 'agent' || !this.pageStillOwned(page)) return;
      if (method === 'Network.requestWillBeSent') {
        if (typeof params?.requestId !== 'string') return;
        // CDP's wallTime is the request's creation time. Reject any event
        // queued from the prior human phase, including one delivered late.
        if (!Number.isFinite(params.wallTime) || params.wallTime < page.diagnosticsStartedAt) {
          page.diagnosticLoss = { after: page.diagnosticSequence, reason: 'unattributed_request' };
          return;
        }
        const previous = page.diagnosticRequests.get(params.requestId);
        if (previous && previous.controlEpoch === page.controlEpoch && params.redirectResponse) {
          this.addDiagnostic(page, { kind: 'network', url: previous.url, method: previous.method,
            status: Number.isSafeInteger(params.redirectResponse.status) ? params.redirectResponse.status : null,
            resourceType: previous.resourceType ?? null, failure: null,
            documentEpoch: previous.documentEpoch });
        }
        const request = params.request ?? {};
        page.diagnosticRequests.set(params.requestId, { url: diagnosticUrl(request.url),
          method: /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(request.method) ? request.method : 'OTHER',
          documentEpoch: page.documentGeneration, controlEpoch: page.controlEpoch });
        while (page.diagnosticRequests.size > MAX_DIAGNOSTICS) {
          page.diagnosticRequests.delete(page.diagnosticRequests.keys().next().value);
          page.diagnosticLoss = { after: page.diagnosticSequence, reason: 'request_map_evicted' };
        }
      } else if (method === 'Network.responseReceived') {
        const request = page.diagnosticRequests.get(params?.requestId);
        if (!request || request.controlEpoch !== page.controlEpoch) return;
        request.status = Number.isSafeInteger(params.response?.status) ? params.response.status : null;
        request.resourceType = diagnosticText(params.type, 40);
      } else if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
        const request = page.diagnosticRequests.get(params?.requestId);
        if (!request) return;
        page.diagnosticRequests.delete(params.requestId);
        if (request.controlEpoch !== page.controlEpoch) return;
        this.addDiagnostic(page, { kind: 'network', url: request.url, method: request.method,
          status: request.status ?? null, resourceType: request.resourceType ?? null,
          failure: method === 'Network.loadingFailed' ? diagnosticText(params.errorText, 120) : null,
          documentEpoch: request.documentEpoch });
      }
    });
    c.debugger.on('detach', () => {
      page.fileChooserIntercepted = false;
      this.clearDiagnostics(page, 'debugger_detached');
      if (page.control === 'agent') this.revoke(page);
    });
    c.on('devtools-opened', () => { page.openingDevTools = null; if (page.styleTrial) page.styleTrial.stale = true; this.revoke(page); });
    c.on('devtools-closed', () => {
      if (!this.pageStillOwned(page)) return;
      page.pageGeneration++; page.documentGeneration++; this.cancelHumanGesture(page); page.refs.clear(); page.plans.clear();
      page.needsObservation = true; this.clearDiagnostics(page, 'devtools_closed'); this.changed(page);
    });
    page.onDownload = (event, item, source) => {
      if (source !== c) {
        // No page listener owns downloads started by Session APIs or an
        // already released WebContents; do not let Electron choose a path.
        if (![...this.pages.values()].some(other => other.session === c.session && other.view?.webContents === source))
          event.preventDefault();
        return;
      }
      const intent = page.fileHandoff;
      const key = pageKey(page.coreInstanceId, projectId, threadId, page.id);
      const current = () => this.pageStillOwned(page) && page.view?.webContents === c
        && this.owner === key && this.selected.get(workspaceKey(page.coreInstanceId, projectId, threadId)) === page.id
        && page.control === 'human' && page.controlEpoch === intent?.controlEpoch
        && page.pageGeneration === intent?.pageGeneration
        // A download link may start navigation without committing a new
        // document; it remains the original Page only while getURL is unchanged.
        && [intent?.documentGeneration, intent?.documentGeneration + 1].includes(page.documentGeneration)
        && c.getURL() === intent?.url
        && page.requestedVisible && page.view.getVisible() && this.window.isVisible()
        && !this.window.isMinimized() && this.window.isFocused() && !c.isDestroyed() && !page.crashed;
      if (!intent || intent.kind !== 'download' || Date.now() > intent.expiresAt
        || !current() || page.downloads.size >= 1) {
        event.preventDefault();
        if (this.pageStillOwned(page)) {
          page.error = '下载需要当前页面的明确文件交接；未保存文件';
          this.changed(page);
        }
        return;
      }
      clearTimeout(intent.timer); page.fileHandoff = null;
      const total = item.getTotalBytes();
      const id = randomUUID();
      let pageOrigin = 'unknown';
      try { pageOrigin = new URL(c.getURL()).origin; } catch { /* Current Page origin stays unknown. */ }
      const record = { id, pageId: page.id, threadId, openerId: page.openerId,
        pageOrigin, initiator: 'unknown', source: diagnosticUrl(item.getURL()),
        name: safeText(basename(item.getFilename()), 120),
        sizeBytes: Number.isSafeInteger(total) && total > 0 ? total : null,
        receivedBytes: 0, target: null, status: 'choosing', reason: null,
        networkOutcome: 'unknown' };
      if (record.sizeBytes !== null && record.sizeBytes > MAX_FILE_BYTES) {
        event.preventDefault(); record.status = 'cancelled'; record.reason = 'size_limit';
        this.fileReceipt(page, record); return;
      }
      // Electron opens its native Save dialog before creating a destination.
      // setSavePath is intentionally absent: only the user supplies a path.
      try { item.setSaveDialogOptions({ title: '保存网页下载', message: `${pageOrigin} · 最大 64 MiB` }); }
      catch {
        event.preventDefault(); record.status = 'cancelled'; record.reason = 'native_dialog_unavailable';
        this.fileReceipt(page, record); return;
      }
      page.downloads.add(item);
      page.downloadRecords.set(item, record);
      record.timer = setTimeout(() => {
        if (page.downloads.has(item)) {
          record.status = 'unknown'; record.reason = 'download_timeout_after_dispatch';
          item.cancel(); this.fileReceipt(page, record);
        }
      }, DOWNLOAD_TIMEOUT_MS);
      item.on('updated', (_event, state) => {
        if (!page.downloads.has(item)) return;
        const received = item.getReceivedBytes();
        record.receivedBytes = Number.isSafeInteger(received) && received >= 0 ? received : record.receivedBytes;
        const target = item.getSavePath();
        if (target) record.target = safeText(basename(target), 120);
        if (record.receivedBytes > MAX_FILE_BYTES) {
          record.status = 'unknown'; record.reason = 'size_limit_after_dispatch'; item.cancel();
        } else if (record.status !== 'unknown') record.status = state === 'interrupted' ? 'interrupted' : 'downloading';
        this.fileReceipt(page, record);
      });
      item.once('done', (_event, state) => {
        clearTimeout(record.timer); delete record.timer;
        // Closing a Page removes its ownership before Electron settles the
        // cancelled DownloadItem. Its late callback must not restore receipts.
        if (!this.pageStillOwned(page) || page.downloadRecords.get(item) !== record) return;
        page.downloads.delete(item); page.downloadRecords.delete(item);
        const target = item.getSavePath();
        if (target) record.target = safeText(basename(target), 120);
        if (record.status !== 'unknown') record.status = ['completed', 'cancelled', 'interrupted'].includes(state) ? state : 'unknown';
        if (state === 'cancelled' && !target && !record.reason) record.reason = 'chooser_cancelled';
        this.fileReceipt(page, record);
      });
      this.fileReceipt(page, record);
    };
    c.session.on('will-download', page.onDownload);
    c.setWindowOpenHandler(details => {
      // Electron must never create an unowned BrowserWindow. A local human click
      // may create a sibling only after URL and current ownership checks.
      if (page.control !== 'human' || !this.pageStillOwned(page) || !this.owns(projectId, threadId)
        || page.coreInstanceId !== this.coreIdentity(projectId)
        || Date.now() > (page.userPopupIntentUntil ?? 0))
        return { action: 'deny' };
      page.userPopupIntentUntil = 0;
      let url;
      let source;
      try { url = webUrl(details.url); source = new URL(c.getURL()); }
      catch { return { action: 'deny' }; }
      // A popup can reuse the existing site context; it cannot create a new
      // network grant from page-controlled URL text, even after a local click.
      if (new URL(url).origin !== source.origin
        || !page.networkPolicy.permits({ url, resourceType: 'mainFrame' })) return { action: 'deny' };
      if (!['foreground-tab', 'background-tab', 'new-window'].includes(details.disposition))
        return { action: 'deny' };
      const id = randomUUID();
      let child;
      try { child = this.create(pageKey(page.coreInstanceId, projectId, threadId, id), projectId, threadId,
        { id, openerId: page.id, origin: c.isFocused() ? 'human' : 'unknown' }); }
      catch (error) { page.error = error.message; this.changed(page); return { action: 'deny' }; }
      if (c.isFocused() && details.disposition !== 'background-tab')
        this.selected.set(workspaceKey(page.coreInstanceId, projectId, threadId), child.id);
      child.url = url;
      void child.view.webContents.loadURL(url).catch(error => {
        if (this.pageStillOwned(child) && error.code !== 'ERR_ABORTED' && error.errno !== -3) child.error = error.message;
      });
      this.changed(child);
      return { action: 'deny' };
    });
    c.session.setPermissionRequestHandler((_contents, _permission, respond) =>
      respond(false),
    );
    c.session.setPermissionCheckHandler(() => false);
    const navigate = (event, url) => {
      try {
        webUrl(url);
        if (page.frameGrant || !page.networkPolicy.permits({ url, resourceType: 'mainFrame' })) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    };
    c.on("will-navigate", navigate);
    c.on("will-redirect", navigate);
    c.on("will-frame-navigate", (event) => {
      try {
        webUrl(event.url);
        if (!page.networkPolicy.permits({ url: event.url, resourceType: event.isMainFrame ? 'mainFrame' : 'subFrame',
          webContentsId: c.id, frame: event.frame })) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    c.on("did-start-navigation", (_event, url, inPlace, main) => {
      if (!this.pageStillOwned(page)) return;
      page.dialogPending = false;
      page.activeSelection?.cancel();
      if (main) {
        page.frameDocumentGeneration = (page.frameDocumentGeneration ?? 0) + 1;
        if (page.frameGrant) {
          const grant = page.frameGrant;
          if (grant.status === 'reloading' && !grant.navigationStarted && !inPlace && url === grant.parentURL) {
            grant.navigationStarted = true; grant.documentGeneration = page.frameDocumentGeneration;
          } else {
            page.activeRead?.cancel(); this.closeNative(page);
            page.stateLoss = '嵌入授权因文档变化已撤销，页面已关闭'; this.changed(page); return;
          }
        }
        // A new document discards its inline trial values. A same-document
        // navigation may retain them, so fence the trial until an explicit
        // refresh; never auto-reload and discard an unsaved form.
        if (page.styleTrial) {
          if (inPlace) page.styleTrial.stale = true;
          else page.styleTrial = null;
        }
        page.activeRead?.cancel('plan_stale');
        // 同文档且完整 URL 未变的 history 更新不产生新导航权限；旧观察仍在下方失效。
        const unchangedDocument = inPlace === true && !!page.committedUrl && url === page.committedUrl;
        const approvedAction = !unchangedDocument && this.acceptActionNavigation(page, url);
        if (!unchangedDocument) {
          if (page.approvedNavigation === url) page.approvedNavigation = null;
          else if (!approvedAction) this.revoke(page);
        }
        page.documentGeneration++;
        this.cancelHumanGesture(page);
        if ((approvedAction || (unchangedDocument && page.control === 'agent')) && page.activeAction) page.activeAction.navigationDocument = page.documentGeneration;
        page.needsObservation = true;
        page.refs.clear(); invalidateDocumentPlans(page);
        page.url = url;
        page.error = "";
      } else {
        page.documentGeneration++;
        this.cancelHumanGesture(page);
        // 按键释放可完成，但后续动作仍须重新观察，不能沿用子 Frame 变化前的计划。
        page.needsObservation = true;
        page.refs.clear(); invalidateDocumentPlans(page);
        page.activeRead?.cancel('plan_stale');
      }
      if (this.pageStillOwned(page)) this.changed(page);
    });
    const commitNavigation = url => {
      if (!this.pageStillOwned(page)) return;
      if (page.frameGrant && url !== page.frameGrant.parentURL) {
        page.activeRead?.cancel(); this.closeNative(page);
        page.stateLoss = '嵌入授权因文档变化已撤销，页面已关闭'; this.changed(page); return;
      }
      if (page.frameGrant?.status === 'reloading' && page.frameGrant.navigationStarted
        && page.frameGrant.valid() && url === page.frameGrant.parentURL) page.frameGrant.status = 'active';
      page.committedUrl = url;
      page.url = url;
      if (page.fileHandoff) {
        clearTimeout(page.fileHandoff.timer);
        page.fileHandoff = null;
      }
      this.changed(page);
    };
    // A download link can start navigation without committing a document.
    // Keep the arm through that start, but never carry it into a new Page URL.
    c.on('did-navigate', (_event, url) => commitNavigation(url));
    c.on('did-navigate-in-page', (_event, url, main) => { if (main) commitNavigation(url); });
    c.on("did-fail-load", (_event, code, message, url, main) => {
      if (!this.pageStillOwned(page)) return;
      page.dialogPending = false;
      if (main && code !== -3 && url === page.url) page.error = message;
      if (this.pageStillOwned(page)) this.changed(page);
    });
    c.on('did-finish-load', () => {
      if (!this.pageStillOwned(page)) return;
      page.dialogPending = false;
      this.changed(page);
    });
    c.on('will-prevent-unload', () => {
      if (!this.pageStillOwned(page)) return;
      page.dialogPending = true;
      this.changed(page);
    });
    c.on('page-title-updated', () => { if (this.pageStillOwned(page)) this.changed(page); });
    c.on('render-process-gone', () => {
      if (this.pages.get(owner) !== page) return;
      page.title = c.isDestroyed() ? page.title : c.getTitle() || page.title;
      // A started download navigation has no committed document. Restoring its
      // provisional URL would repeat an UNKNOWN transfer after a renderer crash.
      page.url = page.committedUrl;
      this.revoke(page);
      this.cancelFileOperations(page, 'native_crash_after_dispatch');
      page.crashed = true;
      page.error = '预览页面已退出，请重新加载';
      this.changed(page);
    });
    c.on('before-input-event', (event, input) => {
      if (!this.pageStillOwned(page)) { event.preventDefault(); return; }
      // 仅当前台窗口中当前可见页面由人工控制时，才允许将焦点移回应用。
      if (input.type === 'keyDown' && input.key === 'F6' && !input.isAutoRepeat
        && page.control === 'human' && this.owns(projectId, threadId)
        && this.owner === pageKey(page.coreInstanceId, projectId, threadId, page.id)
        && page.view.getVisible() && this.window.isFocused() && c.isFocused()) {
        event.preventDefault(); this.nativeInputOwner = null; this.window.webContents.focus(); return;
      }
      if (page.control === 'human' && c.isFocused() && input.type === 'keyDown'
        && ['Enter', 'Space'].includes(input.key)) page.userPopupIntentUntil = Date.now() + 1000;
      // CDP keys may echo while the native view is hidden. Only an action on a
      // page without native focus may pass here; a focused page is local input.
      if (page.control === 'agent' && (!page.activeAction?.syntheticInput || page.view.getVisible()
        || (this.window.isFocused() && c.isFocused()))) {
        event.preventDefault();
        void this.humanKey(page, input).catch(() => {});
      } else if (page.control === 'transferring') event.preventDefault();
      else if (page.control === 'human') this.noteHumanInput(page);
    });
    c.on('before-mouse-event', (event, mouse) => {
      if (!this.pageStillOwned(page)) { event.preventDefault(); return; }
      if (page.control === 'human' && mouse.type === 'mouseUp' && this.humanMouseGesture?.page === page)
        this.humanMouseGesture = null;
      if (page.control === 'human' && mouse.type === 'mouseDown' && c.isFocused())
        page.userPopupIntentUntil = Date.now() + 1000;
      if (page.control === 'agent' && page.view.getVisible() && ['mouseDown', 'mouseWheel'].includes(mouse.type)) {
        event.preventDefault(); this.nativeInputOwner = page.id;
        void this.humanInput(projectId, threadId, page.id, mouse).catch(() => {});
      } else if (page.control === 'transferring') event.preventDefault();
      else if (page.control === 'human' && ['mouseDown', 'mouseWheel'].includes(mouse.type)) {
        this.noteHumanInput(page);
      }
    });
    c.on('focus', () => { if (this.pageStillOwned(page) && this.window.isFocused()) this.nativeInputOwner = page.id; });
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    this.pages.set(owner, page);
    const workspace = workspaceKey(this.coreIdentity(projectId), projectId, threadId);
    if (!this.selected.has(workspace)) this.selected.set(workspace, page.id);
    this.changed(page, 'pageAdded');
    return page;
  }
  async frameOriginCommand(page, operation) {
    const c = page?.view?.webContents;
    const fence = page && this.developmentPromptFence(page);
    const valid = () => !!c && !c.isDestroyed() && this.currentDevelopmentPrompt(page, fence)
      && this.window.isVisible() && !this.window.isMinimized() && this.window.isFocused()
      && page.view.getVisible() && !c.isDevToolsOpened() && !page.activeRead && !page.activeSelection
      && !page.activeAction && !page.activePrepare && !page.claiming && !page.styleTrial
      && !page.fileHandoff && !page.downloads.size && !page.dialogPending;
    if (operation === 'revokeFrameOrigin') {
      if (!page || !this.pageStillOwned(page) || page.control !== 'human') throw new Error('页面归属已变化');
      if (!page.frameGrant) throw new Error('嵌入站点授权已失效');
      this.release(pageKey(page.coreInstanceId, page.projectId, page.threadId, page.id));
      return this.state(this.page(page.projectId, page.threadId));
    }
    if (!valid()) throw new Error('请先接管并显示当前页面，再授权嵌入站点');
    if (operation === 'reloadFrameOrigin') {
      const grant = page.frameGrant;
      if (!grant || grant.status !== 'pending' || Date.now() > grant.expiresAt
        || !this.currentDevelopmentPrompt(page, grant.fence) || c.getURL() !== grant.parentURL)
        throw new Error('嵌入站点授权已失效，请重新授权');
      grant.status = 'reloading'; grant.navigationStarted = false;
      page.networkPolicy.bindFrameGrant(grant);
      c.reload(); this.changed(page); return this.state(page);
    }
    if (page.frameGrant || page.pendingDevelopmentPrompt) throw new Error('已有嵌入站点授权或确认正在进行');
    const source = c.getURL(), parentOrigin = new URL(source).origin;
    const origins = await nativeWithin(readIsolated(c, `(() => [...new Set([...document.querySelectorAll('iframe,frame')].map(frame => {
      try { const url = new URL(frame.getAttribute('src'), document.baseURI); return ['http:', 'https:'].includes(url.protocol)
        && !url.username && !url.password && url.origin !== location.origin ? url.origin : null; } catch { return null; }
    }).filter(Boolean))])()`), performance.now() + 5000);
    if (!valid() || c.getURL() !== source || !Array.isArray(origins) || origins.length !== 1
      || origins[0] === parentOrigin || !page.networkPolicy.canAuthorize(origins[0]))
      throw new Error('当前页面需要恰好一个可授权的独立嵌入站点');
    const prompt = page.pendingDevelopmentPrompt = randomUUID();
    let confirmed;
    try { confirmed = await this.confirmDevelopmentOrigin({ kind: 'frame', origin: origins[0], page, fence }); }
    finally { if (page.pendingDevelopmentPrompt === prompt) page.pendingDevelopmentPrompt = null; }
    if (!confirmed || !valid() || c.getURL() !== source) throw new Error('嵌入站点授权已取消或失效');
    const grant = { origin: origins[0], parentURL: source, contents: c, fence, status: 'pending',
      expiresAt: Date.now() + 60000, documentGeneration: page.frameDocumentGeneration ?? 0 };
    grant.valid = () => page.frameGrant === grant && this.pageStillOwned(page) && page.view?.webContents === c
      && !c.isDestroyed() && page.control === 'human' && page.pageGeneration === fence.pageGeneration
      && page.controlEpoch === fence.controlEpoch && (page.frameDocumentGeneration ?? 0) === grant.documentGeneration;
    page.frameGrant = grant; this.changed(page); return this.state(page);
  }
  async command(request) {
    validatePreview(request);
    const workspace = workspaceKey(this.coreIdentity(request.projectId), request.projectId, request.threadId);
    let page = this.page(request.projectId, request.threadId, request.pageId);
    let key = page && pageKey(page.coreInstanceId, request.projectId, request.threadId, page.id);
    if (!page && request.operation === 'state') {
      page = this.page(request.projectId, request.threadId);
      key = page && pageKey(page.coreInstanceId, request.projectId, request.threadId, page.id);
    }
    if (request.pageId && !page && !['state', 'endRegion'].includes(request.operation)) throw new Error('页面已关闭');
    if (request.operation === 'subscribe') return this.snapshot(request.projectId, request.threadId);
    // A read must not touch LRU order or publish another metadata event.
    if (request.operation === 'state') return page ? this.state(page)
      : { ...this.state(null), workspace: this.snapshot(request.projectId, request.threadId) };
    if (['authorizeFrameOrigin', 'reloadFrameOrigin', 'revokeFrameOrigin'].includes(request.operation))
      return this.frameOriginCommand(page, request.operation);
    if (page?.frameGrant && ['navigate', 'back', 'forward', 'reload', 'devtools'].includes(request.operation))
      throw new Error('请先撤销嵌入站点授权并关闭页面，再导航或打开开发者工具');
    if (request.operation === 'release') {
      if (!page) return this.state(null);
      if (page.origin !== 'agent' && request.userIntent !== true) throw new Error('关闭人工页面需要明确用户操作');
      this.release(key); return this.state(this.page(request.projectId, request.threadId));
    }
    if (request.operation === 'allowNextDownload') {
      const c = page?.view?.webContents;
      if (request.userIntent !== true || !page || page.id !== request.pageId || !c
        || !this.pageStillOwned(page) || page.control !== 'human' || page.crashed || c.isDestroyed()
        || c.isDevToolsOpened() || page.fileHandoff || page.downloads.size || page.annotationCaptureId
        || page.styleTrial
        || page.activeSelection || page.activeRead || page.activePrepare || page.activeAction || page.claiming
        || page.dialogPending || !c.getURL()
        || this.owner !== key || this.selected.get(workspace) !== page.id || !page.requestedVisible
        || !page.view.getVisible() || !this.window.isVisible() || this.window.isMinimized()
        || !this.window.isFocused()) throw new Error('请先接管并显示当前页面，再允许下一次下载');
      const intent = { kind: 'download', pageGeneration: page.pageGeneration,
        documentGeneration: page.documentGeneration, controlEpoch: page.controlEpoch,
        url: c.getURL(), expiresAt: Date.now() + DOWNLOAD_INTENT_MS };
      intent.timer = setTimeout(() => {
        if (page.fileHandoff === intent) { page.fileHandoff = null; this.changed(page); }
      }, DOWNLOAD_INTENT_MS);
      page.fileHandoff = intent;
      this.changed(page);
      return this.state(page);
    }
    if (request.operation === 'cancelFileHandoff') {
      if (!page || page.id !== request.pageId || page.control !== 'human' || !this.pageStillOwned(page))
        throw new Error('文件交接页面已变化');
      if (page.fileHandoff?.timer) clearTimeout(page.fileHandoff.timer);
      page.fileHandoff = null; this.changed(page);
      return this.state(page);
    }
    if (request.operation === 'cancelDownload') {
      if (request.userIntent !== true || !page || page.id !== request.pageId
        || !this.pageStillOwned(page) || page.control !== 'human') throw new Error('文件交接页面已变化');
      const entry = [...page.downloadRecords].find(([, record]) => record.id === request.downloadId);
      if (!entry) throw new Error('下载已结束');
      const [item, record] = entry;
      record.status = 'unknown'; record.reason = 'user_cancelled_after_dispatch';
      record.networkOutcome = 'unknown';
      this.fileReceipt(page, record);
      item.cancel();
      return this.state(page);
    }
    if (request.operation === 'captureRegion')
      return this.captureRegion(request.projectId, request.threadId, request.pageId);
    if (request.operation === 'captureElement')
      return this.captureElement(request.projectId, request.threadId, request.pageId);
    if (request.operation === 'cancelElementSelection') {
      page?.activeSelection?.cancel();
      return this.state(page);
    }
    if (request.operation === 'selectElement')
      return this.selectElement(request.projectId, request.threadId, request.pageId, request.captureId, request.x, request.y);
    if (request.operation === 'checkElement')
      return this.checkElement(request.projectId, request.threadId, request.pageId, request.captureId, request.elementId);
    if (request.operation === 'beginStyleTrial')
      return this.beginStyleTrial(request.projectId, request.threadId, request.pageId, request.captureId, request.elementId);
    if (['applyStyleTrial', 'undoStyleTrial', 'redoStyleTrial'].includes(request.operation))
      return this.styleTrialCommand(request.projectId, request.threadId, request.pageId,
        request.trialId, request.operation, request.property, request.value);
    if (request.operation === 'styleTrialState') {
      const trial = page?.styleTrial;
      if (!trial || trial.trialId !== request.trialId) throw new Error('页面试改已失效');
      return this.styleTrialState(trial);
    }
    if (request.operation === 'captureStyleTrialAfter')
      return this.captureStyleTrialAfter(request.projectId, request.threadId, request.pageId, request.trialId);
    if (request.operation === 'clearStyleTrial') {
      if (!page?.styleTrial || page.styleTrial.trialId !== request.trialId) throw new Error('页面试改已失效');
      return this.clearStyleTrial(page);
    }
    if (request.operation === 'endRegion') {
      if (!page) return this.state(null);
      if (!this.owns(request.projectId, request.threadId) || page.annotationCaptureId !== request.captureId)
        throw new Error('标注页面已变化');
      if (page.control === 'human') page.activeRead?.cancel();
      await this.discardAnnotationCapture(page, request.captureId);
      return this.state(page);
    }
    if (request.operation === 'hide') {
      this.cancelHumanGesture(page ?? this.pages.get(this.owner));
      const hidden = page ?? (!request.projectId ? this.pages.get(this.owner) : null);
      const frozen = hidden?.annotationCapture;
      // 只有本页当前截图凭据允许标注临时隐藏；卸载和普通隐藏必须销毁授权文档。
      const annotationHide = !!request.captureId && !!hidden && this.pageStillOwned(hidden)
        && request.captureId === hidden.annotationCaptureId && hidden.control === 'human'
        && frozen?.nativeWebContentsId === hidden.view?.webContents.id
        && frozen?.pageGeneration === hidden.pageGeneration && frozen?.controlEpoch === hidden.controlEpoch;
      if (page) {
        page.requestedVisible = false; page.activeSelection?.cancel();
        if (page.fileHandoff?.timer) clearTimeout(page.fileHandoff.timer);
        page.fileHandoff = null;
        if (page.control === 'human' && page.annotationCaptureId) page.activeRead?.cancel();
      }
      if (!request.projectId || this.owner === key) {
        if (!page) { const displayed = this.pages.get(this.owner); if (displayed) displayed.requestedVisible = false; }
        this.view?.setVisible(false);
        this.owner = null; this.view = null;
      }
      if (hidden?.frameGrant && !annotationHide) {
        hidden.activeRead?.cancel(); this.closeNative(hidden);
        hidden.stateLoss = '嵌入授权因关闭预览已撤销，页面已关闭'; this.changed(hidden);
      }
      return this.state(page);
    }
    if (request.operation !== 'state' && (!this.owns(request.projectId, request.threadId)
      || !this.coreIdentity(request.projectId)))
      throw new Error('请选择已连接 Core 的有效任务');
    if (request.operation === 'openLink') {
      const url = webUrl(request.url), host = new URL(url).hostname;
      if (!(page?.networkPolicy ?? new WorkspaceNetworkPolicy(this.controlEndpoints)).canAuthorize(url))
        throw new Error('浏览安全策略拒绝该地址');
      const local = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127\./.test(host);
      const settings = this.preferences();
      const destination = local ? settings.browserLocalTarget ?? 'internal' : settings.browserLinkTarget ?? 'external';
      if (destination === 'external') await require('electron').shell.openExternal(url);
      return { destination, url };
    }
    if (request.operation === 'newPage') {
      const id = randomUUID();
      const child = this.create(pageKey(this.coreIdentity(request.projectId), request.projectId, request.threadId, id), request.projectId, request.threadId,
        { id, openerId: page?.id ?? null, origin: 'human' });
      this.selected.set(workspace, child.id);
      this.changed(child);
      return this.state(child);
    }
    const target = request.operation === 'navigate' ? webUrl(request.url) : null;
    const restoreUrl = page?.url || request.url;
    if (page && (!page.view || page.crashed || page.view.webContents.isDestroyed())
      && ['show', 'navigate', 'reload'].includes(request.operation)) {
      const previous = page;
      this.reservePageSlot(request.projectId, request.threadId, true, previous);
      const wasSelected = this.selected.get(workspace) === previous.id;
      const saved = { id: previous.id, pageGeneration: previous.pageGeneration + 1,
        partition: previous.partition, openerId: previous.openerId, origin: previous.origin,
        stateLoss: previous.stateLoss ?? (previous.crashed ? '页面崩溃；只恢复网址，表单和临时登录可能需要重做' : null),
        replacing: true };
      this.release(key, { preserveContext: true });
      page = this.create(key, request.projectId, request.threadId, saved);
      page.title = previous.title;
      page.url = previous.url;
      page.error = previous.error;
      if (wasSelected) this.selected.set(workspace, page.id);
    }
    if (!page && ['show', 'navigate', 'reload'].includes(request.operation)) {
      const id = randomUUID();
      key = pageKey(this.coreIdentity(request.projectId), request.projectId, request.threadId, id);
      page = this.create(key, request.projectId, request.threadId, { id });
    }
    if (page && ['show', 'navigate', 'reload'].includes(request.operation)
      && !page.view.webContents.getURL() && !page.view.webContents.isLoadingMainFrame()) {
      const restored = request.operation !== 'navigate' && restoreUrl ? webUrl(restoreUrl) : null;
      if (restored) {
        page.url = restored;
        void page.view.webContents.loadURL(restored).catch(error => {
          if (this.pageStillOwned(page) && error.code !== 'ERR_ABORTED' && error.errno !== -3) page.error = error.message;
        });
      }
    }
    if (!page) return { ...this.state(null), workspace: this.snapshot(request.projectId, request.threadId) };
    if (!page.view) {
      if (request.operation === 'selectPage') {
        this.selected.set(workspace, page.id);
        this.changed(page);
      }
      return this.state(page);
    }
    this.pages.delete(key); this.pages.set(key, page);
    const view = page.view, nativeGeneration = page.pageGeneration;
    const c = view.webContents;
    if (target) {
      if (!page.networkPolicy.canAuthorize(target)) throw new Error('浏览安全策略拒绝该地址');
      if (!page.networkPolicy.allowHumanNavigation(target)) throw new Error('浏览安全策略拒绝该地址');
    }
    if (['navigate', 'back', 'forward', 'reload', 'devtools'].includes(request.operation) && page.styleTrial) {
      const cleared = await this.clearStyleTrial(page);
      if (!cleared.cleared && request.operation !== 'reload')
        throw new Error('试改已失效，请刷新页面后继续导航');
    }
    if (['navigate', 'back', 'forward', 'reload'].includes(request.operation)) {
      if (!this.pageStillOwned(page) || page.view !== view || page.pageGeneration !== nativeGeneration
        || page.crashed || c.isDestroyed())
        throw new Error('页面已关闭');
      this.revoke(page); // Fence old Agent work before waiting on the local native channel.
      const controlEpoch = page.controlEpoch;
      if (page.control === 'transferring') await this.convergeInput(page);
      if (!this.pageStillOwned(page) || page.view !== view || page.pageGeneration !== nativeGeneration
        || page.crashed || c.isDestroyed())
        throw new Error('页面已关闭');
      if (page.control !== 'human' || page.controlEpoch !== controlEpoch)
        throw new Error('原生输入尚未收敛，请停止或关闭页面');
    } else if (request.operation === 'stop') this.revoke(page);
    if (page.control === 'transferring' && !['state', 'show', 'hide', 'stop', 'release', 'selectPage'].includes(request.operation))
      throw new Error('原生输入尚未收敛，请停止或关闭页面');
    if (request.bounds) {
      const bounds = rendererBoundsWithinWindow(request.bounds, this.window);
      const previous = page.view.getBounds();
      const guiZoom = this.window.webContents.getZoomFactor();
      if (!isDeepStrictEqual(bounds, previous) || page.guiZoom !== guiZoom) {
        page.view.setBounds(bounds);
        page.guiZoom = guiZoom;
        page.viewportKey = null;
        page.viewportRevision++;
        page.lastCapture = null;
        page.plans.clear();
        this.changed(page, 'viewportChanged');
      }
    }
    switch (request.operation) {
      case 'selectPage':
        {
          const outgoing = this.pages.get(this.owner);
          if (outgoing?.fileHandoff?.timer) clearTimeout(outgoing.fileHandoff.timer);
          if (outgoing) outgoing.fileHandoff = null;
        }
        if (page.fileHandoff?.timer) clearTimeout(page.fileHandoff.timer);
        page.fileHandoff = null;
        this.selected.set(workspace, page.id);
        this.changed(page);
        break;
      case 'show':
        // 标注 hide 会保留冻结草稿；真正切换 Page/Thread 时仍撤销其他页面的临时授权。
        for (const other of this.pages.values()) if (other !== page && other.frameGrant) {
          other.activeRead?.cancel(); this.closeNative(other);
          other.stateLoss = '嵌入授权因切换页面已撤销，页面已关闭'; this.changed(other);
        }
        if (this.owner !== key) {
          const outgoing = this.pages.get(this.owner);
          if (outgoing) {
            this.cancelHumanGesture(outgoing);
            outgoing.requestedVisible = false;
            if (outgoing.frameGrant) {
              outgoing.activeRead?.cancel(); this.closeNative(outgoing);
              outgoing.stateLoss = '嵌入授权因切换页面已撤销，页面已关闭'; this.changed(outgoing);
            }
          }
          this.view?.setVisible(false);
        }
        this.owner = key; this.view = page.view;
        page.requestedVisible = request.visible !== false;
        page.view.setVisible(page.requestedVisible && page.control !== 'transferring' && !page.activeAction);
        break;
      case 'navigate':
        page.url = target; page.error = '';
        void c.loadURL(target).catch(error => {
          if (this.pageStillOwned(page) && error.code !== 'ERR_ABORTED' && error.errno !== -3 && page.url === target) page.error = error.message;
        });
        break;
      case 'back': if (c.navigationHistory.canGoBack()) c.navigationHistory.goBack(); break;
      case 'forward': if (c.navigationHistory.canGoForward()) c.navigationHistory.goForward(); break;
      case 'reload':
        page.error = '';
        if (c.getURL()) c.reload();
        else if (page.url) void c.loadURL(page.url).catch(error => {
          if (this.pageStillOwned(page) && error.code !== 'ERR_ABORTED' && error.errno !== -3) page.error = error.message;
        });
        break;
      case 'stop': c.stop(); break;
      case 'external': await require('electron').shell.openExternal(webUrl(c.getURL() || page.url)); break;
      case 'devtools':
        this.revoke(page);
        await this.convergeInput(page);
        if (page.control !== 'human') throw new Error('原生输入尚未收敛，请停止或关闭页面');
        // Electron 在首个文档加载后才公开 devToolsWebContents；
        // 在这次可信调用期间绑定其内部创建的前端。
        {
          const { app } = require('electron');
          const created = (_event, contents) => {
            if (contents.getType() === 'remote' && contents.session === c.session)
              page.openingDevTools = contents;
          };
          app.on('web-contents-created', created);
          try { c.openDevTools({ mode: 'detach' }); }
          finally { app.removeListener('web-contents-created', created); }
        }
        break;
    }
    if (['navigate', 'reload', 'stop'].includes(request.operation)) this.changed(page);
    return this.state(page);
  }

}
module.exports = { CorePreview, webUrl, boundsWithinWindow };
