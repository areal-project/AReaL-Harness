export const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

const LEGACY_READ_METHODS = new Set([
  'initialize', 'areal/capabilities', 'model/list', 'thread/list', 'thread/read',
  'areal/thread/observe', 'areal/thread/inspect', 'areal/conversation/list', 'areal/conversation/history',
  'areal/model/list', 'areal/profile/list', 'areal/profile/read', 'areal/queue/list',
  'areal/interaction/list', 'areal/permissions/read', 'areal/plan/read', 'areal/goal/get',
  'areal/request/read', 'areal/server/status', 'areal/task/list', 'areal/task/read',
  'areal/task/subscribe', 'areal/inbox/list', 'areal/channel/read', 'areal/side/context/read',
]);

function requestFailure(message, request, code, { cause, data, received = false } = {}) {
  const readOnly = request.effect === 'read' || request.effect === 'subscription';
  const operation = { method: request.method, ...(request.requestId ? { requestId: request.requestId } : {}), target: request.target ?? { kind: 'project' } };
  const known = ['noMutation', 'rejected', 'admitted', 'unconfirmed'].includes(data?.outcome?.kind);
  const outcome = known ? data.outcome : readOnly ? { kind: 'noMutation' } : { kind: 'unconfirmed', operation };
  const retryRead = readOnly && data?.retryable !== false && (!received || data?.retryable === true);
  const recovery = known && data?.recovery ? data.recovery : { kind: readOnly ? retryRead ? 'retryRead' : 'none' : request.requestId ? 'queryOriginal' : 'needsUser' };
  return new CoreRpcError(message, { code: received || readOnly ? code : 'RESPONSE_UNKNOWN',
    method: request.method, cause,
    data: { ...data, outcome, recovery, ...(request.requestId ? { requestId: request.requestId } : {}) } });
}

function responseTooLarge() {
  return new CoreRpcError('Core response exceeds the supported history size', {
    code: 'RESPONSE_TOO_LARGE', data: { reason: 'RESPONSE_TOO_LARGE', limitBytes: MAX_RESPONSE_BYTES, retryable: false, delivery: 'resultUnavailable' },
  });
}

/** AReaL Core app-server 客户端。认证与 socket 创建由可信平台宿主提供。 */
export class CoreRpcError extends Error {
  constructor(message, { code, method, data, cause, submissionUnknown = false } = {}) {
    super(message, { cause });
    this.name = 'CoreRpcError';
    this.code = code;
    this.method = method;
    this.data = data;
    this.reason = data?.reason;
    this.outcome = data?.outcome;
    this.recovery = data?.recovery;
    this.requestId = data?.outcome?.operation?.requestId ?? data?.requestId;
    this.delivery = data?.delivery;
    this.submissionUnknown = this.outcome ? ['admitted', 'unconfirmed'].includes(this.outcome.kind) : submissionUnknown;
  }
}

export class CoreClient {
  constructor({ createSocket, timeoutMs = 30_000, onServerRequest }) {
    this.createSocket = createSocket;
    this.onServerRequest = onServerRequest;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.nextId = 0;
    this.socket = null;
    this.ready = false;
    this.closed = false;
    this.closeFailure = null;
  }

