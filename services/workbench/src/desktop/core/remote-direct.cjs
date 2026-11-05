// @ts-check
"use strict";
const { createServer } = require("node:http");
const { WebSocketServer } = require("ws");
const { createHash } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { LIMITS } = require("./remote-session-acceptor.cjs");

/** @param {InstanceType<typeof import("./remote.cjs").RemoteControl>} remote */
async function startDirect(remote) {
  if (!remote.config?.directEnabled || !remote.config?.identity) throw new Error("Direct 未启用");
  const siteRoot =
    process.defaultApp || !process.resourcesPath
      ? resolve(__dirname, "../../../../../clients/gui/renderer/dist")
      : join(process.resourcesPath, "areal-gui");
  // 只发布构建产生的 Remote 闭包；桌面入口和其他 dist 文件不可通过此监听器读取。
  /** @type {unknown} */
  const descriptor = JSON.parse(await readFile(join(siteRoot, "remote-assets.json"), "utf8"));
  if (
    !record(descriptor) ||
    descriptor.schema !== 1 ||
    descriptor.entry !== "remote.html" ||
    !Array.isArray(descriptor.assets)
  )
    throw new Error("Remote 静态清单无效");
  /** @type {Map<string,{path:string,mime:string,sha256:string,content:Buffer}>} */
  const assets = new Map();
  for (const asset of [...descriptor.assets, descriptor.worker]) {
    if (
      !record(asset) ||
      typeof asset.path !== "string" ||
      typeof asset.sha256 !== "string" ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]+$/.test(asset.path) ||
      asset.path.split("/").some((part) => part === "." || part === "..") ||
      typeof asset.mime !== "string" ||
      /[\r\n]/.test(asset.mime) ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      assets.has("/" + asset.path)
    )
      throw new Error("Remote 静态资源无效");
    const content = await readFile(join(siteRoot, asset.path));
    if (createHash("sha256").update(content).digest("hex") !== asset.sha256)
      throw new Error("Remote 静态资源版本不一致");
    assets.set("/" + asset.path, {
      path: asset.path,
      mime: asset.mime,
      sha256: asset.sha256,
      content,
    });
  }
  if (
    !assets.has("/remote.html") ||
    !record(descriptor.worker) ||
    descriptor.worker.path !== "remote-sw.js"
  )
    throw new Error("Remote 静态入口缺失");
  // 仅匹配原始 Host 与 Origin；转发头不能扩展信任范围。
  /** @param {string|undefined} host @returns {string|null} */
  const acceptedOrigin = (host) => {
    const loopback = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    if (host === new URL(loopback).host) return loopback;
    const external = remote.networkOrigin;
    return external && host === new URL(external).host ? external : null;
  };
  const server = createServer((request, response) => {
    const host = request.headers.host;
    const origin = acceptedOrigin(host);
    if (!origin || request.method !== "GET") {
      response.writeHead(404);
      response.end();
      return;
    }
    const asset = assets.get(request.url === "/" ? "/remote.html" : (request.url ?? ""));
    if (asset) {
      response.writeHead(200, {
        "Content-Type": asset.mime,
        "Content-Security-Policy": `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' blob:; font-src 'self'; manifest-src 'self'; worker-src 'self'; connect-src 'self' ${origin.replace(/^http/, "ws")}; base-uri 'none'; frame-ancestors 'none'`,
        "Referrer-Policy": "no-referrer",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": asset.path.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : asset.path === "remote-sw.js"
            ? "no-cache"
            : "no-store",
        ...(asset.path === "remote-sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      });
      response.end(asset.content);
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end('{"status":"ready"}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.transportFrameBytes,
    perMessageDeflate: false,
  });
  const sockets = new Set(/** @type {import("ws")[]} */ ([]));
  server.on("upgrade", (request, socket, head) => {
    const origin = acceptedOrigin(request.headers.host);
    if (
      request.url !== "/remote/socket" ||
      !origin ||
      request.headers.origin !== origin ||
      !remote.sessions.available()
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("error", () => {});
      let lastPong = Date.now();
      ws.on("pong", () => {
        lastPong = Date.now();
      });
      const heartbeat = setInterval(() => {
        if (Date.now() - lastPong > LIMITS.heartbeatTimeoutMs) {
          ws.terminate();
          return;
        }
        if (ws.readyState === 1) ws.ping();
      }, LIMITS.heartbeatIntervalMs);
      heartbeat.unref?.();
      ws.on("close", () => {
        sockets.delete(ws);
        clearInterval(heartbeat);
      });
      remote.sessions.accept(ws);
    });
  });
  await new Promise(
    /** @param {(value?:void)=>void} resolve */ (resolve, reject) => {
      server.once("error", reject);
      const port = remote.config.directPort ?? 0;
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        return reject(new Error("Remote 端口无效"));
      server.listen(port, "127.0.0.1", resolve);
    },
  );
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  /** @type {Promise<void>|undefined} */
  let closing;
  return {
    server,
    sockets,
    origin: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}/remote/socket`,
    close() {
      if (closing) return closing;
      for (const socket of sockets) socket.terminate();
      wss.close();
      closing = new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      void closing.catch(() => {});
      return closing;
    },
  };
}

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

module.exports = { startDirect, LIMITS };
