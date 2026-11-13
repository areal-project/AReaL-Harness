// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const { readFile, realpath } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const QRCode = require("qrcode");
const { HostRemote } = require("./host-remote.cjs");
const { migrateLegacyDevices } = require("./remote-config.cjs");
const {
  isRemoteRequest,
  isRemoteStatus,
} = require("@areal/workbench/desktop-contract/desktop-control");
/** @type {typeof import('@areal/workbench/desktop-contract/desktop-control').validateResponse} */
const validateResponse =
  require("@areal/workbench/desktop-contract/desktop-control").validateResponse;

/** @typedef {{requestId:string,sourceId:string,hostId:string,generation:string,method:'remote.gateway.handoff'|'remote.gateway.control',expectedRevision:number,controlDigest?:string}} Reference */
const notAdmitted = new Set([
  "unsupportedCapability",
  "invalidRequest",
  "generationMismatch",
  "revisionConflict",
  "sourceNotFound",
  "remoteBusy",
  "invalid-origin",
  "invalid-code",
  "enrollment-required",
]);
class NativeRemote {
  /** @param {{backend:InstanceType<typeof import('./backend.cjs').CoreBackend>,schedule:()=>void}} service */
  constructor(service) {
    this.service = service;
    this.backend = service.backend;
    this.storage = new HostRemote(
      this.backend,
      () => {
        this.closed = true;
      },
      { native: true },
    );
    /** @type {import('./remote-config.cjs').RemoteConfig} */
    this.config = { enabled: false, directEnabled: false };
    this.channels = new Map();
    this.closed = false;
    this.assetRoot = "";
    /** @type {Reference|null} */ this.pending = null;
    /** @type {Promise<unknown>|undefined} */ this.writes = undefined;
    /** @type {import('@areal/workbench/desktop-contract/desktop-control').RemoteStatus} */
    this.view = {
      enabled: false,
      connected: false,
      relay: "",
      relayError: "",
      relayUrl: "",
      directEnabled: false,
      directUrl: "",
      directHostId: "",
      directError: "",
      migrationError: "",
      devices: [],
      deviceGrants: [],
      pending: [],
      network: {
        kind: null,
        scope: null,
        reconciliation: null,
        publicOrigin: "",
        diagnostic: "",
        policy: "unknown",
        phoneAccess: "unknown",
        inspection: null,
      },
    };
  }
  async init() {
    this.assetRoot = await realpath(
      process.defaultApp || !process.resourcesPath
        ? resolve(__dirname, "../../../../../clients/gui/renderer/dist")
        : join(process.resourcesPath, "areal-gui"),
    );
    try {
      this.config = await this.storage.init();
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "migrationPending"))
        throw error;
      this.view.migrationError = "手机连接身份尚未恢复，请在凭据可用后重新打开应用。";
      this.view.directError = this.view.migrationError;
      this.view.relayError = this.view.migrationError;
      await this.close();
      return;
    }
    try {
      const saved = JSON.parse(
        await readFile(join(this.backend.home, "host-remote-gateway-operation.json"), "utf8"),
      );
      if (
        saved.version !== 1 ||
        (saved.pending !== null &&
          (!saved.pending ||
            typeof saved.pending.requestId !== "string" ||
            saved.pending.sourceId !== this.storage.sourceId ||
            typeof saved.pending.hostId !== "string" ||
            typeof saved.pending.generation !== "string" ||
            !["remote.gateway.handoff", "remote.gateway.control"].includes(saved.pending.method) ||
            !Number.isSafeInteger(saved.pending.expectedRevision) ||
            (saved.pending.method === "remote.gateway.control" &&
              !/^[a-f0-9]{64}$/.test(saved.pending.controlDigest))))
      )
        throw new Error("Host Remote Gateway 操作记录无效");
      this.pending = saved.pending;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await this.settle();
    if (!this.storage.nativeOwned) {
      const migrated =
        this.config.schemaVersion !== 2 && this.config.devices?.length
          ? migrateLegacyDevices(this.config)
          : this.config;
      const config =
        migrated.enabled && migrated.relayProtocol !== "areal.remote.v2"
          ? { ...migrated, enabled: false }
          : migrated;
      if (!config.identity) {
        const { createIdentity } = await import("@areal/remote");
        this.config = await this.storage.replace({
          ...config,
          identity: await createIdentity(),
          schemaVersion: 2,
        });
      } else if (config !== this.config) {
        this.config = await this.storage.replace(config);
      }
    }
    if (this.config.identity && !this.storage.nativeOwned)
      await this.submit("remote.gateway.handoff", {});
    await this.storage.client.subscribeGateway(this.storage.sourceId, (state) =>
      this.accept(state),
    );
  }
  persist() {
    return this.backend.save("host-remote-gateway-operation.json", {
      version: 1,
      pending: this.pending,
    });
  }
  async settle() {
    if (!this.pending) return;
    const reference = this.pending;
    const { operation } = await this.storage.client.operation(reference.requestId);
    const valid =
      operation &&
      operation.requestId === reference.requestId &&
      operation.sourceId === reference.sourceId &&
      (reference.method === "remote.gateway.handoff"
        ? operation.method === reference.method &&
          operation.hostId === reference.hostId &&
          operation.generation === reference.generation &&
          operation.revision === reference.expectedRevision
        : operation.controlDigest === reference.controlDigest &&
          (operation.method === "remote.replace" ||
            (operation.method === "remote.gateway.control" &&
              operation.ephemeral === true &&
              operation.hostId === reference.hostId &&
              operation.generation === reference.generation)));
    if (!valid || !["completed", "blocked"].includes(operation.state))
      throw Object.assign(new Error("原远程设置请求仍待确认，请检查原请求"), {
        requestId: reference.requestId,
      });
    this.pending = null;
    await this.persist();
    if (operation.state === "blocked") throw new Error("原远程设置请求未完成，请检查后台状态");
  }
  /** @param {'remote.gateway.handoff'|'remote.gateway.control'} method @param {{request?:import('@areal/workbench/desktop-contract/desktop-control').RemoteRequest}} params */
  async submit(method, params) {
    await this.settle();
    const requestId = randomUUID();
    const reference = {
      requestId,
      sourceId: this.storage.sourceId,
      hostId: this.storage.client.hostId,
      generation: this.storage.client.generation,
      method,
      expectedRevision: this.storage.revision,
      ...(method === "remote.gateway.control"
        ? {
            controlDigest: this.storage.client.intentDigest(
              method,
              this.storage.sourceId,
              requestId,
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(params.request ?? {}).sort(([a], [b]) =>
                    a < b ? -1 : a > b ? 1 : 0,
                  ),
                ),
              ),
            ),
          }
        : {}),
    };
    this.pending = reference;
    await this.persist();
    let result;
    try {
      result = await this.storage.client.request(method, {
        requestId: reference.requestId,
        expectedGeneration: reference.generation,
        sourceId: reference.sourceId,
        assetRoot: this.assetRoot,
        ...(method === "remote.gateway.handoff"
          ? { expectedRevision: reference.expectedRevision }
          : {}),
        ...params,
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && notAdmitted.has(String(error.code))) {
        this.pending = null;
        await this.persist();
      } else if (error instanceof Error && "code" in error && error.code === "enrollment-failed") {
        try {
          await this.settle();
        } catch (lookupError) {
          if (this.pending)
            throw new AggregateError([error, lookupError], "原远程注册请求结果待核查");
        }
      }
      throw error;
    }
    if (
      method === "remote.gateway.handoff" &&
      (result.requestId !== reference.requestId ||
        result.sourceId !== reference.sourceId ||
        result.hostId !== reference.hostId ||
        result.generation !== reference.generation ||
        result.revision !== reference.expectedRevision ||
        result.state !== "completed")
    )
      throw new Error("Host Remote Gateway 交接回执与原操作身份不一致");
    this.pending = null;
    await this.persist();
    this.config = await this.storage.refresh();
    return result;
  }
  async refresh() {
    const value = await this.storage.client.request("remote.gateway.state", {
      sourceId: this.storage.sourceId,
    });
    return this.accept(value);
  }
  /** @param {unknown} value */
  accept(value) {
    if (!isRemoteStatus(value)) throw new Error("Host Remote Gateway 状态无效");
    if (this.closed) return value;
    this.view = value;
    this.service.schedule();
    return value;
  }
  state() {
    return this.view;
  }
  get directError() {
    return this.view.directError;
  }
  get relayError() {
    return this.view.relayError;
  }
  storageAvailable() {
    return this.storage.available();
  }
  /** @param {unknown} request */
  control(request) {
    if (!isRemoteRequest(request)) throw new Error("无效手机设置参数");
    if (this.closed && request.operation === "status" && this.view.migrationError)
      return Promise.resolve(this.view);
    if (this.closed) throw new Error("Host Remote 连接已关闭");
    const task = (this.writes ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await this.settle();
        if (request.operation === "status") return this.refresh();
        const result = await this.submit("remote.gateway.control", { request });
        const value =
          request.operation === "pair"
            ? { ...result, qr: await QRCode.toDataURL(result.payload) }
            : result;
        validateResponse("remoteControl", request, value);
        await this.refresh();
        return value;
      });
    this.writes = task;
    return task;
  }
  publish() {}
  async close() {
    this.closed = true;
    await Promise.allSettled([this.writes]);
    await this.storage.drained();
    this.storage.close();
  }
}
module.exports = { NativeRemote };
