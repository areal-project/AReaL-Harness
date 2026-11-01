// @ts-check
"use strict";
const WebSocket = require("ws");
const { EventEmitter } = require("node:events");
const { LIMITS } = require("./remote-session-acceptor.cjs");
const { desktopTlsOptions } = require("./desktop-network.cjs");

// 每条通道只有字节、存活、背压和关闭；Noise/授权/业务分派全部归共同 acceptor。
class RelayEndpoint extends EventEmitter {
  /** @param {RelayTransport} owner @param {string} channel */
  constructor(owner, channel) {
    super();
    this.owner = owner;
    this.channel = channel;
    this.readyState = 1;
    this.bufferedAmount = 0;
    /** @type {{bytes:Buffer,offset:number,size:number}[]} */
    this.queue = [];
    /** @type {NodeJS.Timeout|undefined} */ this.closeTimer = undefined;
  }
  /** @param {Uint8Array} bytes */
  send(bytes) {
    if (this.readyState !== 1) throw new Error("通道已断开");
    const size =
      Math.ceil(bytes.length / 3) * 4 + Math.ceil(bytes.length / this.owner.chunkBytes) * 128;
    if (
      this.bufferedAmount + size > LIMITS.sendTransportBufferedBytes ||
      this.owner.remote.sessions.sendBufferedBytes() + size > LIMITS.hostSendBufferedBytes
    ) {
      this.terminate();
      throw new Error("通道发送缓冲已满");
    }
    this.bufferedAmount += size;
    // 与 Direct WebSocket.send 一样同步接受到有界字节队列，不能把 Noise 分片停在正常关闭边界之外。
    this.queue.push({ bytes: Buffer.from(bytes), offset: 0, size });
    this.owner.drain();
  }
  close(notify = true) {
    if (!notify) return this.terminate(false);
    if (this.readyState !== 1) return;
    if (!this.queue.length) return this.terminate();
    // 与 WebSocket 的正常关闭一致，只排出已经接受的有界字节；撤销/代际切换用 terminate 立即丢弃。
    this.readyState = 2;
    this.closeTimer = setTimeout(() => this.terminate(), LIMITS.helloDeadlineMs);
    this.closeTimer.unref?.();
    this.owner.drain();
  }
  terminate(notify = true) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.closeTimer);
    this.owner.channels.delete(this.channel);
    this.queue.length = 0;
    this.bufferedAmount = 0;
    this.emit("close");
    if (notify) this.owner.control({ type: "close", channel: this.channel });
  }
}
class RelayTransport {
  /** @param {InstanceType<typeof import("./remote.cjs").RemoteControl>} remote */
  constructor(remote) {
    this.remote = remote;
    // 每一代出站 socket 独占通道表；迟到的旧 close 不能清退新一代设备。
    /** @type {Map<string,RelayEndpoint>} */
    this.channels = new Map();
    this.closed = false;
    this.ready = false;
    this.pushSupported = false;
    this.replaced = false;
    this.unsupportedBudget = false;
    this.draining = false;
    this.lastWasControl = false;
    this.chunkBytes = 0;
    this.frameInterval = 0;
    this.bytesPerSecond = 0;
    this.nextSendAt = 0;
    /** @type {string|undefined} */ this.previous = undefined;
    /** @type {NodeJS.Timeout|null} */ this.paceTimer = null;
    /** @type {Map<string,string>} */
    this.controls = new Map();
    this.controlBytes = 0;
    /** @type {Map<string,()=>boolean>} */ this.pushGuards = new Map();
    remote.channels = this.channels;
    const relay = remote.config.relay;
    if (typeof relay !== "string") throw new Error("Relay 未配置");
    const local = remote.isLocalRelay();
    const origin = new URL(relay);
    const socketOrigin = local ? `ws://127.0.0.1:${origin.port}` : relay.replace(/^https:/, "wss:");
    this.socket = new WebSocket(socketOrigin + "/remote/socket", {
      ...(local ? {} : desktopTlsOptions()),
      headers: { "X-Areal-Relay-Capabilities": "push", ...(local ? { Host: origin.host } : {}) },
      maxPayload: LIMITS.transportFrameBytes,
      perMessageDeflate: false,
    });
    const socket = this.socket;
    this.deadline = setTimeout(() => socket.terminate(), LIMITS.helloDeadlineMs);
    this.deadline.unref?.();
    socket.on("error", () => {});
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          protocol: "areal.relay.v1",
          role: "host",
          room: remote.config.room,
          capability: remote.config.capability,
        }),
      ),
    );
    socket.on("message", (raw, binary) => {
      if (this.closed) return;
      try {
        const message = remote.crypto.decodeRelayMessage(raw.toString(), binary);
        if (message.type === "error") {
          if (this.ready && ["LIMIT_EXCEEDED", "UNAVAILABLE"].includes(message.code))
            remote.push.diagnostic = "push-dropped";
          if (message.code === "REPLACED") this.replaced = true;
          if (!this.ready || this.replaced) socket.terminate();
          return;
        }
        if (!this.ready) {
          if (message.type !== "ready" || message.channel !== undefined) throw new Error();
          this.configureBudget(message.limits);
          this.ready = true;
          this.pushSupported = message.push === true;
          remote.push.start();
          clearTimeout(this.deadline);
          remote.connected = true;
          remote.relayError = "";
          remote.service.schedule();
          return;
        }
        if (message.type === "pushResult") {
          remote.push.unregisterToken(message.token);
          return;
        }
        if (message.type === "open") {
          if (this.channels.has(message.channel)) throw new Error();
          if (!remote.sessions.available()) {
            this.control({ type: "close", channel: message.channel });
            return;
          }
          const endpoint = new RelayEndpoint(this, message.channel);
          this.channels.set(message.channel, endpoint);
          remote.sessions.accept(endpoint);
        } else if (message.type === "data") {
          const endpoint = this.channels.get(message.channel);
          // 已关闭通道的在途帧不得使同一 Host 的其他设备断开。
          if (endpoint?.readyState === 1) {
            try {
              endpoint.emit("message", remote.crypto.decodeRelayData(message.data), true);
            } catch {
              endpoint.terminate();
            }
          }
        } else if (message.type === "close") {
          this.removeControl(message.channel);
          this.channels.get(message.channel)?.close(false);
        } else throw new Error();
      } catch {
        if (!this.ready) this.unsupportedBudget = true;
        socket.terminate();
      }
    });
    socket.on("close", () => {
      clearTimeout(this.deadline);
      this.closed = true;
      this.pushSupported = false;
      this.clearPacing();
      for (const endpoint of Array.from(this.channels.values())) endpoint.close(false);
      if (remote.relayTransport !== this) return;
      remote.connected = false;
      remote.relayError = this.unsupportedBudget
        ? "Relay 协议或传输限额不可用，请升级服务或调整配置后重新启用"
        : this.replaced
          ? "Relay Host 已被替换；请确认后重新启用"
          : "Relay 不可用，正在重连";
      remote.service.schedule();
      if (!remote.closed && remote.config.enabled && !this.replaced && !this.unsupportedBudget)
        remote.retry = setTimeout(() => remote.connect(), 3000);
      remote.retry?.unref?.();
    });
  }
  /** @param {import("../../../packages/remote/src/relay-codec.mjs").RelayLimits|undefined} limits */
  configureBudget(limits) {
    if (!limits) throw new Error("Relay 未声明传输限额");
    // Relay 把自动 pong 也计入同一帧桶；额外保留一个边界帧，不能把服务上限当可用数据额度。
    const reservedFrames = Math.ceil(1000 / limits.heartbeatIntervalMs) + 1;
    const dataFrames = limits.framesPerSecond - reservedFrames - 1;
    const envelopeBytes = Math.min(limits.maxFrameBytes, Math.floor(limits.bytesPerSecond / 4));
    this.maxFrameBytes = envelopeBytes;
    this.chunkBytes = Math.min(49152, Math.floor((envelopeBytes - 128) / 4) * 3);
    if (dataFrames <= 0 || this.chunkBytes < 1) throw new Error("Relay 限额不足");
    this.frameInterval = 1000 / dataFrames;
    this.bytesPerSecond = limits.bytesPerSecond * 0.75;
    // 登记帧已计入服务桶；先跨过它的窗口，再开始有界连续发送。
    this.nextSendAt = performance.now() + 1050;
  }
  get bufferedAmount() {
    return this.socket.bufferedAmount + this.controlBytes;
  }
  /** @param {string} channel */
  removeControl(channel) {
    const text = this.controls.get(channel);
    if (text) this.controlBytes -= Buffer.byteLength(text);
    this.controls.delete(channel);
    this.pushGuards.delete(channel);
  }
  /** @param {import('./remote-push.cjs').PushMessage} value @param {()=>boolean} authorized */
  tryPush(value, authorized) {
    const text = JSON.stringify(value);
    if (
      this.closed ||
      !this.ready ||
      !this.pushSupported ||
      this.socket.readyState !== 1 ||
      !authorized() ||
      Object.values(value.target).some((field) => !field || Buffer.byteLength(field) > 256) ||
      Buffer.byteLength(text) > (this.maxFrameBytes ?? 0) ||
      this.pushGuards.size >= LIMITS.activeHostConnections ||
      this.controls.size >= LIMITS.activeHostConnections * 2 ||
      this.remote.sessions.sendBufferedBytes() + Buffer.byteLength(text) >
        LIMITS.hostSendBufferedBytes
    )
      return false;
    const key = `push:${value.token}:${value.collapseId}`;
    this.removeControl(key);
    this.controls.set(key, text);
    this.pushGuards.set(key, authorized);
    this.controlBytes += Buffer.byteLength(text);
    this.drain();
    return true;
  }
  /** @param {{type:"close",channel:string}} value */
  control(value) {
    if (this.closed || !this.ready || this.socket.readyState !== 1) return;
    if (this.controls.has(value.channel)) return;
    const text = JSON.stringify(value);
    // 每个未送出的 close 都仍占 Relay 的通道位；同通道去重并在服务 close 后删除。
    if (this.controls.size >= LIMITS.activeHostConnections * 2) {
      const push = this.pushGuards.keys().next().value;
      if (push) this.removeControl(push);
      else {
        this.socket.terminate();
        return;
      }
    }
    this.controls.set(value.channel, text);
    this.controlBytes += Buffer.byteLength(text);
    this.drain();
  }
  drain() {
    if (
      this.draining ||
      this.paceTimer ||
      this.closed ||
      !this.ready ||
      this.socket.readyState !== 1
    )
      return;
    const endpoints = Array.from(this.channels.values()).filter(
      (endpoint) => endpoint.queue.length,
    );
    if (!endpoints.length && !this.controls.size) return;
    const delay = this.nextSendAt - performance.now();
    if (delay > 0) {
      this.paceTimer = setTimeout(() => {
        this.paceTimer = null;
        this.drain();
      }, Math.ceil(delay));
      this.paceTimer.unref?.();
      return;
    }
    const isControl = this.controls.size && (!endpoints.length || !this.lastWasControl);
    /** @type {{kind:'control',channel:string,text:string}|{kind:'data',endpoint:RelayEndpoint,job:RelayEndpoint['queue'][number],bytes:Buffer,text:string}} */
    let sending;
    if (isControl) {
      const [channel, text] = /** @type {[string,string]} */ (this.controls.entries().next().value);
      const guard = this.pushGuards.get(channel);
      if (guard && !guard()) {
        this.removeControl(channel);
        this.drain();
        return;
      }
      sending = { kind: "control", channel, text };
    } else {
      const previousIndex = endpoints.findIndex((endpoint) => endpoint.channel === this.previous);
      const endpoint = endpoints[(previousIndex + 1) % endpoints.length];
      this.previous = endpoint.channel;
      const job = endpoint.queue[0];
      const bytes = job.bytes.subarray(job.offset, job.offset + this.chunkBytes);
      sending = {
        kind: "data",
        endpoint,
        job,
        bytes,
        text: this.remote.crypto.encodeRelayData(endpoint.channel, bytes),
      };
    }
    this.lastWasControl = Boolean(isControl);
    this.draining = true;
    this.socket.send(sending.text, (error) => {
      this.draining = false;
      if (this.closed) return;
      if (error) {
        if (sending.kind === "control" && sending.channel.startsWith("push:")) {
          this.removeControl(sending.channel);
          this.remote.push.diagnostic = "push-dropped";
          this.drain();
        } else this.socket.terminate();
        return;
      }
      // 按实际 JSON/base64 字节而非明文字节计费；数据和 close 共用此时钟。
      this.nextSendAt =
        performance.now() +
        Math.max(
          this.frameInterval,
          (1000 * Buffer.byteLength(sending.text)) / this.bytesPerSecond,
        );
      if (sending.kind === "control") {
        if (this.controls.get(sending.channel) === sending.text)
          this.removeControl(sending.channel);
      } else if (sending.endpoint.readyState !== 3) {
        const { endpoint, job, bytes } = sending;
        job.offset += bytes.length;
        if (job.offset >= job.bytes.length) {
          endpoint.queue.shift();
          endpoint.bufferedAmount -= job.size;
          if (endpoint.readyState === 2 && !endpoint.queue.length) endpoint.terminate();
        }
      }
      this.drain();
    });
  }
  clearPacing() {
    clearTimeout(this.paceTimer ?? undefined);
    this.paceTimer = null;
    this.controls.clear();
    this.pushGuards.clear();
    this.controlBytes = 0;
  }
  close() {
    this.closed = true;
    this.pushSupported = false;
    clearTimeout(this.deadline);
    this.clearPacing();
    for (const endpoint of Array.from(this.channels.values())) endpoint.close(false);
    this.socket.terminate();
  }
}
module.exports = { RelayTransport };
