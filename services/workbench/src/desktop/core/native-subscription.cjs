// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const contract = require("@areal/workbench/desktop-contract/provider");

/** @param {NodeJS.ProcessEnv} environment */
async function networkInput(environment) {
  const keys = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "ALL_PROXY",
    "all_proxy",
    "NO_PROXY",
    "no_proxy",
    "AREAL_CHATGPT_SYSTEM_PROXY",
  ];
  const proxies = Object.fromEntries(
    keys.filter((key) => environment[key]).map((key) => [key, environment[key]]),
  );
  const files = [
    ...new Set(
      [environment.SSL_CERT_FILE, environment.NODE_EXTRA_CA_CERTS].filter(
        (path) => typeof path === "string" && !!path,
      ),
    ),
  ];
  return {
    proxies,
    proxyUnavailable: !!environment.AREAL_CHATGPT_PROXY_ERROR,
    extraCaPem: await Promise.all(
      files.map((path) => readFile(/** @type {string} */ (path), "utf8")),
    ),
  };
}

class NativeAccount {
  /** @param {NativeSubscription} owner */
  constructor(owner) {
    this.owner = owner;
    this.revision = 0;
    this.lifetime = new AbortController();
    /** @type {null|{state:string,phase:string,diagnostic:()=>import("@areal/workbench/desktop-contract/provider").Diagnostic}} */ this.failure =
      null;
    this.refreshing = false;
    /** @type {import("@areal/workbench/desktop-contract/provider").Login|null} */ this.login =
      null;
    /** @type {string|null} */ this.error = null;
  }
  /** @template T @param {Promise<T>} work */
  track(work) {
    return work;
  }
  async status() {
    return this.owner.refresh();
  }
  async read() {
    const status = await this.owner.read();
    return status.authenticated
      ? { type: "chatgpt", email: status.email, planType: status.planType }
      : null;
  }
}

