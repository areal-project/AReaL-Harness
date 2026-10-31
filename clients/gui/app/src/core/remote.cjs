// @ts-check
"use strict";
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const {
  parseRemoteConfig,
  migrateLegacyDevices,
  strings,
  failureCode,
  enrollmentFailureMessage,
} = require("./remote-config.cjs");
const { RemotePush } = require("./remote-push.cjs");
const { RelayTransport } = require("./remote-relay.cjs");
const { request: httpsRequest } = require("node:https");
const { desktopTlsOptions } = require("./desktop-network.cjs");
const { createHash } = require("node:crypto");
const QRCode = require("qrcode");
const { SessionAcceptor } = require("./remote-session-acceptor.cjs");
const { distinctName, forgetRevoked, renameDevice, revokeDevice } = require("./remote-devices.cjs");
const { startDirect } = require("./remote-direct.cjs");
const { createRemoteNetworkAdapter, validateHttpsOrigin } = require("./remote-network.cjs");
const PRESETS = Object.freeze({
  Observer: ["observe", "review"],
  Operator: ["observe", "review", "submit", "interrupt", "answer", "pauseTask"],
});
/** @param {string} code @param {string} message */
const pairingError = (code, message) => Object.assign(new Error(message), { code });

const { isRemoteRequest } = require("@areal/workbench/desktop-contract/desktop-control");
/** @typedef {import('./remote-config.cjs').RemoteConfig} RemoteConfig */
/** @typedef {import('./remote-config.cjs').DeviceGrant} DeviceGrant */
/** @typedef {import('./remote-network.cjs').NetworkMapping} NetworkMapping */
/** @typedef {Awaited<ReturnType<typeof startDirect>>} DirectServer */
/** @typedef {{name:string,clientKind?:'web'|'ios'|'android',expiresAt:number,connected:()=>boolean,accept:(grant:DeviceGrant)=>void,reject:(error:Error)=>void,arm:()=>void,timer?:NodeJS.Timeout,approving?:boolean}} PendingPair */
/** @typedef {{backend:InstanceType<typeof import('./backend.cjs').CoreBackend>,schedule:()=>void}} RemoteService */
/** @typedef {Pick<typeof import('electron').safeStorage,'isEncryptionAvailable'|'encryptString'|'decryptString'> & {getSelectedStorageBackend?:()=>string}} RemoteEncryption */
class RemoteControl {
  /** @type {typeof import('@areal/remote')|null} */ transportModule = null;
  get crypto() {
    if (!this.transportModule) throw new Error("Remote transport is not initialized");
    return this.transportModule;
  }
  /** @param {typeof import('@areal/remote')} value */
  set crypto(value) {
    this.transportModule = value;
  }
  /** @type {RemoteConfig} */ config = { enabled: false, devices: [] };
  /** @type {NodeJS.Timeout|undefined} */ retry;
  /** @type {DirectServer|null} */ direct = null;
  /** @type {InstanceType<typeof RelayTransport>|null} */ relayTransport = null;
  /** @type {string|null} */ relayError = null;
  /** @type {string|null} */ directError = null;
  /** @type {string|null} */ migrationError = null;
  /** @type {string|null} */ networkOrigin = null;
  /** @type {string|null} */ networkReconciliation = null;
  /** @type {string|null} */ networkError = null;
  /** @type {Record<string,unknown>|null} */ networkInspection = null;
  /** @type {{record:NetworkMapping,proposalId?:string,config:RemoteConfig,direct:DirectServer|null}|null} */ networkProposal =
    null;
  /** @type {{secret:string,expiresAt:number}|null} */ invite = null;
  /** @type {Promise<unknown>|undefined} */ writes;
  closed = false;
  /** @param {RemoteService} service @param {RemoteEncryption} encryption @param {{networkAdapterFactory?:typeof createRemoteNetworkAdapter}} [options] */
  constructor(service, encryption, { networkAdapterFactory = createRemoteNetworkAdapter } = {}) {
    this.service = service;
    this.backend = service.backend;
    this.encryption = encryption;
    this.network = networkAdapterFactory({
      verifyRemoteListener: (listener) => this.verifyListener(listener),
    });
    this.gatewayGeneration = randomUUID();
    /** @type {InstanceType<typeof RelayTransport>["channels"]} */
    this.channels = new Map();
    /** @type {Map<string,PendingPair>} */
    this.pending = new Map();
    // 最近连接时间只在本次运行内记录，避免每次连接都写加密配置。
    /** @type {Map<string,number>} */
    this.lastSeen = new Map();
    this.connected = false;
    this.sessions = new SessionAcceptor(this);
    this.push = new RemotePush(this);
  }
  async init() {
    this.transportModule = await import("@areal/remote");
    try {
      /** @type {unknown} */
      const data = JSON.parse(await readFile(join(this.backend.home, "remote.json"), "utf8"));
      if (
        !data ||
        typeof data !== "object" ||
        !("encrypted" in data) ||
        typeof data.encrypted !== "string"
      )
        throw new Error("远程配置格式无效");
      this.config = parseRemoteConfig(
        JSON.parse(this.encryption.decryptString(Buffer.from(data.encrypted, "base64"))),
      );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
        throw new Error("无法读取手机配对；请检查系统钥匙串");
      // 新配置尚未申请远程入口，不让安全存储的系统交互阻塞桌面与 Core 启动。
      // 已有加密配对仍按原路径读取；首次启用时再检查并使用系统安全存储。
      this.config = { enabled: false, devices: [] };
      return;
    }
    this.config ??= { enabled: false, devices: [] };
    if (this.config.schemaVersion !== 2 && this.config.devices?.length) {
      const migrated = migrateLegacyDevices(this.config);
      try {
        await this.save(migrated);
      } catch {
        this.config = migrated;
        this.migrationError =
          "旧身份和项目范围已保留，但迁移未保存；入口保持关闭，请检查安全存储后重新启用。";
      }
    }
    if (!this.storageAvailable()) {
      this.config = { ...this.config, enabled: false, directEnabled: false };
      this.directError = "系统安全存储不可用，远程入口保持关闭";
      return;
    }
    if (this.config.enabled && this.config.relayProtocol !== "areal.remote.v2") {
      await this.save({ ...this.config, enabled: false });
      this.relayError = "旧 Relay 登记需使用管理员登记码重新确认";
    }
    if (this.config.enabled) this.connect();
    if (
      !this.config.directEnabled &&
      this.config.network?.mapping &&
      this.config.network.mapping.state !== "removed"
    )
      await this.removeNetwork();
    if (this.config.directEnabled) {
      try {
        await this.startDirect();
        await this.reconcileNetwork();
      } catch {
        // 可选入口失败不能阻止桌面后台与 Core 恢复；尽力持久关闭入口。
        this.direct?.close();
        this.direct = null;
        const disabled = { ...this.config, directEnabled: false };
        try {
          await this.save(disabled);
          this.directError = "Remote 入口启动失败；请检查 GUI 构建或被占用的固定端口后重试启用。";
          if (this.config.network?.mapping) await this.removeNetwork();
        } catch {
          this.config = disabled;
          this.directError = "本机只读入口启动失败，关闭状态未能保存；请检查系统安全存储后重试。";
        }
      }
    }
  }
  storageAvailable() {
    return (
      this.encryption.isEncryptionAvailable() &&
      this.encryption.getSelectedStorageBackend?.() !== "basic_text"
    );
  }
  /** @param {RemoteConfig} config */
  async save(config) {
    if (!this.storageAvailable()) throw new Error("系统安全存储不可用");
    await this.backend.save("remote.json", {
      encrypted: this.encryption.encryptString(JSON.stringify(config)).toString("base64"),
    });
    this.config = config;
  }
  state() {
    return {
      enabled: this.config?.enabled === true,
      connected: this.connected,
      relay: this.config?.relay ?? "",
      relayError: this.relayError ?? "",
      relayUrl:
        this.config?.enabled &&
        this.config?.relayProtocol === "areal.remote.v2" &&
        this.config?.identity &&
        this.config.room
          ? `${this.config.relay}/#${new URLSearchParams({ host: this.crypto.identityId(this.config.identity), room: this.config.room })}`
          : "",
      directEnabled: this.config?.directEnabled === true,
      directUrl: this.direct ? this.networkOrigin || this.direct.origin : "",
      network: {
        kind: this.config?.network?.kind ?? null,
        scope:
          this.config?.network?.kind === "tailscale"
            ? this.config.network.mapping?.state === "owned"
              ? (this.config.network.mapping.scope ?? "private")
              : null
            : (this.config?.network?.visibility ?? null),
        reconciliation: this.networkReconciliation ?? null,
        publicOrigin: this.networkOrigin ?? "",
        diagnostic: this.networkError ?? "",
        policy: "unknown",
        phoneAccess: "unknown",
        inspection: this.networkInspection ?? null,
      },
      directHostId:
        this.direct && this.config?.identity && this.config.room
          ? this.crypto.identityId(this.config.identity)
          : "",
      directError: this.directError ?? "",
      migrationError: this.migrationError ?? "",
      pushSupported: this.relayTransport?.pushSupported === true,
      deviceGrants: (this.config?.deviceGrants ?? []).map(({ push, ...grant }) => ({
        ...grant,
        pushRegistered: !!push,
        online: grant.status === "active" && this.sessions.online(grant.devicePeerId),
        lastSeenAt: this.lastSeen.get(grant.devicePeerId) ?? null,
      })),
      devices: [],
      pending: [...this.pending].map(([id, entry]) => ({
        id,
        name: entry.name,
        ...(entry.clientKind ? { clientKind: entry.clientKind } : {}),
        fingerprint: id,
        expiresAt: entry.expiresAt,
      })),
    };
  }
  /** @param {unknown} request */
  control(request) {
    if (!isRemoteRequest(request)) throw new Error("无效手机设置参数");
    // Pairing and revocation are serialized with durable configuration writes.
    const task = (this.writes ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.controlOnce(request));
    this.writes = task;
    return task;
  }
  /** @param {RemoteSettingsRequest} request */
  async controlOnce(request) {
    switch (request.operation) {
      case "status":
        return this.state();
      case "networkPropose":
        return this.proposeNetwork(request);
      case "networkProposeScope":
        return this.proposeNetworkScope(request);
      case "networkChangeScope":
        await this.changeNetworkScope(request);
        break;
      case "networkInspect":
        this.validateNetworkRequest(request, []);
        await this.inspectNetwork();
        break;
      case "networkRecover":
        this.validateNetworkRequest(request, ["confirmed"], true);
        await this.reconcileNetwork(true, true);
        break;
      case "networkApply":
        await this.applyNetwork(request);
        break;
      case "networkConfigureOrganization":
        await this.configureOrganization(request);
        break;
      case "networkRemove":
        this.validateNetworkRequest(request, ["confirmed"], true);
        await this.removeNetwork();
        break;
      case "enable":
        await this.enableRelay(request);
        break;
      case "disable":
        await this.save({ ...this.config, enabled: false });
        this.cancelPair();
        this.disconnect();
        break;
      case "enableDirect": {
        if (!this.storageAvailable()) throw new Error("系统安全存储不可用");
        if (this.direct) break;
        const previous = this.config;
        const identity = this.config.identity ?? (await this.crypto.createIdentity());
        const candidate = { ...this.config, identity, directEnabled: true };
        this.config = candidate;
        try {
          this.direct = await startDirect(this);
          await this.save({
            ...candidate,
            directPort: this.listener().port,
          });
          this.directError = null;
          this.migrationError = null;
          await this.reconcileNetwork();
        } catch {
          this.direct?.close();
          this.direct = null;
          this.config = previous;
          this.directError = "本机只读入口启用失败；请检查 GUI 构建、端口或系统安全存储后重试。";
          this.service.schedule();
          throw new Error(this.directError);
        }
        break;
      }
      case "disableDirect": {
        await this.save({ ...this.config, directEnabled: false });
        this.cancelPair();
        this.changeNetworkOrigin(null);
        this.direct?.close();
        this.direct = null;
        this.directError = null;
        await this.removeNetwork();
        break;
      }
      case "pair": {
        const transport = request.transport ?? "direct";
        if (transport !== "direct" && transport !== "relay")
          throw new Error("请选择有效的配对入口");
        if (transport === "direct" && !this.direct) throw new Error("请先启用本机入口");
        if (transport === "relay" && (!this.config.enabled || !this.connected))
          throw new Error("请先连接 Relay");
        this.cancelPair();
        this.invite = {
          secret: randomBytes(32).toString("hex"),
          expiresAt: Date.now() + 120000,
        };
        if (!this.config.identity) throw new Error("Remote 身份不可用");
        const fragment = new URLSearchParams({
          host: this.crypto.identityId(this.config.identity),
          invite: this.invite.secret,
        });
        if (transport === "relay") {
          if (!this.config.room) throw new Error("Relay 房间不可用");
          fragment.set("room", this.config.room);
        }
        const origin =
          transport === "relay" ? this.config.relay : this.networkOrigin || this.direct?.origin;
        if (!origin) throw new Error("Remote 入口不可用");
        const payload = `${origin}/#${fragment}`;
        return {
          payload,
          qr: await QRCode.toDataURL(payload),
          expiresAt: this.invite.expiresAt,
        };
      }
      case "cancelPair":
        this.cancelPair();
        break;
      case "reject": {
        this.pending.get(request.id)?.reject(pairingError("PAIRING_CANCELLED", "桌面已拒绝配对"));
        break;
      }
      case "approve":
      case "updateGrant": {
        const entry = this.pending.get(request.id);
        const previous = (this.config.deviceGrants ?? []).find(
          (value) => value.devicePeerId === request.id,
        );
        if (
          request.operation === "approve" &&
          (!entry || entry.expiresAt <= Date.now() || !entry.connected())
        )
          throw new Error("配对请求已过期");
        if (request.operation === "updateGrant" && (!previous || previous.status === "revoked"))
          throw new Error("设备未获授权");
        if (
          !strings(request.projects) ||
          !request.projects.length ||
          request.projects.some((id) => !this.backend.saved.some((project) => project.id === id))
        )
          throw new Error("请至少选择一个已有项目");
        if (request.preset !== "Observer" && request.preset !== "Operator")
          throw new Error("请选择 Observer 或 Operator");
        const displayName =
          request.operation === "approve" && entry
            ? distinctName(this.config.deviceGrants ?? [], entry.name, request.id)
            : previous?.displayName;
        if (displayName === undefined) throw new Error("设备未获授权");
        const clientKind =
          request.operation === "approve" ? entry?.clientKind : previous?.clientKind;
        /** @type {DeviceGrant} */
        const grant = {
          devicePeerId: request.id,
          displayName,
          ...(clientKind ? { clientKind } : {}),
          projectIds: [...new Set(request.projects)],
          capabilities: [...PRESETS[request.preset]],
          revision: (previous?.revision ?? 0) + 1,
          status: "active",
          ...(request.operation === "approve"
            ? { pairedAt: Date.now() }
            : previous?.pairedAt
              ? { pairedAt: previous.pairedAt }
              : {}),
          ...(request.operation === "updateGrant" && previous?.push ? { push: previous.push } : {}),
        };
        // 本地确认是期限内的决定；持久写入期间不返回 ready，失败后仍可重试确认。
        if (entry) {
          entry.approving = true;
          clearTimeout(entry.timer);
        }
        try {
          await this.save({
            ...this.config,
            deviceGrants: [
              ...(this.config.deviceGrants ?? []).filter(
                (value) => value.devicePeerId !== request.id,
              ),
              grant,
            ],
          });
        } catch (error) {
          if (entry) {
            entry.approving = false;
            entry.arm();
          }
          throw error;
        }
        this.closePeer(request.id);
        entry?.accept(grant);
        break;
      }
      case "revoke":
        await revokeDevice(this, request.id);
        break;
      case "renameDevice":
        await renameDevice(this, request.id, request.name);
        break;
      case "forgetRevoked":
        await forgetRevoked(this);
        break;
      default:
        throw new Error("无效手机设置操作");
    }
    this.service.schedule();
    return this.state();
  }
  /** @param {RemoteSettingsFields} request */
  async enableRelay(request) {
    this.validateNetworkRequest(request, ["relay", "code", "confirmed"], true);
    const relay = validateHttpsOrigin(request.relay);
    if (!this.storageAvailable()) throw new Error("系统安全存储不可用");
    /** @type {{room:string,capability:string}} */
    let registration;
    if (request.code !== undefined) {
      if (typeof request.code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request.code))
        throw pairingError("invalid-code", "请输入管理员生成的一次性登记码");
      // 使用系统 TLS 验证，不重定向、不发送 Origin；错误不包含登记凭据。
      registration = await new Promise((resolve, reject) => {
        const body = JSON.stringify({ code: request.code });
        const req = httpsRequest(
          `${relay}/enroll`,
          {
            ...desktopTlsOptions(),
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (response) => {
            /** @type {Buffer[]} */
            const chunks = [];
            let size = 0;
            response.on("data", (chunk) => {
              if ((size += chunk.length) > 4096) req.destroy();
              else chunks.push(chunk);
            });
            response.on("error", () =>
              reject(pairingError("enrollment-failed", "Relay 登记失败，请检查 HTTPS 和登记码")),
            );
            response.on("end", () => {
              try {
                /** @type {unknown} */
                const value = JSON.parse(Buffer.concat(chunks).toString());
                if (
                  response.statusCode !== 201 ||
                  !value ||
                  typeof value !== "object" ||
                  !("capability" in value) ||
                  typeof value.capability !== "string" ||
                  !("room" in value) ||
                  typeof value.room !== "string" ||
                  !/^[A-Za-z0-9_-]{43}$/.test(value.capability) ||
                  createHash("sha256").update(value.capability).digest("hex") !== value.room
                )
                  throw new Error();
                resolve({ room: value.room, capability: value.capability });
              } catch {
                reject(pairingError("enrollment-failed", "Relay 登记失败，请检查 HTTPS 和登记码"));
              }
            });
          },
        );
        const deadline = setTimeout(() => req.destroy(), 15000);
        req.once("close", () => clearTimeout(deadline));
        req.once("error", (error) => {
          reject(pairingError("enrollment-failed", enrollmentFailureMessage(error)));
        });
        req.end(body);
      });
    } else {
      if (
        this.config.relayProtocol !== "areal.remote.v2" ||
        relay !== this.config.relay ||
        !this.config.capability ||
        !this.config.room
      )
        throw pairingError("enrollment-required", "请使用管理员登记码登记此 Relay");
      registration = { room: this.config.room, capability: this.config.capability };
    }
    const identity = this.config.identity ?? (await this.crypto.createIdentity());
    if (this.closed) throw new Error("Host 已关闭");
    // 长期凭据必须先进入既有加密配置，成功后才建立出站连接。
    await this.save({
      ...this.config,
      ...registration,
      relay,
      identity,
      enabled: true,
      relayProtocol: "areal.remote.v2",
    });
    this.cancelPair();
    this.disconnect();
    this.connect();
  }
  async inspectNetwork() {
    try {
      const snapshot = await this.network.inspect();
      this.networkInspection = Object.fromEntries(
        /** @type {const} */ ([
          "available",
          "diagnostic",
          "version",
          "persistentServe",
          "funnelPorts",
          "login",
          "https",
          "policy",
        ])
          .filter((key) => snapshot[key] !== undefined)
          .map((key) => [key, snapshot[key]]),
      );
      this.networkError = null;
      await this.reconcileNetwork(false);
    } catch (error) {
      this.networkInspection = { diagnostic: failureCode(error, "network-unavailable") };
      if (this.config.network?.kind === "tailscale") this.changeNetworkOrigin(null);
      this.networkError = failureCode(error, "network-unavailable");
    }
  }
  async removeNetwork() {
    this.changeNetworkOrigin(null);
    this.networkProposal = null;
    const network = this.config.network;
    if (!network) return;
    try {
      if (network.kind === "organization") {
        await this.save({ ...this.config, network: null });
      } else if (network.mapping && network.mapping.state !== "removed") {
        let record = network.mapping;
        if (record.operation === "scope" && record.state === "pending") {
          const observation = await this.network.reconcileScope(record);
          this.networkReconciliation = observation.state;
          if (observation.state === "changed")
            throw pairingError("mapping-changed", "映射已变化，不会覆盖外部配置");
          if (observation.state === "source")
            record = { ...record, scope: record.sourceScope ?? record.scope };
        }
        // 转为撤销记录时保留已核对的实际范围，不保留范围变更专用字段。
        const { sourceScope: _sourceScope, ...removal } = record;
        record = { ...removal, operation: "remove" };
        // 撤销意图先保存，即使 CLI 不可用也不能在重启时重新发布入口。
        /** @type {NetworkMapping} */
        const pending = { ...record, state: "pending", operation: "remove" };
        await this.save({
          ...this.config,
          network: {
            ...network,
            mapping: pending,
          },
        });
        const ownership = await this.network.inspectOwnership(record);
        if (ownership.state === "changed")
          throw pairingError("mapping-changed", "映射已由其他配置更改，未进行撤销");
        /** @type {NetworkMapping} */
        const mapping =
          ownership.state === "absent"
            ? { ...record, state: "removed", operation: "remove" }
            : await this.network.remove(pending, {
                persistPending: (mapping) =>
                  this.save({ ...this.config, network: { ...network, mapping } }),
              });
        await this.save({ ...this.config, network: { ...network, mapping } });
      }
      this.networkError = null;
      this.networkReconciliation = null;
    } catch (error) {
      this.networkError = failureCode(error, "persistence-failed");
    }
  }
  async reconcileNetwork(recover = true, recoverScope = false) {
    this.networkReconciliation = null;
    const network = this.config.network;
    if (!network) {
      this.changeNetworkOrigin(null);
      return;
    }
    try {
      if (network.kind === "organization") {
        if (this.direct) this.changeNetworkOrigin(validateHttpsOrigin(network.publicOrigin));
        return;
      }
      let mapping = network.mapping;
      if (!mapping || mapping.state === "removed") {
        this.changeNetworkOrigin(null);
        return;
      }
      if (mapping.operation === "remove" || !this.config.directEnabled) {
        if (recover) {
          await this.removeNetwork();
          return;
        }
        throw pairingError("cleanup-pending", "请重试移除映射");
      }
      if (!this.direct || mapping.target !== this.direct.origin)
        throw pairingError("listener-drift", "Remote 监听端口与映射不一致");
      if (mapping.operation === "scope" && mapping.state === "pending") {
        const observation = await this.network.reconcileScope(mapping);
        this.networkReconciliation = observation.state;
        if (!recoverScope)
          throw pairingError("reconciliation-required", "入口范围操作待本地核对，不会自动重放");
        if (observation.state === "changed")
          throw pairingError("mapping-changed", "映射已变化，不会覆盖外部配置");
        const { sourceScope, ...record } = mapping;
        mapping = {
          ...record,
          operation: "apply",
          scope: observation.state === "source" ? (sourceScope ?? record.scope) : record.scope,
          state: observation.state === "absent" ? "removed" : "pending",
        };
        if (observation.state === "absent") {
          await this.save({ ...this.config, network: { ...network, mapping } });
          this.changeNetworkOrigin(null);
          this.networkReconciliation = null;
          this.networkError = null;
          return;
        }
      }
      const ownership = await this.network.inspectOwnership(mapping);
      if (ownership.state !== "owned")
        throw pairingError(
          ownership.state === "absent" ? "mapping-absent" : "mapping-changed",
          "映射已变化，请检查并恢复",
        );
      const snapshot = await this.network.inspect();
      const publicOrigin = `${snapshot.publicOrigin}${mapping.httpsPort === 443 ? "" : `:${mapping.httpsPort}`}`;
      if (
        snapshot.login !== "logged-in" ||
        snapshot.https !== "enabled" ||
        publicOrigin !== mapping.publicOrigin
      )
        throw pairingError("network-changed", "网络身份或 HTTPS 状态已变化");
      if (mapping.state === "pending") {
        if (!recover) throw pairingError("reconciliation-required", "请确认恢复待核对的映射");
        try {
          await this.save({
            ...this.config,
            network: { ...network, mapping: { ...mapping, state: "owned" } },
          });
        } catch {
          throw pairingError("persistence-failed", "映射恢复未能保存，请检查安全存储");
        }
      }
      this.changeNetworkOrigin(mapping.publicOrigin);
      this.networkReconciliation = null;
      this.networkError = null;
    } catch (error) {
      this.changeNetworkOrigin(null);
      this.networkError = failureCode(error, "network-unavailable");
    }
  }
  listener() {
    const address = this.direct?.server.address();
    const listener = {
      host: typeof address === "object" ? address?.address : undefined,
      port: typeof address === "object" ? address?.port : undefined,
    };
    if (!this.verifyListener(listener))
      throw pairingError("unverified-listener", "Remote 入口已离线，请重新启用");
    return listener;
  }
  /** @param {{host?:string,port?:number}} listener @returns {listener is import("./remote-network.cjs").RemoteListener} */
  verifyListener(listener) {
    const address = this.direct?.server.address();
    return (
      !this.closed &&
      this.config?.directEnabled === true &&
      !!this.config.identity &&
      this.direct?.server.listening === true &&
      typeof address === "object" &&
      address?.address === "127.0.0.1" &&
      listener.host === "127.0.0.1" &&
      address.port === listener.port
    );
  }
  /** @param {RemoteSettingsFields} request @param {string[]} keys */
  validateNetworkRequest(request, keys, confirmation = false) {
    if (Object.keys(request).some((key) => !["operation", ...keys].includes(key)))
      throw pairingError("invalid-network-request", "网络设置包含不支持的字段");
    if (confirmation && request.confirmed !== true)
      throw pairingError("confirmation-required", "请先确认本地网络配置范围");
  }
  /** @param {RemoteSettingsFields} request */
  async proposeNetwork(request) {
    this.validateNetworkRequest(request, ["httpsPort"]);
    if (this.config.network?.mapping && this.config.network.mapping.state !== "removed")
      throw pairingError("mapping-exists", "请先移除或恢复已有映射");
    const record = await this.network.propose({
      remoteListener: this.listener(),
      httpsPort: request.httpsPort,
    });
    this.networkProposal = { record, config: this.config, direct: this.direct };
    return {
      proposalId: record.id,
      publicOrigin: record.publicOrigin,
      confirmation: `将以持久 Tailscale Serve 映射发布 ${record.publicOrigin}，仅转发 Remote 入口。手机必须加入同一 tailnet；组织策略及手机可达性尚未验证。`,
    };
  }
  /** @param {RemoteSettingsFields} request */
  async applyNetwork(request) {
    this.validateNetworkRequest(request, ["proposalId", "confirmed"], true);
    const proposal = this.networkProposal;
    if (
      !proposal ||
      proposal.record.operation !== "apply" ||
      request.proposalId !== proposal.record.id ||
      proposal.config !== this.config ||
      proposal.direct !== this.direct
    )
      throw pairingError("stale-proposal", "方案已失效，请重新检测并确认");
    this.networkProposal = null;
    this.listener();
    try {
      const mapping = await this.network.apply(proposal.record, {
        persistPending: async (mapping) => {
          await this.save({
            ...this.config,
            directPort: this.listener().port,
            network: { kind: "tailscale", mapping },
          });
          this.changeNetworkOrigin(null);
        },
      });
      await this.save({ ...this.config, network: { kind: "tailscale", mapping } });
      this.changeNetworkOrigin(mapping.publicOrigin);
      this.networkReconciliation = null;
      this.networkError = null;
    } catch (error) {
      this.networkError = failureCode(error, "persistence-failed");
      throw pairingError(
        this.networkError,
        `网络配置未完成：${this.networkError}；请检测并恢复或移除映射`,
      );
    }
  }
  /** @param {RemoteSettingsFields} request */
  async proposeNetworkScope(request) {
    this.validateNetworkRequest(request, ["scope"]);
    this.networkProposal = null;
    if (request.scope !== "private" && request.scope !== "public")
      throw pairingError("invalid-visibility", "请选择入口访问范围");
    const mapping = this.config.network?.mapping;
    if (this.config.network?.kind !== "tailscale" || mapping?.state !== "owned")
      throw pairingError("reconciliation-required", "请先创建或核对本应用映射");
    this.listener();
    const record = await this.network.proposeScope(mapping, request.scope);
    // 映射 id 保持所有权；每次确认使用独立 id，不能复用此前同来源的确认。
    const proposalId = randomUUID();
    this.networkProposal = { record, proposalId, config: this.config, direct: this.direct };
    return {
      proposalId,
      publicOrigin: record.publicOrigin,
      sourceScope: record.sourceScope,
      scope: record.scope,
      confirmation:
        record.scope === "public"
          ? `将 ${record.publicOrigin} 从 tailnet 私人入口改为公网 Funnel 入口。互联网可访问 Remote 配对入口；仍需 Host 指纹、短期邀请、桌面确认和逐操作授权。公网能力未认证，策略、手机及实际可达性未知。`
          : `将 ${record.publicOrigin} 从公网 Funnel 恢复为 tailnet 私人入口。当前邀请和连接将失效；请重新连接，配对时生成新邀请。`,
    };
  }
  /** @param {RemoteSettingsFields} request */
  async changeNetworkScope(request) {
    this.validateNetworkRequest(request, ["proposalId", "confirmed", "publicConfirmed"], true);
    const proposal = this.networkProposal;
    if (
      !proposal ||
      proposal.record.operation !== "scope" ||
      request.proposalId !== proposal.proposalId ||
      proposal.config !== this.config ||
      proposal.direct !== this.direct
    )
      throw pairingError("stale-proposal", "方案已失效，请重新检测并确认");
    if (proposal.record.scope === "public" && request.publicConfirmed !== true)
      throw pairingError(
        "public-confirmation-required",
        "请再次明确确认将 Remote 入口公开到互联网",
      );
    this.networkProposal = null;
    this.listener();
    try {
      const mapping = await this.network.changeScope(proposal.record, {
        persistPending: async (mapping) => {
          await this.save({ ...this.config, network: { kind: "tailscale", mapping } });
          // 即使 HTTPS 来源相同，访问范围变化也必须失效旧邀请与现有连接。
          this.changeNetworkOrigin(null, true);
        },
      });
      await this.save({ ...this.config, network: { kind: "tailscale", mapping } });
      this.changeNetworkOrigin(mapping.publicOrigin);
      this.networkReconciliation = null;
      this.networkError = null;
    } catch (error) {
      this.networkError = failureCode(error, "persistence-failed");
      throw pairingError(
        this.networkError,
        `入口范围更改未完成：${this.networkError}；请核对或移除映射`,
      );
    }
  }
  /** @param {RemoteSettingsFields} request */
  async configureOrganization(request) {
    this.validateNetworkRequest(
      request,
      ["publicOrigin", "visibility", "confirmed", "publicConfirmed"],
      true,
    );
    const publicOrigin = validateHttpsOrigin(request.publicOrigin);
    if (request.visibility !== "private" && request.visibility !== "public")
      throw pairingError("invalid-visibility", "请选择组织入口的访问范围");
    if (request.visibility === "public" && request.publicConfirmed !== true)
      throw pairingError("public-confirmation-required", "请明确确认组织入口可能公开访问");
    this.listener();
    if (this.config.network?.mapping && this.config.network.mapping.state !== "removed")
      throw pairingError("mapping-exists", "请先移除或恢复已有映射");
    await this.save({
      ...this.config,
      directPort: this.listener().port,
      network: { kind: "organization", publicOrigin, visibility: request.visibility },
    });
    this.changeNetworkOrigin(publicOrigin);
    this.networkError = null;
  }
  /** @param {string|null} origin */
  changeNetworkOrigin(origin, invalidate = false) {
    if (origin && (this.closed || !this.direct?.server.listening || !this.config.directEnabled))
      origin = null;
    if (invalidate || this.networkOrigin !== origin) {
      this.cancelPair();
      for (const socket of this.direct?.sockets ?? []) socket.terminate();
      this.clearChannels();
    }
    this.networkOrigin = origin;
  }
  /** @param {string} peer */
  closePeer(peer) {
    this.sessions.closePeer(peer);
  }
  cancelPair() {
    this.invite = null;
    for (const entry of Array.from(this.pending.values()))
      entry.reject(pairingError("PAIRING_CANCELLED", "配对已取消"));
  }
  /** @param {string} peer @param {{displayName:string,clientKind?:'web'|'ios'|'android',inviteSecret?:unknown}} hello @param {{readyState:number,once:(event:"close",listener:()=>void)=>unknown,removeListener:(event:"close",listener:()=>void)=>unknown}} socket @returns {Promise<DeviceGrant>} */
  claim(peer, hello, socket) {
    const invite = this.invite;
    if (!invite) throw pairingError("PAIRING_USED", "邀请已使用或取消");
    if (invite.expiresAt <= Date.now()) throw pairingError("PAIRING_EXPIRED", "邀请已过期");
    if (
      typeof hello.inviteSecret !== "string" ||
      !/^[a-f0-9]{64}$/.test(hello.inviteSecret) ||
      !timingSafeEqual(Buffer.from(hello.inviteSecret), Buffer.from(invite.secret))
    )
      throw pairingError("FORBIDDEN", "邀请无效");
    // 消费与登记之间没有 await，两台设备不能同时取得同一邀请。
    this.invite = null;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(entry.timer);
        socket.removeListener("close", closed);
        if (this.pending.get(peer) === entry) this.pending.delete(peer);
        this.service.schedule();
      };
      const closed = () => {
        if (!entry.approving) entry.reject(pairingError("PAIRING_CANCELLED", "配对连接已断开"));
      };
      /** @type {PendingPair} */
      const entry = {
        name: hello.displayName.slice(0, 80),
        ...(hello.clientKind ? { clientKind: hello.clientKind } : {}),
        expiresAt: invite.expiresAt,
        connected: () => socket.readyState === 1,
        accept: (grant) => {
          cleanup();
          resolve(grant);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        arm: () => {
          entry.timer = setTimeout(
            () => entry.reject(pairingError("PAIRING_EXPIRED", "邀请已过期")),
            Math.max(1, invite.expiresAt - Date.now()),
          );
          entry.timer.unref?.();
        },
      };
      this.pending.set(peer, entry);
      entry.arm();
      socket.once("close", closed);
      this.service.schedule();
    });
  }
  connect() {
    if (!this.config.enabled || this.closed || this.config.relayProtocol !== "areal.remote.v2")
      return;
    try {
      validateHttpsOrigin(this.config.relay);
    } catch {
      this.relayError = "Relay 来源无效，请重新登记";
      return;
    }
    this.relayTransport?.close();
    this.relayTransport = new RelayTransport(this);
  }
  publish() {
    this.push.start();
  }
  clearChannels() {
    for (const endpoint of Array.from(this.channels.values())) endpoint.terminate();
  }
  disconnect() {
    clearTimeout(this.retry);
    const transport = this.relayTransport;
    this.relayTransport = null;
    this.connected = false;
    transport?.close();
  }
  async startDirect() {
    if (this.direct) return { origin: this.direct.origin, ws: this.direct.ws };
    this.direct = await startDirect(this);
    return { origin: this.direct.origin, ws: this.direct.ws };
  }
  // 进程退出同步关闭入口并保留映射；下次启动先复核所有权，绝不异步遗弃 CLI 清理。
  close() {
    this.changeNetworkOrigin(null);
    this.cancelPair();
    this.closed = true;
    this.disconnect();
    this.sessions.close();
    this.push.close();
    this.direct?.close();
    this.direct = null;
  }
}
/** @typedef {Record<string,unknown>} RemoteSettingsFields */
/** @typedef {import('@areal/workbench/desktop-contract/desktop-control').RemoteRequest} RemoteSettingsRequest */
module.exports = { RemoteControl };