  onNotification(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  async connect() {
    if (this.socket) throw new Error('Core client already connected; create a new client to reconnect');
    const socket = this.socket = this.createSocket();
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CoreRpcError('Core connection timed out'));
        socket.close();
      }, this.timeoutMs);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CoreRpcError('Core connection failed'));
      }, { once: true });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        reject(new CoreRpcError('Core connection closed before initialization'));
      }, { once: true });
    });
    socket.addEventListener('message', event => this.receive(event.data));
    socket.addEventListener('close', event => {
      if (event.code === 1009 && event.reason === 'RESPONSE_TOO_LARGE') this.closeFailure = responseTooLarge();
      this.disconnected();
    });
    socket.addEventListener('error', event => {
      if ((event.error?.code ?? event.code) === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') this.closeFailure = responseTooLarge();
    });
    try {
      await opened;
      await this.request('initialize', { clientInfo: { name: 'areal-harness-desktop', version: '0.1.0' } });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      this.capabilities = await this.request('areal/capabilities', { apiVersion: 'areal.core.v1' });
      if (this.closed) throw new CoreRpcError('Core disconnected during initialization', { code: 'DISCONNECTED' });
      this.ready = true;
      return this.capabilities;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  request(method, params = {}, { onResult, timeoutMs = this.timeoutMs, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES)
      return Promise.reject(new RangeError('Invalid Core response byte budget'));
    const semantics = this.capabilities?.methodSemantics;
    const bootstrap = method === 'initialize' || method === 'areal/capabilities';
    const effect = bootstrap ? 'read' : semantics
      ? this.capabilities.methods?.includes(method) ? semantics[method]?.effect : undefined
      : LEGACY_READ_METHODS.has(method) ? 'read' : undefined;
    const request = { method, effect, requestId: params.requestId,
      target: params.taskId ? { kind: 'task', taskId: params.taskId }
        : params.threadId ? { kind: 'thread', threadId: params.threadId } : { kind: 'project' } };
    if (this.closed || !this.socket || this.socket.readyState !== 1) {
      const readOnly = effect === 'read' || effect === 'subscription';
      return Promise.reject(new CoreRpcError('Core is disconnected', { code: 'DISCONNECTED', method,
        data: { outcome: { kind: readOnly ? 'noMutation' : 'rejected' }, recovery: { kind: readOnly ? 'retryRead' : 'none' } } }));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(requestFailure('Core response timed out', request, 'TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, ...request, onResult, maxResponseBytes });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(requestFailure('Core request could not be delivered', request, 'DISCONNECTED', { cause }));
      }
    });
  }

  receive(bytes) {
    // close 后仍可能收到 socket 缓冲中的包，不能让旧连接再次更新投影。
    if (this.closed) return;
    const text = String(bytes);
    const responseBytes = bytes?.byteLength ?? new TextEncoder().encode(text).byteLength;
    if (responseBytes > MAX_RESPONSE_BYTES) {
      this.closeFailure = responseTooLarge();
      this.close();
      return;
    }
    let message;
    try { message = JSON.parse(text); }
    catch { this.close(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
    if (message.method && message.id !== undefined) {
      if (!['item/tool/call', 'areal/browser/prepare', 'areal/computer/prepare', 'areal/task/prepare', 'areal/cua/turnEnded'].includes(message.method) || !this.onServerRequest) {
        this.socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Client tool host is not available' } }));
        return;
      }
      const socket = this.socket;
      const controller = new AbortController();
      this.serverRequests.set(String(message.id), controller);
      void Promise.resolve().then(() => this.onServerRequest(message.method, message.params,
        { requestId: String(message.id), signal: controller.signal })).then(result => {
        this.serverRequests.delete(String(message.id));
        if (!this.closed && this.socket === socket && socket.readyState === 1)
          socket.send(JSON.stringify({ id: message.id, result }));
      }, () => {
        this.serverRequests.delete(String(message.id));
        if (!this.closed && this.socket === socket && socket.readyState === 1)
          socket.send(JSON.stringify({ id: message.id, error: { code: -32603, message: 'Client tool host failed' } }));
      });
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (responseBytes > entry.maxResponseBytes) {
        entry.reject(requestFailure('Core response exceeds the requested byte budget', entry, 'RESPONSE_TOO_LARGE', {
          data: { reason: 'RESPONSE_TOO_LARGE', limitBytes: entry.maxResponseBytes, retryable: false, delivery: 'resultUnavailable' }, received: true,
        }));
        return;
      }
      if (message.error) {
        const oversized = message.error.data?.reason === 'RESPONSE_TOO_LARGE';
        entry.reject(requestFailure(message.error.message, entry, oversized ? 'RESPONSE_TOO_LARGE' : message.error.code,
          { data: message.error.data, received: !oversized }));
      } else {
        try {
          // 同一 socket 批次可能紧跟增量；快照必须在消息分派栈内先建立。
          entry.onResult?.(message.result);
          entry.resolve(message.result);
        } catch (error) { entry.reject(error); }
      }
      return;
    }
    if (typeof message.method === 'string') {
      if (message.method === 'areal/tool/cancelled') this.serverRequests.get(String(message.params?.requestId))?.abort();
      for (const listener of this.listeners) listener(message.method, message.params);
    }
  }

  disconnected() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(requestFailure(this.closeFailure?.message ?? 'Core disconnected', entry,
        this.closeFailure?.code ?? 'DISCONNECTED', { data: this.closeFailure?.data }));
    }
    this.pending.clear();
    for (const controller of this.serverRequests.values()) controller.abort();
    this.serverRequests.clear();
    for (const listener of this.closeListeners) listener(this.closeFailure ?? new CoreRpcError('Core disconnected', { code: 'DISCONNECTED' }));
  }

  close() {
    this.ready = false;
    this.socket?.close();
    this.disconnected();
  }
}