class NativeSubscription {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend */
  constructor(backend) {
    this.backend = backend;
    this.id = "areal_openai";
    this.account = new NativeAccount(this);
    this.openaiAccount = this.account;
    this.endpoint = "";
    /** @type {import('@areal/workbench/desktop-contract/provider').SubscriptionModel[]} */ this.models =
      [];
    /** @type {any} */ this.latest = null;
    /** @type {{requestId:string,method:string}[]} */ this.pending = [];
    this.outcomeUnknown = false;
    /** @type {Promise<unknown>} */ this.writes = Promise.resolve();
    /** @type {Promise<import('@areal/workbench/desktop-contract/provider').ChatGPTStatus>|undefined} */ this.refreshing =
      undefined;
    this.closed = new AbortController();
    this.catalog = {
      metadata: () =>
        this.latest?.catalog ?? { fresh: false, sessionRevision: this.account.revision },
    };
  }
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {InstanceType<typeof import('./host-vault.cjs').HostVault>} vault */
  static async connect(backend, vault) {
    if (backend.host.retirement && backend.host.retirement.state !== "completed")
      throw Object.assign(
        new Error(backend.host.retirement.error ?? "旧凭据清理尚未确认，ChatGPT 订阅暂不可用。"),
        { code: "legacyPending", requestId: backend.host.retirement.requestId },
      );
    backend.host.client.requireCapability("subscriptionOwnerV1");
    const service = new NativeSubscription(backend);
    try {
      const saved = JSON.parse(
        await readFile(join(backend.home, "subscription-operations.json"), "utf8"),
      );
      if (
        saved.version !== 1 ||
        !Array.isArray(saved.pending) ||
        !saved.pending.every(
          (/** @type {any} */ item) =>
            typeof item.requestId === "string" && typeof item.method === "string",
        )
      )
        throw new Error("订阅操作记录无效");
      service.pending = saved.pending;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await service.settle();
    const sourceId = backend.host.sourceId;
    let state = await backend.host.client.request("subscription.read", { sourceId });
    if (service.outcomeUnknown) {
      service.accept(state);
      return service;
    }
    const network = await networkInput(backend.hooks.environment());
    if (state.owner !== "nativeV1") {
      // 原 Vault 回执必须先结算；Host 还会核对旧版本和真实端口释放。
      await vault.ready({ kind: "subscriptionAccount", sourceId, providerId: "openai" });
      await vault.ready({ kind: "subscriptionTransport", sourceId });
      state = await backend.host.client.request("subscription.read", { sourceId });
      await service.submit("subscription.handoff", {
        sourceId,
        migrationId: backend.host.migrationId,
        expectedAccountRevision: state.accountRevision,
        expectedTransportRevision: state.transportRevision,
        network,
      });
    } else {
      service.accept(state);
      await service.action({
        kind: "configureNetwork",
        network,
        expectedTransportRevision: state.transportRevision,
      });
    }
    await service.read();
    return service;
  }
  save() {
    const write = this.writes.then(() =>
      this.backend.save("subscription-operations.json", { version: 1, pending: this.pending }),
    );
    this.writes = write.catch(() => {});
    return write;
  }
  async settle() {
    let outcomeUnknown = false;
    for (const item of this.pending) {
      const result = await this.backend.host.client.operation(item.requestId);
      const receipt = result?.operation;
      if (!receipt) {
        outcomeUnknown = true;
        continue;
      }
      if (receipt.requestId !== item.requestId)
        throw new Error("原订阅操作结果尚未确认，请恢复 Host 连接后重试");
      if (
        (receipt.state === "blocked" && receipt.error?.code === "outcomeUnknown") ||
        (receipt.state === "acceptedPending" && item.method === "subscription.handoff")
      ) {
        outcomeUnknown = true;
        continue;
      }
      if (receipt.state === "acceptedPending" && item.method === "subscription.command") continue;
      if (!["completed", "blocked"].includes(receipt.state))
        throw new Error("原订阅交接尚未确认，请恢复 Host 连接后重试");
      this.pending = this.pending.filter((entry) => entry.requestId !== item.requestId);
      await this.save();
    }
    this.outcomeUnknown = outcomeUnknown;
  }
  /** @param {string} method @param {Record<string,unknown>} parameters */
  async submit(method, parameters) {
    const requestId = randomUUID();
    const item = { requestId, method };
    this.pending.push(item);
    await this.save();
    let receipt;
    try {
      receipt = await this.backend.host.client.request(method, {
        ...parameters,
        requestId,
        expectedGeneration:
          typeof parameters.expectedGeneration === "string"
            ? parameters.expectedGeneration
            : this.backend.host.client.generation,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        [
          "generationMismatch",
          "accountChanged",
          "invalidRequest",
          "requestConflict",
          "subscriptionOwnerRequired",
          "sourceNotFound",
          "legacyPending",
        ].includes(String(error.code))
      ) {
        this.pending = this.pending.filter((entry) => entry.requestId !== requestId);
        await this.save();
        throw error;
      }
      const original = await this.backend.host.client.operation(requestId).catch(() => null);
      if (!original?.operation) throw error;
      receipt = original.operation;
    }
    for (let attempt = 0; receipt.state === "acceptedPending" && attempt < 1200; attempt++) {
      if (
        method === "subscription.command" &&
        parameters.action &&
        /** @type {any} */ (parameters.action).kind === "begin"
      ) {
        const state = await this.backend.host.client.request("subscription.read", {
          sourceId: this.backend.host.sourceId,
        });
        this.accept(state);
        if (state.login?.authUrl) return state.login;
      }
      await delay(100, undefined, { signal: this.closed.signal });
      receipt = (await this.backend.host.client.operation(requestId))?.operation;
      if (!receipt) throw new Error("原订阅操作结果尚未确认");
    }
    if (!["completed", "blocked"].includes(receipt.state))
      throw new Error("订阅操作仍在 Host 后台执行");
    if (receipt.state === "blocked" && receipt.error?.code === "outcomeUnknown") {
      this.outcomeUnknown = true;
      throw new Error(
        "Host 已重启，原订阅操作的效果尚未确认。请检查当前账号状态，不要重复原操作。",
      );
    }
    this.pending = this.pending.filter((entry) => entry.requestId !== requestId);
    await this.save();
    if (receipt.state === "blocked") throw new Error(receipt.error?.message ?? "订阅操作未完成");
    return receipt.result;
  }
  /** @param {Record<string,unknown>} action */
  action(action) {
    if (this.outcomeUnknown)
      return Promise.reject(
        new Error("原订阅操作的效果尚未确认，请先检查当前账号状态，不要重复操作。"),
      );
    return this.submit("subscription.command", {
      sourceId: this.backend.host.sourceId,
      expectedGeneration: this.latest?.generation,
      expectedAccountEpoch: this.account.revision,
      action,
    });
  }
  /** @param {any} state */
  accept(state) {
    if (
      !(state.owner === "nativeV1" || (state.owner === "legacy" && this.outcomeUnknown)) ||
      !Number.isSafeInteger(state.accountEpoch)
    )
      throw new Error("Host 订阅来源不可用");
    const status = contract.accountStatus(state);
    if (
      this.latest &&
      (state.accountEpoch !== this.account.revision || state.generation !== this.latest.generation)
    ) {
      this.account.lifetime.abort();
      this.account.lifetime = new AbortController();
    }
    this.latest = state;
    this.account.revision = state.accountEpoch;
    this.models = status.models;
    this.endpoint = state.endpoint ?? "";
    this.account.login = status.login;
    this.account.error = this.outcomeUnknown
      ? "Host 已重启，原订阅操作的效果尚未确认。当前账号状态可查看，原操作不会自动重发。"
      : status.error;
    this.account.refreshing = state.refreshing;
    this.account.failure = state.diagnostic
      ? {
          state: state.diagnostic.state,
          phase: state.diagnostic.phase,
          diagnostic: () => state.diagnostic,
        }
      : null;
    return {
      ...status,
      error: this.account.error,
      activeAccountId: state.activeAccountId,
      accounts: state.accounts,
      catalog: state.catalog,
      billing: "subscription",
      availability: state.availability,
      refreshing: state.refreshing,
    };
  }
  async read() {
    const state = await this.backend.host.client.request("subscription.read", {
      sourceId: this.backend.host.sourceId,
    });
    return this.accept(state);
  }
  refresh() {
    if (this.refreshing) return this.refreshing;
    const work = (async () => {
      const recovering = this.pending.length > 0;
      await this.settle();
      const snapshot = await this.read();
      if (recovering || this.outcomeUnknown) return snapshot;
      await this.action({ kind: "refreshCatalog", force: false });
      return this.read();
    })().finally(() => {
      this.refreshing = undefined;
    });
    this.refreshing = work;
    return work;
  }
  async ready() {
    await this.read();
    if (!this.endpoint) throw new Error("Host 订阅传输不可用");
  }
  /** @param {import('./project-state.cjs').CoreProject} project */
  async waitApplied(project) {
    const id = this.backend.host.resolve(project.id).projectId;
    for (let attempt = 0; attempt < 150; attempt++) {
      await this.read();
      const applied = this.latest.applied?.[id];
      if (
        applied?.accountEpoch === this.account.revision &&
        applied.serviceId === project.service?.serviceId &&
        applied.generation === project.service?.generation
      )
        return;
      if (this.latest.state === "signed_out") return;
      await delay(100, undefined, { signal: this.closed.signal });
    }
    throw new Error("Host 正在同步订阅模型，请稍后重试");
  }
  /** @param {any} request */
  async command(request) {
    if (request.operation === "login")
      return this.action({
        kind: "begin",
        target: request.newAccount
          ? { kind: "newAccount" }
          : request.accountId
            ? { kind: "saved", accountId: request.accountId }
            : { kind: "current" },
      });
    const kinds = {
      logout: "logout",
      cancel: "cancel",
      forget: "forget",
      selectAccount: "select",
      probe: "probe",
    };
    const kind = kinds[/** @type {keyof typeof kinds} */ (request.operation)];
    if (!kind) throw new Error("不支持的 ChatGPT 操作");
    return this.action({
      kind,
      ...(kind === "cancel" && this.account.login ? { loginId: this.account.login.loginId } : {}),
      ...(request.accountId ? { accountId: request.accountId } : {}),
      ...(request.model ? { model: request.model } : {}),
    });
  }
  async close() {
    this.closed.abort();
    this.account.lifetime.abort();
    await this.writes;
  }
}
module.exports = { NativeSubscription, networkInput };
