// @ts-check
"use strict";
const { withCurrentProfile } = require("./remote-config.cjs");
const { networkInterfaces } = require("node:os");
const { isIP } = require("node:net");
const { mkdir, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { request: httpsRequest } = require("node:https");
const { desktopTlsOptions } = require("./desktop-network.cjs");
const { randomBytes, createHash } = require("node:crypto");
const { prepareRelayResources, loadRelayModules } = require("./relay-resources.cjs");

/** @param {string} address */
function privateAddress(address) {
  if (isIP(address) === 6) return /^f[cd]/i.test(address);
  if (isIP(address) !== 4) return false;
  const [a, b] = address.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
/** @param {ReturnType<typeof networkInterfaces>} interfaces */
function localAddress(interfaces) {
  const addresses = Object.values(interfaces)
    .flatMap((items) => items ?? [])
    .filter((item) => !item.internal && privateAddress(item.address));
  return addresses.find((item) => item.family === "IPv4")?.address ?? addresses[0]?.address;
}
/** @param {string} origin */
function verifyHttps(origin) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      `${origin}/healthz`,
      { ...desktopTlsOptions(), method: "GET" },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          if ((size += chunk.length) > 1024) request.destroy();
          else chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          try {
            if (
              response.statusCode !== 200 ||
              JSON.parse(Buffer.concat(chunks).toString()).ok !== true
            )
              throw new Error("Relay HTTPS 健康检查失败");
            resolve(true);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error("Relay HTTPS 健康检查超时")),
      15000,
    );
    request.once("close", () => clearTimeout(deadline));
    request.once("error", reject);
    request.end();
  });
}
/** @typedef {import('./remote-config.cjs').RelayDeploymentConfig} DeploymentConfig */
class RelayService {
  /** @type {{phase:'stopped'|'starting'|'running'|'failed',address:string,error:string,version:string}} */
  local = { phase: "stopped", address: "", error: "", version: "" };
  /** @type {{operation:string,phase:'running'|'done'|'failed'|'unknown',error:string}|null} */
  job = null;
  /** @type {{close:()=>Promise<unknown>}|null} */ server = null;
  /** @type {{close:()=>void}|null} */ store = null;
  /** @type {InstanceType<typeof import('./relay-deployment.cjs').RelayDeployment>|null} */ deployment =
    null;
  closed = false;
  /** @type {Promise<void>|undefined} */ starting;
  /** @type {Promise<void>|undefined} */ deploymentTask;
  /** @type {Promise<unknown>|undefined} */ serverClosing;
  /** @type {Promise<void>|undefined} */ closing;
  /** @param {InstanceType<typeof import('./remote.cjs').RemoteControl>} remote @param {{interfaces?:typeof networkInterfaces,resources?:typeof prepareRelayResources,modules?:typeof loadRelayModules}} [options] */
  constructor(
    remote,
    {
      interfaces = networkInterfaces,
      resources = prepareRelayResources,
      modules = loadRelayModules,
    } = {},
  ) {
    this.remote = remote;
    this.interfaces = interfaces;
    this.resources = resources;
    this.modules = modules;
  }
  state() {
    const saved = this.remote.config.relayDeployment;
    return {
      local: { ...this.local },
      deployment: saved
        ? {
            target: saved.target,
            port: saved.port,
            address: saved.address,
            phase: saved.phase,
            version: saved.version ?? "",
            active: saved.active === true,
            canReconfigure: saved.canReconfigure === true,
          }
        : null,
      job: this.job ? { ...this.job } : null,
      profiles: (this.remote.config.relayProfiles ?? []).map(({ origin, kind }) => ({
        origin,
        kind,
        active: origin === this.remote.config.relay && this.remote.config.enabled === true,
      })),
    };
  }
  /** @param {boolean} [activate] */
  startLocal(activate = true) {
    if (this.starting) return this.starting;
    const task = this.startLocalOnce(activate);
    this.starting = task;
    void task.then(
      () => {
        this.starting = undefined;
      },
      () => {
        this.starting = undefined;
      },
    );
    return task;
  }
  /** @param {boolean} activate */
  async startLocalOnce(activate) {
    if (this.closed) throw new Error("Relay 服务已关闭");
    if (this.server) {
      if (activate) await this.remote.useRelayProfile(this.local.address);
      return;
    }
    this.local = { phase: "starting", address: "", error: "", version: "" };
    this.remote.service.schedule();
    try {
      const address = localAddress(this.interfaces());
      if (!address) throw new Error("没有可用的内网地址，请连接可互通的内网或 VPN 后重试");
      const preferredPort = this.remote.config.relayLocal?.port ?? 47820;
      const { bundleDir, version } = await this.resources({ home: this.remote.backend.home });
      const { serve, openStore, readConfig } = await this.modules();
      if (this.closed) throw new Error("Relay 服务已关闭");
      const existing = (this.remote.config.relayProfiles ?? []).find(
        (profile) => profile.kind === "local",
      );
      const capability = existing?.capability ?? randomBytes(32).toString("base64url");
      const room = createHash("sha256").update(capability).digest("hex");
      const identity = this.remote.config.identity ?? (await this.remote.crypto.createIdentity());
      const profiles = (withCurrentProfile(this.remote.config).relayProfiles ?? []).filter(
        (profile) => profile.kind !== "local",
      );
      const dataDir = join(this.remote.backend.home, "relay-service", "local");
      await mkdir(dataDir, { recursive: true, mode: 0o700 });
      const file = join(dataDir, "config.json");
      /** @type {ReturnType<typeof openStore>|undefined} */
      let store;
      for (let port = preferredPort; port < preferredPort + 20 && port <= 65535; port++) {
        const origin = `http://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
        await this.remote.save({
          ...this.remote.config,
          identity,
          relayLocal: { enabled: true, port, origin },
          relayProfiles: [...profiles, { origin, kind: "local", capability, room }],
        });
        await writeFile(
          file,
          JSON.stringify({
            local: true,
            publicOrigin: origin,
            listen: `${isIP(address) === 6 ? "[::]" : "0.0.0.0"}:${port}`,
            allowedClientOrigins: [origin],
            allowedAppOrigins: ["capacitor://localhost"],
            dataDir,
            assetsDir: join(bundleDir, "assets"),
          }),
          { mode: 0o600 },
        );
        if (this.closed) throw new Error("Relay 服务已关闭");
        const config = readConfig(file);
        store ??= openStore(config);
        this.store = store;
        store.provision(room);
        try {
          const server = await serve(config, store);
          if (this.closed) {
            this.serverClosing = server.close();
            await this.serverClosing;
            throw new Error("Relay 服务已关闭");
          }
          this.server = server;
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE")
            continue;
          throw error;
        }
        this.local = { phase: "running", address: origin, error: "", version };
        if (activate) await this.remote.useRelayProfile(origin);
        return;
      }
      throw new Error("本机 Relay 端口不可用");
    } catch (error) {
      if (this.server) {
        this.serverClosing = this.server.close();
        await this.serverClosing;
      }
      this.server = null;
      this.store?.close();
      this.store = null;
      this.local = {
        ...this.local,
        phase: "failed",
        error: error instanceof Error ? error.message : "本机 Relay 启动失败",
      };
      throw error;
    } finally {
      this.remote.service.schedule();
    }
  }
  async stopLocal() {
    await this.remote.save({
      ...this.remote.config,
      relayLocal: this.remote.config.relayLocal
        ? { ...this.remote.config.relayLocal, enabled: false }
        : undefined,
      ...(this.remote.config.relay === this.local.address ? { enabled: false } : {}),
    });
    if (this.remote.config.relay === this.local.address) {
      this.remote.cancelPair();
      this.remote.disconnect();
    }
    await this.server?.close();
    this.server = null;
    this.store?.close();
    this.store = null;
    this.local = { ...this.local, phase: "stopped", error: "" };
  }
  /** @param {'deploy'|'upgrade'|'inspect'|'remove'} operation @param {{target?:string,port?:number,address?:string,removeData?:boolean}} request */
  async startDeployment(operation, request) {
    if (this.closed) throw new Error("Relay 服务已关闭");
    if (this.job?.phase === "running") throw new Error("已有 Relay 部署任务正在运行");
    const saved = this.remote.config.relayDeployment;
    if (saved?.phase === "pending" && operation !== "inspect")
      throw new Error("上次部署结果待核对，请先检查服务器状态");
    if (saved && operation === "deploy" && !["failed", "removed"].includes(saved.phase))
      throw new Error("已有服务器部署，请使用升级或移除操作");
    if (
      saved &&
      operation === "deploy" &&
      (request.target !== saved.target || request.port !== saved.port) &&
      saved.canReconfigure !== true
    )
      throw new Error("服务器仍保留部署或数据，请先移除并核对完全清理状态");
    /** @type {DeploymentConfig} */
    const config =
      operation === "deploy" && !saved
        ? {
            target: /** @type {string} */ (request.target),
            port: request.port ?? 22,
            address: /** @type {string} */ (request.address),
            ownerId: randomBytes(16).toString("hex"),
            capability: randomBytes(32).toString("base64url"),
            room: "",
            phase: "pending",
          }
        : {
            .../** @type {DeploymentConfig} */ (saved),
            ...(operation === "deploy"
              ? {
                  target: /** @type {string} */ (request.target),
                  port: request.port ?? 22,
                  address: /** @type {string} */ (request.address),
                }
              : {}),
            phase: "pending",
            canReconfigure: false,
          };
    if (!saved && operation !== "deploy") throw new Error("尚未配置 SSH Relay");
    config.room = createHash("sha256").update(config.capability).digest("hex");
    const { parseTarget } = require("./relay-deployment.cjs");
    parseTarget(config);
    this.job = { operation, phase: "running", error: "" };
    this.remote.service.schedule();
    this.deploymentTask = this.runDeployment(operation, config, request.removeData === true);
  }
  /** @param {'deploy'|'upgrade'|'inspect'|'remove'} operation @param {DeploymentConfig} config @param {boolean} removeData */
  async runDeployment(operation, config, removeData) {
    try {
      const { bundleDir } = await this.resources({ home: this.remote.backend.home });
      const { RelayDeployment } = require("./relay-deployment.cjs");
      if (this.closed) return;
      this.deployment = new RelayDeployment({ home: this.remote.backend.home, bundleDir });
      if (operation === "deploy") {
        const inspected = await this.deployment.inspect(config);
        if (this.closed) return;
        if (!inspected.installed && inspected.absent !== true && inspected.dataRetained !== true)
          throw new Error("服务器移除状态未确认，请继续核对");
      }
      if (operation !== "inspect") {
        const persist = () => this.remote.save({ ...this.remote.config, relayDeployment: config });
        const task = (this.remote.writes ?? Promise.resolve()).catch(() => {}).then(persist);
        this.remote.writes = task;
        await task;
        if (this.closed) return;
      }
      const result = await this.deployment[operation]({ ...config, removeData });
      if (this.closed) return;
      let diagnostic = "";
      const registrationMatches =
        result.room === config.room &&
        result.roomActive === true &&
        result.address === config.address;
      let ready = result.installed && result.active && registrationMatches;
      if (!result.installed && result.absent !== true && result.dataRetained !== true)
        throw new Error("服务器移除状态未确认，请继续核对");
      if (result.installed && !ready)
        diagnostic = "服务器登记或运行状态未完成，可明确重试部署或升级";
      if (ready) {
        try {
          await verifyHttps(config.address);
        } catch {
          ready = false;
          diagnostic = "服务器进程运行中，但桌面尚未通过可信 HTTPS 健康检查";
        }
      }
      const updated = {
        ...config,
        phase: /** @type {'ready'|'failed'|'removed'} */ (
          ready ? "ready" : result.installed ? "failed" : "removed"
        ),
        active: result.active,
        canReconfigure: result.absent === true,
        version: result.version,
      };
      const commit = async () => {
        if (this.closed) return;
        const profiles = (withCurrentProfile(this.remote.config).relayProfiles ?? []).filter(
          (item) => !ready || item.origin !== config.address,
        );
        await this.remote.save({
          ...withCurrentProfile(this.remote.config),
          relayDeployment: updated,
          relayProfiles: ready
            ? [
                ...profiles,
                {
                  origin: config.address,
                  kind: "ssh",
                  room: config.room,
                  capability: config.capability,
                },
              ]
            : profiles,
        });
        if (ready && operation !== "inspect") await this.remote.useRelayProfile(config.address);
        if (operation === "remove" && this.remote.config.relay === config.address) {
          await this.remote.save({ ...this.remote.config, enabled: false });
          this.remote.cancelPair();
          this.remote.disconnect();
        }
      };
      const task = (this.remote.writes ?? Promise.resolve()).catch(() => {}).then(commit);
      this.remote.writes = task;
      await task;
      this.job = { operation, phase: diagnostic ? "failed" : "done", error: diagnostic };
    } catch (error) {
      const unknown =
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "SSH_MUTATION_UNKNOWN";
      this.job = {
        operation,
        phase: unknown ? "unknown" : "failed",
        error: error instanceof Error ? error.message : "Relay 部署失败",
      };
    } finally {
      this.remote.service.schedule();
    }
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    const server = this.server;
    const store = this.store;
    this.server = null;
    this.store = null;
    if (server) this.serverClosing = server.close();
    const resourcesClosing = Promise.all([this.serverClosing, this.deployment?.close()]);
    void resourcesClosing.catch(() => {});
    this.closing = (async () => {
      try {
        await Promise.allSettled([this.starting, this.deploymentTask]);
        await resourcesClosing;
        await this.serverClosing;
      } finally {
        store?.close();
        this.store?.close();
        this.store = null;
      }
    })();
    void this.closing.catch(() => {});
    return this.closing;
  }
}
module.exports = { RelayService, localAddress, privateAddress };
