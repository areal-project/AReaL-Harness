import { secureChannel } from "@areal/remote";
import { createRemoteWire } from "@areal/remote/wire";

export class RemoteConnection {
  constructor({ socket, identity, host, room = null, hello, isCurrent, onClose }) {
    this.socket = socket;
    this.identity = identity;
    this.host = host;
    this.room = room;
    this.hello = hello;
    this.isCurrent = isCurrent;
    this.onClose = onClose;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    socket.onclose = () => {
      clearTimeout(this.deadline);
      this.closed = true;
      this.wire?.close();
      this.rejectPending();
      this.onClose();
    };
  }
  check() {
    if (this.closed || !this.isCurrent()) throw new Error("此连接尝试已失效");
  }
  rejectPending() {
    for (const value of this.pending.values()) {
      clearTimeout(value.timer);
      value.reject(new Error("Host 已断开，原提交需核对"));
    }
    this.pending.clear();
  }
  async connect({ onHandshake, onReady, onSession }) {
    try {
      const transport = createRemoteWire(this.socket, { room: this.room });
      this.wire = transport.wire;
      this.deadline = setTimeout(() => this.socket.close(), 15000);
      await transport.ready;
      this.check();
      this.secure = await secureChannel(this.wire, this.identity, this.host, {
        maxMessageBytes: 256 * 1024,
        maxBufferedBytes: 2 * 1024 * 1024,
      });
      this.check();
      /** @type {import('../generated/host-protocol').RemoteHello} */
      const hello = {
        method: "hello",
        apiVersion: "areal.remote.v2",
        clientVersion: "0.1.0",
        ...this.hello,
      };
      this.secure.send(hello);
      this.hello = null;
      onHandshake("hello");
      const messages = this.secure.messages();
      let first = await messages.next();
      this.check();
      if (first.value?.event === "pairing") {
        // 人工确认由 Host 的邀请期限约束，不沿用传输握手期限。
        clearTimeout(this.deadline);
        onHandshake("pairing");
        first = await messages.next();
        this.check();
      }
      if (first.done || first.value?.error)
        throw Object.assign(
          new Error(first.value?.error?.message ?? "连接失败"),
          first.value?.error,
        );
      if (first.value?.event !== "ready" || first.value.hostId !== this.host)
        throw Object.assign(new Error("Host 身份不匹配"), { code: "HOST_MISMATCH" });
      await onReady(first.value);
      this.check();
      /** @type {import('../generated/host-protocol').RemoteReady} */
      this.ready = first.value;
      void this.receive(messages, onSession).catch(() => this.socket.close());
      return this.ready;
    } finally {
      clearTimeout(this.deadline);
    }
  }
  request(envelope, onResult) {
    return new Promise((resolve, reject) => {
      if (this.closed || !this.ready || !this.isCurrent())
        return reject(
          Object.assign(new Error("连接已失效，请重新读取状态"), { code: "RESYNC_REQUIRED" }),
        );
      const id = String(++this.sequence);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (envelope.method === "session.open") this.socket.close();
        reject(new Error("读取超时，请刷新或核对原命令"));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer, onResult });
      try {
        /** @type {import('../generated/host-protocol').RemoteRequest} */
        const request = { id, ...envelope };
        this.secure.send(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async receive(messages, onSession) {
    try {
      for await (const message of messages) {
        if (this.closed || !this.isCurrent()) continue;
        if (message.event?.startsWith("session.")) {
          onSession(message);
          continue;
        }
        const handler = this.pending.get(message.id);
        if (!handler) continue;
        this.pending.delete(message.id);
        clearTimeout(handler.timer);
        if (message.error) {
          handler.reject(Object.assign(new Error(message.error.message), message.error));
          if (message.error.code === "GRANT_CHANGED") this.socket.close();
        } else {
          try {
            handler.onResult?.(message.result);
            handler.resolve(message.result);
          } catch (error) {
            handler.reject(error);
          }
        }
      }
    } finally {
      this.rejectPending();
    }
  }
}
