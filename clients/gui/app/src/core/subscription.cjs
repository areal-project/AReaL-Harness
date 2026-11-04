// @ts-check
"use strict";
const providerContract = require("./provider-contract.cjs");
const { validContextWindow } = providerContract;
const { appendFile } = require("node:fs/promises");
const { join } = require("node:path");

// 凭据存储与 OAuth 使用同一串行读写契约。
class SubscriptionStore {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {InstanceType<typeof import('./host-vault.cjs').HostVault>} vault */
  constructor(backend, vault) {
    this.vault = vault;
    /** @type {import('@areal/client/node').VaultSlot} */
    this.slot = {
      kind: "subscriptionAccount",
      sourceId: backend.host.sourceId,
      providerId: "openai",
    };
    /** @type {Promise<unknown>} */
    this.chain = Promise.resolve();
  }
  async check() {
    await this.vault.ready(this.slot);
    await this.readRecord();
  }
  async readRecord() {
    const current = await this.vault.read(this.slot);
    return current.value ?? undefined;
  }
  /** @param {unknown} _key @param {(current:unknown)=>unknown|Promise<unknown>} mutate */
  modifyRecord(_key, mutate) {
    const result = this.chain.then(async () => {
      await this.vault.ready(this.slot);
      const current = await this.vault.read(this.slot);
      const next = await mutate(current.value ?? undefined);
      if (next === undefined) return current.value ?? undefined;
      return (await this.vault.replace(this.slot, current.revision, next)).value;
    });
    this.chain = result.catch(() => {});
    return result;
  }
  deleteRecord() {
    const result = this.chain.then(async () => {
      await this.vault.ready(this.slot);
      const current = await this.vault.read(this.slot);
      await this.vault.replace(this.slot, current.revision, null);
    });
    this.chain = result.catch(() => {});
    return result;
  }
}
/** @param {unknown} value */
function transportRecord(value) {
  if (
    !providerContract.record(value) ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 0 ||
    value.port > 65535
  )
    throw new Error("本地订阅传输配置无效");
  return { token: value.token, port: value.port };
}

/** @param {import('@areal/workbench/desktop-contract/provider').SubscriptionModel[]} models */
function publicSubscriptionModels(models) {
  return models.map((model) => ({
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    ...(model.source ? { source: model.source } : {}),
    ...(model.reasoningEffortOptions
      ? { reasoningEffortOptions: model.reasoningEffortOptions }
      : {}),
    ...(validContextWindow(model.parameters?.contextWindowTokens)
      ? { parameters: { contextWindowTokens: model.parameters.contextWindowTokens } }
      : {}),
  }));
}

/** @param {string} home @returns {(audit:import('@areal/chatgpt-provider/core').RequestAudit)=>Promise<void>} */
function requestAudit(home) {
  return async ({
    providerId,
    protocol,
    model,
    startedAt,
    completedAt,
    upstreamHttpStatus,
    upstreamContentType,
    localHttpStatus,
    outcome,
    failureKind,
    streamFailureReason,
    code,
    state,
    phase,
    httpStatus,
    requestId,
    adjustments,
    sessionIdentitySent,
    turnStateSent,
    turnStateReceived,
  }) => {
    await appendFile(
      join(home, "provider-requests.jsonl"),
      JSON.stringify({
        providerId,
        protocol,
        model,
        startedAt,
        completedAt,
        upstreamHttpStatus,
        upstreamContentType,
        localHttpStatus,
        outcome,
        failureKind,
        streamFailureReason,
        code,
        state,
        phase,
        httpStatus,
        requestId,
        adjustments,
        sessionIdentitySent,
        turnStateSent,
        turnStateReceived,
      }) + "\n",
      { mode: 0o600 },
    );
  };
}

/** @param {import('@areal/workbench/desktop-contract/provider').SubscriptionModel[]} models */
function subscriptionContexts(models) {
  return Object.fromEntries(
    models.flatMap((m) =>
      validContextWindow(m.parameters?.contextWindowTokens)
        ? [[m.id, { contextWindowTokens: m.parameters.contextWindowTokens }]]
        : [],
    ),
  );
}

module.exports = {
  subscriptionContexts,
  requestAudit,
  transportRecord,
  publicSubscriptionModels,
  SubscriptionStore,
};
