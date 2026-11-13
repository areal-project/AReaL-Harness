// 此函数由 Playwright 注入页面，必须保持独立于模块作用域。
export function installHostTransportBarrier() {
  globalThis.createHostTransportBarrier = (select) => {
    const original = WebSocket.prototype.send;
    const sockets = new Map();
    const held = new Set();
    let restored = false;
    const parse = (data) => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    };
    const release = (gate) => {
      if (!held.delete(gate)) return;
      gate();
    };
    const wrap = (socket) => {
      if (sockets.has(socket)) return sockets.get(socket);
      const state = { onmessage: socket.onmessage, pending: new Map() };
      sockets.set(socket, state);
      state.handler = function (event) {
        const reply = parse(event.data);
        const entry = reply && state.pending.get(reply.id);
        if (!entry) return state.onmessage?.call(socket, event);
        state.pending.delete(reply.id);
        entry.onResponse?.(reply);
        const deliver = () => state.onmessage?.call(socket, event);
        if (entry.response === "hold") {
          entry.responseHit = reply.id;
          const gate = () => deliver();
          held.add(gate);
          entry.releaseResponse = () => release(gate);
          return;
        }
        if (entry.response === "replace" && !reply.error) {
          entry.responseHit = reply.id;
          return state.onmessage?.call(
            socket,
            new MessageEvent("message", {
              data: JSON.stringify({ version: 1, id: reply.id, error: entry.error }),
            }),
          );
        }
        return deliver();
      };
      socket.onmessage = state.handler;
      return state;
    };
    WebSocket.prototype.send = function (data) {
      const frame = parse(data);
      const entry = frame && select(frame);
      if (!entry) return original.call(this, data);
      if (frame.id == null) throw new Error("Fault injection requires a request id");
      entry.requestId = frame.id;
      const state = wrap(this);
      if (entry.reject) {
        entry.rejectHit = frame.id;
        const socket = this;
        queueMicrotask(() =>
          state.onmessage?.call(
            socket,
            new MessageEvent("message", {
              data: JSON.stringify({ version: 1, id: frame.id, error: entry.reject }),
            }),
          ),
        );
        return;
      }
      const outgoing = entry.data ?? data;
      if (entry.data != null && parse(outgoing)?.id !== frame.id)
        throw new Error("Transformed request must retain its id");
      state.pending.set(frame.id, entry);
      if (entry.holdRequest) {
        entry.requestHit = frame.id;
        const socket = this;
        const gate = () => original.call(socket, outgoing);
        held.add(gate);
        entry.releaseRequest = () => release(gate);
        return;
      }
      return original.call(this, outgoing);
    };
    return {
      restore() {
        if (restored) return;
        restored = true;
        WebSocket.prototype.send = original;
        for (const [socket, state] of sockets) {
          if (socket.onmessage === state.handler) socket.onmessage = state.onmessage;
        }
        const errors = [];
        for (const gate of held) {
          try {
            release(gate);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) throw new AggregateError(errors, "Failed to release transport gates");
      },
    };
  };
}
