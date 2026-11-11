import { SessionBodyReader, CommandState, acceptSessionMessage } from "@areal/remote-client";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { IDBFactory } from "fake-indexeddb";
import { BrowserState } from "../renderer/remote-web/browser-state.mjs";
import { browserDeviceName } from "../renderer/remote-web/device-name.mjs";

const connectionSource = await readFile(
  new URL("../packages/remote-client/src/connection.mjs", import.meta.url),
  "utf8",
);
const source = await readFile(new URL("../renderer/remote-web/main.js", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check) {
  for (let n = 0; n < 80; n++) {
    if (check()) return;
    await tick();
  }
  assert.ok(check(), "production page did not reach expected state");
}
function sessionStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}
function events() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      const callbacks = listeners.get(name) ?? [];
      callbacks.push(callback);
      listeners.set(name, callbacks);
    },
    dispatchEvent(event) {
      for (const callback of listeners.get(event.type) ?? []) callback(event);
    },
  };
}
class Element {
  children = [];
  dataset = {};
  style = {};
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  #text = "";
  constructor(tag) {
    this.tag = tag;
    this.attributes = new Map();
    Object.assign(this, events());
  }
  set textContent(value) {
    this.#text = value;
    this.children = [];
  }
  get textContent() {
    return this.#text;
  }
  append(...values) {
    this.children.push(...values);
  }
  replaceChildren(...values) {
    this.children = values;
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  querySelectorAll(tag) {
    return this.children.flatMap((child) => [
      ...(child.tag === tag ? [child] : []),
      ...child.querySelectorAll(tag),
    ]);
  }
  click() {
    if (!this.disabled) this.dispatchEvent({ type: "click" });
  }
}
function inbox() {
  const incoming = [],
    waiting = [];
  let done = false;
  return {
    push(value) {
      if (done) return;
      if (waiting.length) {
        waiting.shift()({ value, done: false });
        return;
      }
      incoming.push(value);
    },
    close() {
      done = true;
      for (const resolve of waiting.splice(0)) resolve({ done: true });
    },
    next() {
      return incoming.length
        ? Promise.resolve({ value: incoming.shift(), done: false })
        : done
          ? Promise.resolve({ done: true })
          : new Promise((resolve) => waiting.push(resolve));
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
function page({
  db = new IDBFactory(),
  drafts = sessionStorage(),
  hash = "#host=host",
  makeIdentity = async () => "identity",
  beforeSecure,
  ready = {},
  onCall,
} = {}) {
  const elements = new Map(),
    calls = [],
    sockets = [],
    wireOptions = [],
    timers = new Set(),
    scheduled = new Map(),
    intervals = new Set();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element("work-filter").value = "all";
  const window = events();
  const document = {
    ...events(),
    hidden: false,
    body: new Element("body"),
    getElementById: element,
    createElement: (tag) => new Element(tag),
  };
  const location = {
    hash,
    pathname: "/remote.html",
    origin: "http://localhost",
    protocol: "http:",
    host: "localhost",
    href: "http://localhost/remote.html" + hash,
  };
  const navigator = { onLine: true };
  const reply = (call, result) => call.messages.push({ id: call.id, result });
  let nextConnection = 0;
  function transport(socket) {
    const messages = inbox();
    socket.messages = messages;
    const connectionId = `connection-${++nextConnection}`;
    return {
      messages: () => messages,
      send(value) {
        const call = { ...value, messages, connectionId };
        calls.push(call);
        if (onCall?.(call, reply)) return;
        if (call.method === "hello")
          messages.push({
            event: "ready",
            hostId: "host",
            connectionId,
            gatewayGeneration: "gateway",
            grantRevision: 1,
            capabilities: ["observe", "submit", "interrupt", "answer"],
            limits: { applicationMessageBytes: 8388608 },
            ...ready,
          });
        if (call.method === "project.list")
          reply(call, {
            projects: [{ projectId: "project", name: "Project", connectionState: "online" }],
          });
        if (call.method === "work.list")
          reply(call, {
            data: [
              {
                kind: "thread",
                threadId: "thread",
                title: "Session",
                execution: { state: "idle" },
                attentionCount: 0,
                attentionComplete: true,
                attentionRefs: [],
                queue: { pendingCount: 0 },
              },
            ],
            complete: true,
            serviceGeneration: "service",
          });
        if (call.method === "subscription.close") reply(call, {});
        if (call.method === "session.open")
          reply(call, {
            projectId: "project",
            connectionId,
            gatewayGeneration: "gateway",
            serviceGeneration: "service",
            subscriptionId: `sub-${calls.length}`,
            sequence: 0,
            snapshot: {
              threadId: call.params.threadId,
              title: "Session",
              status: "idle",
              configRevision: 7,
              ownership: { kind: "ordinary" },
              turns: [],
              attentionRefs: [],
              queue: { pendingCount: 0, paused: false },
              history: { hasMore: false },
            },
          });
      },
    };
  }
  class Socket {
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        if (!this.closed) this.onopen?.();
      });
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.messages?.close();
      this.onclose?.();
    }
  }
  let guiAPI, guiView;
  const context = createContext({
    document,
    window,
    location,
    navigator,
    history: {
      replaceState() {
        location.hash = "";
      },
    },
    Event,
    TextEncoder,
    URL,
    URLSearchParams,
    crypto,
    structuredClone,
    CommandState,
    SessionBodyReader,
    createRemoteWorkbench: (api) => {
      guiAPI = api;
      return {
        render(view) {
          guiView = view;
        },
      };
    },
    acceptSessionMessage,
    browserDeviceName,
    BrowserState: class extends BrowserState {
      constructor(options) {
        super({ ...options, indexedDB: db, sessionStorage: drafts, channel: null });
      }
    },
    createIdentity: makeIdentity,
    identityId: (key) => `peer-${key}`,
    WebSocket: Socket,
    createRemoteWire: (socket, options) => {
      wireOptions.push(options);
      return {
        wire: { close() {}, receive() {} },
        ready: new Promise((resolve, reject) => {
          socket.onopen = resolve;
          socket.onerror = () => reject(new Error("Host 暂不可用，请检查连接"));
        }),
      };
    },
    remoteLocator: (fragment) => ({ host: fragment.get("host"), room: fragment.get("room") }),
    publicLocator: (locator) =>
      new URLSearchParams(Object.entries(locator).filter(([, value]) => value)).toString(),
    secureChannel: async () => {
      const socket = sockets.at(-1);
      await beforeSecure?.();
      return transport(socket);
    },
    setTimeout(callback, delay) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        scheduled.delete(timer);
        callback();
      }, delay);
      timer.unref();
      timers.add(timer);
      scheduled.set(timer, { callback, delay });
      return timer;
    },
    clearTimeout(timer) {
      clearTimeout(timer);
      timers.delete(timer);
      scheduled.delete(timer);
    },
    setInterval(callback, delay) {
      const timer = setInterval(callback, delay);
      timer.unref();
      intervals.add(timer);
      return timer;
    },
    clearInterval(timer) {
      clearInterval(timer);
      intervals.delete(timer);
    },
  });
  runInContext(
    connectionSource
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace("export class RemoteConnection", "class RemoteConnection"),
    context,
  );
  runInContext(source.replace(/^import[\s\S]*?;\n/gm, ""), context);
  return {
    db,
    drafts,
    get guiAPI() {
      return guiAPI;
    },
    get guiView() {
      return guiView;
    },
    element,
    calls,
    sockets,
    wireOptions,
    window,
    document,
    navigator,
    reply,
    advanceTimers(elapsed) {
      const due = [...scheduled].filter(([, value]) => value.delay <= elapsed);
      for (const [timer, value] of due) {
        clearTimeout(timer);
        timers.delete(timer);
        scheduled.delete(timer);
        value.callback();
      }
      return due.length;
    },
    async dispose() {
      window.dispatchEvent({ type: "pagehide" });
      for (const socket of sockets) socket.close();
      for (const timer of timers) clearTimeout(timer);
      for (const timer of intervals) clearInterval(timer);
      await tick();
    },
  };
}
async function remember(db, drafts, room = null) {
  const state = new BrowserState({
    createIdentity: async () => "identity",
    identityId: (key) => `peer-${key}`,
    indexedDB: db,
    sessionStorage: drafts,
    channel: null,
  });
  const token = await state.remember(
    await state.prepareRemember(await state.guest()),
    "host",
    room,
  );
  return { state, token };
}
test("late identity generation and Noise completion cannot restore a forgotten page", async () => {
  let resolveIdentity;
  const first = page({
    makeIdentity: () =>
      new Promise((resolve) => {
        resolveIdentity = resolve;
      }),
  });
  try {
    await until(() => !first.element("connect").disabled);
    first.element("connect").click();
    await until(() => Boolean(resolveIdentity));
    first.element("forget-device").click();
    resolveIdentity("obsolete");
    for (let n = 0; n < 10; n++) await tick();
    assert.equal(first.calls.length, 0);
    assert.equal(first.element("device").textContent, "");
  } finally {
    await first.dispose();
  }
  let releaseNoise;
  const second = page({
    beforeSecure: () =>
      new Promise((resolve) => {
        releaseNoise = resolve;
      }),
  });
  try {
    await until(() => !second.element("connect").disabled);
    second.element("connect").click();
    await until(() => Boolean(releaseNoise));
    second.element("forget-device").click();
    releaseNoise();
    for (let n = 0; n < 10; n++) await tick();
    assert.equal(
      second.calls.some((call) => call.method === "hello"),
      false,
    );
    assert.equal(second.element("host").textContent, "");
  } finally {
    await second.dispose();
  }
});
test("a different invitation Host never replaces the remembered pin", async () => {
  const db = new IDBFactory();
  const { state, token } = await remember(db);
  const p = page({ db, hash: "#host=other&invite=" + "a".repeat(64) });
  try {
    await until(() => /Host.*不同/.test(p.element("status").textContent));
    p.element("connect").click();
    await tick();
    assert.equal(p.calls.length, 0);
    assert.equal(state.current().hostId, "host");
    assert.equal(token.hostId, "host");
  } finally {
    await p.dispose();
    state.close();
  }
});
