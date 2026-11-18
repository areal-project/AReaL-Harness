import { Capacitor, registerPlugin } from "@capacitor/core";

const nativeSocket = registerPlugin("ArealLocalSocket");
const MAX_FRAME = 512 * 1024;
const MAX_BUFFER = 2 * 1024 * 1024;

function isLocalAddressCandidate(hostname) {
  if (/^\[f[cd][0-9a-f]{2}:[0-9a-f:]+\]$/i.test(hostname)) return true;
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || +part > 255))
    return false;
  const [a, b] = parts.map(Number);
  return a > 0 && a < 224 && a !== 127 && !(a === 169 && b === 254);
}

export function isLocalRelayOrigin(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" && url.origin === value && isLocalAddressCandidate(url.hostname)
    );
  } catch {
    return false;
  }
}

export function isPinnedRelayOrigin(value, fingerprint) {
  try {
    const url = new URL(value);
    return (
      /^[a-f0-9]{64}$/.test(fingerprint) &&
      url.protocol === "https:" &&
      url.origin === value &&
      isLocalAddressCandidate(url.hostname)
    );
  } catch {
    return false;
  }
}

function localSocketURL(value, fingerprint) {
  const url = new URL(value);
  const pinned = fingerprint !== undefined;
  const authority = /^wss?:\/\/([^/]+)/.exec(value)?.[1];
  if (
    url.protocol !== (pinned ? "wss:" : "ws:") ||
    (pinned && !isPinnedRelayOrigin(url.origin.replace(/^wss:/, "https:"), fingerprint)) ||
    url.href !== `${url.origin}/remote/socket` ||
    (authority !== url.host && authority !== `${url.hostname}:${pinned ? 443 : 80}`) ||
    !isLocalAddressCandidate(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/remote/socket" ||
    url.search ||
    url.hash
  )
    throw new Error("INVALID_LOCAL_RELAY");
  return url.href;
}

export function createMobileSocket(url, fingerprint) {
  if (url.startsWith("wss:") && fingerprint === undefined) return new WebSocket(url);
  if (!Capacitor.isNativePlatform()) throw new Error("LOCAL_RELAY_REQUIRES_NATIVE_APP");
  return new LocalRelaySocket(url, nativeSocket, fingerprint);
}

export class LocalRelaySocket extends EventTarget {
  constructor(url, plugin, fingerprint) {
    super();
    this.url = localSocketURL(url, fingerprint);
    this.fingerprint = fingerprint;
    this.plugin = plugin;
    this.id = crypto.randomUUID();
    this.readyState = 0;
    this.opened = false;
    this.bufferedAmount = 0;
    this.binaryType = "arraybuffer";
    this.queue = Promise.resolve();
    this.onclose = null;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.start = this.open();
  }
  emit(type, data) {
    const event = type === "message" ? new MessageEvent(type, { data }) : new Event(type);
    this.dispatchEvent(event);
    this[`on${type}`]?.(event);
  }
  async open() {
    try {
      this.listener = await this.plugin.addListener("socketEvent", (event) => {
        if (event.id !== this.id || this.readyState === 3) return;
        if (event.type === "open" && this.readyState === 0) {
          this.readyState = 1;
          this.opened = true;
          this.emit("open");
        } else if (event.type === "message" && this.readyState === 1) {
          try {
            if (typeof event.data !== "string" || event.data.length > Math.ceil(MAX_FRAME / 3) * 4)
              throw new Error("LOCAL_FRAME_TOO_LARGE");
            const bytes = Uint8Array.from(atob(event.data), (character) => character.charCodeAt(0));
            if (bytes.length > MAX_FRAME) throw new Error("LOCAL_FRAME_TOO_LARGE");
            this.emit(
              "message",
              event.text ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : bytes.buffer,
            );
          } catch {
            this.fail();
          }
        } else if (event.type === "error") this.fail();
        else if (event.type === "close") this.finish();
      });
      if (this.readyState !== 0) {
        await this.listener.remove();
        return;
      }
      await this.plugin.connect({
        id: this.id,
        url: this.url,
        ...(this.fingerprint ? { fingerprint: this.fingerprint } : {}),
      });
      if (this.readyState >= 2) await this.plugin.close({ id: this.id });
    } catch {
      this.fail();
    }
  }
  send(value) {
    if (this.readyState !== 1) throw new Error("LOCAL_SOCKET_NOT_OPEN");
    const text = typeof value === "string";
    const bytes = text
      ? new TextEncoder().encode(value)
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : null;
    if (!bytes || bytes.length > MAX_FRAME || this.bufferedAmount + bytes.length > MAX_BUFFER)
      throw new Error("LOCAL_SOCKET_BUFFER_LIMIT");
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    const data = btoa(binary);
    const size = bytes.length;
    this.bufferedAmount += size;
    this.queue = this.queue
      .then(async () => {
        if (this.readyState === 1) await this.plugin.send({ id: this.id, data, text });
      })
      .catch(() => this.fail())
      .finally(() => {
        this.bufferedAmount = Math.max(0, this.bufferedAmount - size);
      });
  }
  fail() {
    if (this.readyState === 3) return;
    this.emit("error");
    this.close();
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    void this.plugin.close({ id: this.id }).catch(() => {});
    this.finish();
  }
  finish() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.bufferedAmount = 0;
    void this.listener?.remove().catch(() => {});
    this.emit("close");
  }
}
