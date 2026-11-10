// @ts-check
"use strict";
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const diagnostics = require("./diagnostics.cjs");
const {
  record,
  strings,
  modelConfig,
  parameters,
  modelSnapshot,
} = require("./provider-contract.cjs");

/** @param {string} value */
const protocolToCore = (value) => (value === "chatCompletions" ? "chat-completions" : value);
/** @param {string} endpoint */
const baseUrl = (endpoint) => endpoint.replace(/\/(chat\/completions|responses)\/?$/, "");
/** @param {unknown} value */
function credentialValue(value, { privateKey = false } = {}) {
  if (
    typeof value !== "string" ||
    value.length > (privateKey ? 32768 : 16384) ||
    value.includes("\0") ||
    (!privateKey && /[^\x20-\x7e]/.test(value))
  )
    throw new Error("凭据格式无效");
  return value.trim();
}

class ModelConfiguration {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {InstanceType<typeof import('./host-vault.cjs').HostVault>} hostVault */
  constructor(backend, hostVault) {
    this.backend = backend;
    this.hostVault = hostVault;
    /** @type {{keys:Record<string,string>,migrated:string[],locked:Set<string>,pending:Set<string>}} */
    this.vault = { keys: {}, migrated: [], locked: new Set(), pending: new Set() };
    /** @type {Set<string>} */ this.references = new Set();
    /** @type {{data:Array<{id:string,name:string,baseUrl:string,protocol:string,enabled:boolean,models:import('./provider-contract.cjs').ModelConfig[],parameters:import('./provider-contract.cjs').ModelParameters,apiKeyEnv?:string}>,retired?:string[]}|undefined} */
    this.legacy = undefined;
    /** @type {import('./provider-contract.cjs').ModelSnapshot|undefined} */
    this.value = undefined;
    /** @type {Promise<import('./provider-contract.cjs').ModelSnapshot>|null} */
    this.reading = null;
  }
  async init() {
    const metadata = this.backend.host.state.credentials;
    if (!metadata || !strings(metadata.references) || !strings(metadata.migratedConfigPaths))
      throw new Error("Host 凭据来源元数据无效");
    this.vault.migrated = [...metadata.migratedConfigPaths];
    if (metadata.legacyProviders) this.legacy = legacyProviders(metadata.legacyProviders);
    try {
      const paths = JSON.parse(
        await readFile(join(this.backend.home, "model-config-migrations.json"), "utf8"),
      );
      if (!strings(paths)) throw new Error("模型配置迁移记录无效");
      this.vault.migrated = [...new Set([...this.vault.migrated, ...paths])];
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await this.refreshCredentials(metadata.references);
  }
  /** @param {string[]} [references] */
  async refreshCredentials(references) {
    const vault = this.hostVault;
    const source = this.backend.host;
    if (!references) {
      const state = await source.client.sourceState(source.source);
      if (!state || state.sourceId !== source.sourceId) throw new Error("Host 凭据来源已变化");
      source.state = state;
      references = state.credentials.references;
    }
    const names = references ?? source.state.credentials.references;
    if (!strings(names)) throw new Error("Host 凭据来源元数据无效");
    const locked = new Set();
    const pending = new Set();
    const keys = Object.fromEntries(
      await Promise.all(
        names.map(async (reference) => {
          let current;
          try {
            current = await vault.read(
              { kind: "providerCredential", sourceId: source.sourceId, reference },
              { interactionAllowed: false },
            );
          } catch (error) {
            const code = record(error) ? error.code : undefined;
            if (code !== "storageLocked" && code !== "storageMissing" && code !== "migrationPending") throw error;
            if (code === "storageLocked") locked.add(reference);
            if (code === "migrationPending") pending.add(reference);
            diagnostics.record({
              type: "operation",
              name: "model-configuration",
              outcome: "failed",
              code,
            });
            return [reference, null];
          }
          if (current.value !== null && typeof current.value !== "string")
            throw new Error("Host 供应商凭据记录无效");
          return [reference, current.value];
        }),
      ),
    );
    this.vault.locked = locked;
    this.vault.pending = pending;
    this.references = new Set(names);
    this.vault.keys = Object.fromEntries(
      Object.entries(keys).filter(([, value]) => value !== null),
    );
  }

  /** @param {'read'|'write'} operation @param {import('./provider-contract.cjs').ModelUpdate} [request] */
  async execute(operation, request) {
    await this.refreshCredentials();
    let value;
    try {
      if (!this.backend.hostCall) throw new Error("Host 模型配置能力不可用");
      value = await this.backend.hostCall("workbench.utility", {
        operation: operation === "read" ? "modelsRead" : "modelsWrite",
        ...(request ? { document: JSON.stringify(request) } : {}),
      });
    } catch (error) {
      const failure = record(error) ? error : {};
      const timedOut = failure.timedOut === true;
      console.error(
        JSON.stringify({
          event: "core-model-configuration-failed",
          operation,
          exitCode: typeof failure.code === "number" ? failure.code : null,
          code: typeof failure.code === "string" ? failure.code : null,
          signal: failure.signal ?? null,
          killed: failure.killed === true,
          timedOut,
        }),
      );
      const detail = timedOut
        ? "Core 模型配置请求超时，请检查后台服务日志。"
        : failure.signal
          ? "Core 模型配置进程意外终止，请检查后台服务日志。"
          : `Core 模型配置失败：${this.backend.providers.redact(typeof failure.stderr === "string" ? failure.stderr : failure.message).slice(0, 2048)}。`;
      throw new Error(`${detail}配置若已变化，请刷新核对后再操作。`);
    }
    try {
      return modelSnapshot(value);
    } catch {
      throw new Error("Core 返回了无效的模型配置");
    }
  }
  /** @returns {Promise<import('./provider-contract.cjs').ModelSnapshot>} */
  current() {
    // 设置页与多个项目启动可同时读取，首次迁移只允许一个写入者。
    if (!this.reading)
      this.reading = this.read().finally(() => {
        this.reading = null;
      });
    return this.reading;
  }
  /** @returns {Promise<import('./provider-contract.cjs').ModelSnapshot>} */
  async read() {
    const previous = this.value;
    let current = await this.execute("read");
    if (this.legacy && !this.vault.migrated.includes(current.path)) {
      const imported = this.legacy.data.map(
        ({ id, name, baseUrl: url, protocol, enabled, models, parameters, apiKeyEnv }) => ({
          id,
          name,
          endpoint: url + (protocol === "responses" ? "/responses" : "/chat/completions"),
          protocol: protocolToCore(protocol),
          enabled,
          models,
          parameters,
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
        }),
      );
      for (const item of imported) {
        const existing = current.data.find((p) => p.id === item.id);
        if (existing && !isDeepStrictEqual(existing, item))
          throw new Error(
            `旧供应商与 Core 配置存在同 ID 冲突：${item.id}。请先调整文件中的 ID，再刷新。`,
          );
      }
      current = await this.execute("write", {
        expectedRevision: current.revision,
        data: [
          ...current.data,
          ...imported.filter((item) => !current.data.some((p) => p.id === item.id)),
        ],
        defaultModel: current.defaultModel,
      });
      this.vault.migrated.push(current.path);
      await this.backend.save("model-config-migrations.json", this.vault.migrated);
    }
    if (this.value === previous) this.value = current;
    return this.value ?? current;
  }
  /** @param {unknown} value */
  async credential(value, { privateKey = false } = {}) {
    const secret = credentialValue(value, { privateKey });
    if (!secret) return undefined;
    const reference = `AREAL_CREDENTIAL_${randomUUID().replaceAll("-", "")}`;
    await this.hostVault.replace(
      {
        kind: "providerCredential",
        sourceId: this.backend.host.sourceId,
        reference,
      },
      0,
      secret,
    );
    this.references.add(reference);
    this.vault.keys[reference] = secret;
    return reference;
  }
  /** @param {{apiKeyEnv?:string}} item */
  key(item) {
    if (!item?.apiKeyEnv) return "";
    if (Object.hasOwn(this.vault.keys, item.apiKeyEnv)) return this.vault.keys[item.apiKeyEnv];
    return this.references.has(item.apiKeyEnv) ? "" : (process.env[item.apiKeyEnv] ?? "");
  }

  /** @param {import('./provider-contract.cjs').ModelSnapshot} snapshot */
  credentialsFor(snapshot) {
    const references = new Set(
      snapshot.data
        .map((item) => item.apiKeyEnv)
        .filter(
          (reference) =>
            typeof reference === "string" &&
            reference.startsWith("AREAL_CREDENTIAL_") &&
            Object.hasOwn(this.vault.keys, reference),
        ),
    );
    return Object.fromEntries(
      [...references].map((reference) => [reference, this.key({ apiKeyEnv: reference })]),
    );
  }
  environment() {
    // 已冻结的任务与队列配置仍可能引用停用的凭据。
    return Object.fromEntries(
      Object.keys(this.vault.keys).map((reference) => [
        reference,
        this.key({ apiKeyEnv: reference }),
      ]),
    );
  }
  public() {
    const value = this.value;
    if (!value) throw new Error("模型配置尚未读取");
    return {
      ...value,
      credentialErrors: Object.fromEntries(
        value.data
          .filter((item) => item.apiKeyEnv && (this.vault.locked.has(item.apiKeyEnv) || this.vault.pending.has(item.apiKeyEnv)))
          .map((item) => [item.id, this.vault.pending.has(item.apiKeyEnv ?? "") ? "migrationPending" : "storageLocked"]),
      ),
      data: value.data.map((item) => ({
        ...item,
        protocol: item.protocol === "chat-completions" ? "chatCompletions" : item.protocol,
        baseUrl: baseUrl(item.endpoint),
      })),
      projects: [...this.backend.projects.values()]
        .filter((project) => this.backend.providers.manages(project))
        .map((project) => ({
          projectId: project.id,
          root: project.root,
          connected: !!project.client?.ready,
          applied:
            !!project.client?.ready &&
            !project.providerError &&
            !this.backend.providers?.pendingApplications?.has(project.id) &&
            project.providerRevision === value.revision,
          error: project.providerError ?? null,
        })),
      pendingApply: [...this.backend.projects.values()]
        .filter((project) => this.backend.providers.manages(project))
        .some(
          (project) =>
            project.service &&
            (project.providerRevision !== value.revision ||
              project.providerError ||
              this.backend.providers?.pendingApplications?.has(project.id)),
        ),
    };
  }
}
module.exports = { ModelConfiguration, protocolToCore, baseUrl, credentialValue };

/** @param {unknown} value @returns {NonNullable<ModelConfiguration['legacy']>} */
function legacyProviders(value) {
  if (
    !record(value) ||
    !Array.isArray(value.data) ||
    (value.retired !== undefined && !strings(value.retired))
  )
    throw new Error("旧供应商配置无效");
  const data = value.data.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.baseUrl !== "string" ||
      typeof item.protocol !== "string" ||
      typeof item.enabled !== "boolean" ||
      !Array.isArray(item.models) ||
      !item.models.every(modelConfig) ||
      !parameters(item.parameters) ||
      (item.apiKeyEnv !== undefined && item.apiKeyEnv !== `AREAL_CREDENTIAL_${item.id}`)
    )
      throw new Error("旧供应商配置无效");
    return {
      id: item.id,
      name: item.name,
      baseUrl: item.baseUrl,
      protocol: item.protocol,
      enabled: item.enabled,
      models: item.models,
      parameters: item.parameters,
      ...(item.apiKeyEnv ? { apiKeyEnv: item.apiKeyEnv } : {}),
    };
  });
  return { data, ...(value.retired === undefined ? {} : { retired: value.retired }) };
}
