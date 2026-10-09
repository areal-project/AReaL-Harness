/** AReaL Core app-server 客户端。认证与 socket 创建由可信平台宿主提供。 */
export class CoreRpcError extends Error {
  constructor(message, { code, method, cause, submissionUnknown = false } = {}) {
    super(message, { cause });
    this.name = 'CoreRpcError';
    this.code = code;
    this.method = method;
    this.submissionUnknown = submissionUnknown;
  }
}

export class CoreClient {
  constructor({ createSocket, timeoutMs = 30_000 }) {
    this.createSocket = createSocket;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.listeners = new Set();
    this.closeListeners = new Set();
    this.nextId = 0;
    this.socket = null;
    this.ready = false;
    this.closed = false;
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
    socket.addEventListener('close', () => this.disconnected());
    // ws 的 error 事件必须始终有接收者；详细认证/传输信息不发送给 Renderer。
    socket.addEventListener('error', () => {});
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

  request(method, params = {}, { onResult, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed || !this.socket || this.socket.readyState !== 1) {
      return Promise.reject(new CoreRpcError('Core is disconnected', { code: 'DISCONNECTED', method }));
    }
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CoreRpcError('Core response timed out; query the accepted request before retrying', {
          code: 'RESPONSE_UNKNOWN', method, submissionUnknown: true,
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method, onResult });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (cause) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CoreRpcError('Core request could not be delivered', {
          code: 'RESPONSE_UNKNOWN', method, cause, submissionUnknown: true,
        }));
      }
    });
  }

  receive(bytes) {
    // close 后仍可能收到 socket 缓冲中的包，不能让旧连接再次更新投影。
    if (this.closed) return;
    let message;
    try { message = JSON.parse(String(bytes)); }
    catch { this.close(); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.close(); return; }
    if (message.method && message.id !== undefined) {
      // 首版只观察 Core 工具，未注册 Renderer 动态工具执行宿主。
      this.socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Client tool host is not available' } }));
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new CoreRpcError(message.error.message, { code: message.error.code, method: entry.method }));
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
      for (const listener of this.listeners) listener(message.method, message.params);
    }
  }

  disconnected() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new CoreRpcError('Core disconnected; request outcome may be unknown', {
        code: 'RESPONSE_UNKNOWN', method: entry.method, submissionUnknown: true,
      }));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener();
  }

  close() {
    this.ready = false;
    this.socket?.close();
    this.disconnected();
  }
}
