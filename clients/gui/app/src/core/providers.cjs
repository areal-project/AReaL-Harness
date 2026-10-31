// @ts-check
"use strict";
const { catalog, rejectModel, subscriptionAvailable } = require("./provider-model-catalog.cjs");
const { testConnection, errorMessage } = require("./provider-probe.cjs");
const { startupTrace } = require("./startup-timing.cjs");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const {
  SubscriptionStore,
  transportRecord,
  publicSubscriptionModels,
  requestAudit,
  subscriptionContexts,
} = require("./subscription.cjs");
const {
  definitions,
  connectionMetadata,
  withDefaultModelCapabilities,
} = require("@areal/provider-config");
const {
  ModelConfiguration,
  protocolToCore,
  credentialValue,
  baseUrl,
} = require("./model-config.cjs");
const providerContract = require("./provider-contract.cjs");

/** @typedef {import('./provider-contract.cjs').ModelSnapshot} ModelSnapshot */
/** @typedef {import('./provider-contract.cjs').ConfigurationProof} ConfigurationProof */
/** @typedef {import('./project-state.cjs').CoreProject} CoreProject */
/** @typedef {{project:CoreProject,client:import('@areal/runtime-client/core').CoreClient,serviceId?:string,generation?:string,proof?:ConfigurationProof}} ProviderTarget */
/** @typedef {{target:ProviderTarget,connectionGeneration?:number,service:import('@areal/chatgpt-provider/core').CoreSubscription|null,accountRevision?:number,accountLifetime?:AbortController,observeOnly?:boolean}} SubscriptionScope */
/** @typedef {{requestId:string,serviceId?:string,generation?:string,expectedApplied:import('./provider-contract.cjs').AppliedConfiguration,targetRevision:string,snapshot:ModelSnapshot}} PendingApplication */
/** @typedef {{operation:string,id?:string,model?:import('./provider-contract.cjs').ModelRef|string|null,expectedRevision?:string,provider?:unknown,authentication?:unknown,apiKey?:unknown,discoverModels?:boolean,connection?:unknown}} ProviderRequest */
/** @typedef {Awaited<ReturnType<import('@areal/chatgpt-provider/core').CoreSubscription['account']['status']>>} AccountStatus */
/** @typedef {({ok:true,status:AccountStatus}|{ok:false,error:unknown}) & {completedAt:number,failure:import('@areal/chatgpt-provider/core').CoreSubscription['account']['failure'],refreshing:import('@areal/chatgpt-provider/core').CoreSubscription['account']['refreshing']}} StatusOutcome */
/** @typedef {{service:import('@areal/chatgpt-provider/core').CoreSubscription,revision:number,lifetime:AbortController,outcome:Promise<StatusOutcome>}} PreparedStatus */
/** @typedef {{target:ProviderTarget,applied?:boolean,pending?:boolean,error?:unknown}} ApplyOutcome */
/** @typedef {{pending?:boolean,rejected?:boolean,generationChanged?:boolean,error?:unknown}} PendingOutcome */

const { connection, modelParameters, modelCapabilities } = providerContract;

class AppProviders {
  /** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {import('electron').SafeStorage} [encryption] */
  constructor(backend, encryption) {
    this.backend = backend;
    this.encryption = encryption;
    this.config = new ModelConfiguration(backend, encryption);
    this.openaiToken = "";
    /** @type {Map<string,PendingApplication>} */ this.pendingApplications = new Map();
    /** @type {Map<string,Promise<unknown>>} */ this.projectApplications = new Map();
    /** @type {WeakMap<CoreProject,{scope:SubscriptionScope,providerRevision:number}>} */ this.subscriptionApplications =
      new WeakMap();
    /** @type {import('./provider-contract.cjs').AcceptedModel|undefined} */ this.lastAcceptedModel =
      undefined;
    /** @type {{token:string,port:number}|undefined} */ this.transport = undefined;
    /** @type {Promise<import('@areal/chatgpt-provider/core').CoreSubscription>|null} */ this.openaiPromise =
      null;
    /** @type {import('@areal/chatgpt-provider/core').CoreSubscription|undefined} */ this.openaiService =
      undefined;
    /** @type {Promise<ReturnType<typeof import('@areal/chatgpt-provider/network').subscriptionNetwork>>|undefined} */ this.networkPromise =
      undefined;
    /** @type {Promise<unknown>|undefined} */ this.loginAttempt = undefined;
    /** @type {Map<string,Promise<import('./provider-contract.cjs').CoreProvider|null|undefined>>} */ this.subscriptionSync =
      new Map();
    /** @type {import('@areal/workbench/desktop-contract/provider').ChatGPTStatus} */ this.subscription =
      {
        authenticated: false,
        availability: "unavailable",
        refreshing: false,
        state: "signed_out",
        email: null,
        planType: null,
        modelError: null,
        models: [],
        diagnostic: null,
        login: null,
        error: null,
        billing: "subscription",
        catalog: null,
      };
    /** @type {string|null} */ this.subscriptionIdentity = null;
    /** @type {{service:import('@areal/chatgpt-provider/core').CoreSubscription,revision:number,lifetime:AbortController}|undefined} */ this.subscriptionRefreshScope =
      undefined;
    /** @type {Promise<void>|undefined} */ this.subscriptionRefresh = undefined;
    /** @type {WeakMap<CoreProject,{models:import('./provider-contract.cjs').ModelCatalogEntry[],configuration:ModelSnapshot|undefined,subscription:import('@areal/workbench/desktop-contract/provider').ChatGPTStatus,accepted:import('./provider-contract.cjs').AcceptedModel|undefined,configured:string,result:import('./provider-contract.cjs').ModelCatalogEntry[]}>} */ this.catalogs =
      new WeakMap();
    /** @type {PreparedStatus|null} */ this.preparedSubscriptionStatus = null;
    /** @type {NodeJS.Timeout|null} */ this.reconciliationTimer = null;
    /** @type {Promise<void>|null} */ this.reconciliation = null;
    /** @type {Promise<void>|undefined} */ this.modelSelectionUpdate = undefined;
    /** @type {InstanceType<typeof import('./subscription.cjs').SubscriptionStore>|undefined} */ this.openaiStore =
      undefined;
    this.subscriptionInitialized = false;
    this.closed = false;
    this.saving = false;
  }
  async init() {
    await this.config.init();
    try {
      this.lastAcceptedModel = providerContract.acceptedModel(
        JSON.parse(await readFile(join(this.backend.home, "model-selection.json"), "utf8")),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // 与 Core 的本机连接令牌一样，权限为 0600 的能力文件仅由后台读取。
    // 保留端口与令牌，避免后台重启后失效仍在运行的 Core 中冻结的传输配置。
    try {
      this.transport = transportRecord(
        JSON.parse(await readFile(join(this.backend.home, "subscription-transport.json"), "utf8")),
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!this.transport) {
      this.transport = { token: randomBytes(32).toString("hex"), port: 0 };
      await this.backend.save("subscription-transport.json", this.transport);
    }
    this.openaiToken = this.transport.token;
    await this.readSubscription(await this.openai(), true);
  }
  get value() {
    return this.config.value ?? { data: [], defaultModel: null, revision: undefined };
  }
  snapshot() {
    if (!this.config.value) throw new Error("模型配置尚未读取");
    return this.config.value;
  }
  async network() {
    if (!this.networkPromise)
      this.networkPromise = import("@areal/chatgpt-provider/network").then(
        ({ subscriptionNetwork }) => subscriptionNetwork(this.backend.hooks.environment()),
      );
    return this.networkPromise;
  }
  async openai() {
    if (!this.openaiPromise)
      this.openaiPromise = import("@areal/chatgpt-provider/core")
        .then(({ CoreSubscription }) => {
          this.openaiStore = new SubscriptionStore(this.backend, this.encryption);
          const onRequest =
            process.env.AREAL_CORE_PROVIDER_AUDIT === "1"
              ? requestAudit(this.backend.home)
              : undefined;
          const transport = this.transport;
          if (!transport) throw new Error("订阅传输尚未初始化");
          const service = new CoreSubscription({
            store: this.openaiStore,
            fetch: async (...args) => (await this.network()).fetch(...args),
            token: this.openaiToken,
            port: transport.port,
            onListen: async (port) => {
              transport.port = port;
              await this.backend.save("subscription-transport.json", this.transport);
            },
            kind: "openai",
            onRequest,
          });
          service.account.activateAuthorized = async (id, activate) => {
            if (
              this.backend.hasWork() ||
              this.backend.activeCommands ||
              this.backend.providerUpdating ||
              this.backend.resourcesUpdating ||
              this.backend.starting.size
            )
              return false;
            this.backend.providerUpdating = true;
            try {
              for (const project of this.backend.projects.values()) {
                if (project.service && !project.client?.ready) return false;
                if (
                  project.client?.ready &&
                  !(
                    await project.client.request(
                      "areal/server/status",
                      {},
                      { decode: providerContract.serverStatus },
                    )
                  ).restartSafe
                )
                  return false;
              }
              await activate();
              return true;
            } finally {
              this.backend.providerUpdating = false;
            }
          };
          this.openaiService = service;
          return service;
        })
        .catch((error) => {
          this.openaiPromise = null;
          throw error;
        });
    return this.openaiPromise;
  }
  async prepare() {
    const trace = startupTrace("providers.prepare");
    trace.advance("subscription_config");
    try {
      const service = await this.openai();
      if (!this.subscriptionInitialized) await this.readSubscription(service);
      if (!this.subscription.authenticated) {
        trace.finish("skipped");
        return;
      }
      trace.advance("local_ready");
      await service.ready();
      void this.refreshSubscriptionStatus(service, { synchronize: false });
      trace.finish("ok");
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }
  /** @param {import('@areal/chatgpt-provider/core').CoreSubscription} service @param {boolean} [restore] */
  async readSubscription(service, restore = false) {
    this.subscriptionInitialized = true;
    const account = service.openaiAccount;
    const revision = account.revision;
    try {
      const local = await account.read();
      const directory = await account.directory.snapshot();
      const selected = directory.records[directory.activeId]?.record;
      const registration = selected?.payload;
      const identity = local
        ? createHash("sha256")
            .update(
              JSON.stringify([
                directory.activeId,
                registration?.hostId,
                registration?.clientId,
                registration?.accountId,
                registration?.subject,
                registration?.issuer,
              ]),
            )
            .digest("hex")
        : null;
      const publicAccounts = await account.directory.public();
      if (revision !== account.revision || this.closed) return;
      const changed = identity !== this.subscriptionIdentity;
      this.subscriptionIdentity = identity;
      const models = changed ? [] : this.subscription.models;
      this.subscription = {
        ...this.subscription,
        ...publicAccounts,
        authenticated: !!local,
        availability: local ? "checking" : "unavailable",
        refreshing: false,
        state: local
          ? "ready"
          : selected?.payload?.reauthRequired
            ? "reauth_required"
            : "signed_out",
        email: local?.email ?? null,
        planType: local?.planType ?? null,
        models,
        modelError: null,
        diagnostic: null,
        login: account.login,
        error: account.error,
        ...(changed ? { catalog: null } : {}),
      };
      if (restore && identity) {
        try {
          const saved = JSON.parse(
            await readFile(join(this.backend.home, "subscription-catalog.json"), "utf8"),
          );
          if (saved.version === 1 && saved.identity === identity) {
            const cached = publicSubscriptionModels(
              providerContract.subscriptionModels(saved.models),
            );
            this.subscription = { ...this.subscription, models: cached };
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            console.warn("ChatGPT 公开模型缓存无效，将重新刷新。");
        }
      }
      if (changed && !restore)
        await this.backend.save("subscription-catalog.json", { version: 1, identity, models: [] });
    } catch (error) {
      if (revision !== account.revision || this.closed) return;
      this.subscription = {
        ...this.subscription,
        availability: "unavailable",
        refreshing: false,
        state: "storage_locked",
        modelError: null,
        error: this.redact(errorMessage(error)),
      };
    }
  }
  /** @param {import('@areal/chatgpt-provider/core').CoreSubscription} service */
  refreshSubscriptionStatus(service, { synchronize = true, force = false } = {}) {
    if (
      this.subscriptionRefresh &&
      this.subscriptionRefreshScope?.service === service &&
      this.subscriptionRefreshScope.revision === service.account.revision &&
      this.subscriptionRefreshScope.lifetime === service.account.lifetime
    )
      return this.subscriptionRefresh;
    if (force) this.preparedSubscriptionStatus = null;
    const revision = service.account.revision,
      lifetime = service.account.lifetime;
    this.subscriptionRefreshScope = { service, revision, lifetime };
    const current = () =>
      !this.closed &&
      revision === service.account.revision &&
      lifetime === service.account.lifetime &&
      !lifetime.signal.aborted;
    this.subscription = { ...this.subscription, refreshing: true };
    this.backend.onChange();
    const work = (async () => {
      const status = await this.subscriptionStatus(
        service,
        startupTrace("providers.subscription_refresh"),
      );
      if (!status || !current()) return;
      const success = status.authenticated && status.state === "ready" && !status.modelError;
      const authenticated =
        status.state === "storage_locked" ? this.subscription.authenticated : status.authenticated;
      const models = success
        ? publicSubscriptionModels(status.models)
        : authenticated
          ? this.subscription.models
          : [];
      this.subscription = {
        ...this.subscription,
        ...status,
        authenticated,
        models,
        billing: "subscription",
        catalog: service.catalog?.metadata() ?? null,
        availability: success
          ? "available"
          : ["signed_out", "reauth_required", "storage_locked"].includes(status.state)
            ? "unavailable"
            : "checking",
        refreshing: true,
      };
      if (success && this.subscriptionIdentity)
        await this.backend.save("subscription-catalog.json", {
          version: 1,
          identity: this.subscriptionIdentity,
          models,
        });
      this.backend.onChange();
      if (!synchronize) return;
      await Promise.all(
        [...this.backend.projects.values()]
          .filter((project) => project.client?.ready)
          .map(async (project) => {
            const scope = this.subscriptionScope(project, service);
            const provider = await this.syncSubscription(project, service, undefined, scope);
            await this.publishSubscription(scope, provider);
          }),
      );
    })()
      .catch((error) => {
        if (!current()) return;
        this.subscription = {
          ...this.subscription,
          modelError: this.redact(errorMessage(error)),
        };
        this.backend.onChange();
      })
      .finally(() => {
        if (this.subscriptionRefresh !== work) return;
        this.subscriptionRefresh = undefined;
        if (!current()) return;
        this.subscription = { ...this.subscription, refreshing: false };
        this.backend.onChange();
      });
    this.subscriptionRefresh = service.account.track(work);
    return work;
  }
  /** @param {CoreProject} project */
  async ensureSubscription(project) {
    const service = await this.openai();
    const applied = this.subscriptionApplications.get(project);
    if (applied && this.currentSubscription(applied.scope)) return;
    try {
      await service.ready();
      const scope = this.subscriptionScope(project, service);
      const provider = await this.syncSubscription(project, service, undefined, scope);
      await this.publishSubscription(scope, provider);
    } catch (error) {
      throw Object.assign(new Error(this.redact(errorMessage(error))), {
        submissionUnknown: false,
        outcome: { kind: "noMutation" },
      });
    }
  }
  /** @param {import('@areal/chatgpt-provider/core').CoreSubscription} service @returns {PreparedStatus|undefined} */
  prepareSubscriptionStatus(service) {
    const account = service.account,
      revision = account.revision,
      lifetime = account.lifetime;
    if (lifetime.signal.aborted) return;
    const prepared = this.preparedSubscriptionStatus;
    if (
      prepared?.service === service &&
      prepared.revision === revision &&
      prepared.lifetime === lifetime
    )
      return prepared;
    const trace = startupTrace("providers.subscription_prefetch");
    trace.advance("account_status");
    /** @type {Promise<StatusOutcome>} */
    const outcome = Promise.resolve()
      .then(() => account.status())
      .then(
        (status) => {
          trace.finish(
            status.modelError || !["ready", "signed_out"].includes(status.state)
              ? "degraded"
              : "ok",
          );
          return {
            ok: true,
            status,
            completedAt: Date.now(),
            failure: account.failure,
            refreshing: account.refreshing,
          };
        },
        (error) => {
          trace.finish("error", error);
          return {
            ok: false,
            error,
            completedAt: Date.now(),
            failure: account.failure,
            refreshing: account.refreshing,
          };
        },
      );
    return (this.preparedSubscriptionStatus = {
      service,
      revision,
      lifetime,
      outcome: account.track(outcome),
    });
  }
  /** @param {import('@areal/chatgpt-provider/core').CoreSubscription} service @param {ReturnType<typeof startupTrace>} trace */
  async subscriptionStatus(service, trace) {
    const account = service.account,
      revision = account.revision,
      lifetime = account.lifetime;
    const current = () =>
      account.revision === revision && account.lifetime === lifetime && !lifetime.signal.aborted;
    const prepared = this.preparedSubscriptionStatus;
    if (
      prepared?.service === service &&
      prepared.revision === revision &&
      prepared.lifetime === lifetime
    ) {
      const outcome = await prepared.outcome;
      if (!current()) return null;
      const metadata = service.catalog?.metadata();
      const fresh =
        outcome.ok && outcome.status.state === "ready"
          ? metadata?.fresh &&
            metadata.sessionRevision === revision &&
            outcome.status.models === service.models
          : Date.now() - outcome.completedAt < 30_000;
      const coherent =
        !outcome.ok ||
        (!account.refreshing &&
          outcome.status.state !== "refreshing" &&
          isDeepStrictEqual(outcome.status.diagnostic, account.failure?.diagnostic() ?? null));
      if (
        fresh &&
        coherent &&
        outcome.failure === account.failure &&
        outcome.refreshing === account.refreshing
      ) {
        trace.advance("status_reuse");
        if (!outcome.ok) throw outcome.error;
        return outcome.status;
      }
    }
    if (!current()) return null;
    trace.advance("account_status");
    if (this.preparedSubscriptionStatus === prepared) this.preparedSubscriptionStatus = null;
    const replacement = this.prepareSubscriptionStatus(service);
    if (!replacement) return null;
    const outcome = await replacement.outcome;
    if (!current()) return null;
    if (!outcome.ok) throw outcome.error;
    return outcome.status;
  }
  /** @param {unknown} request */
  async chatgpt(request) {
    if (!providerContract.isRequest("chatgpt", request)) throw new Error("ChatGPT 操作参数无效");
    if ((request.provider ?? "openai") !== "openai") throw new Error("不支持的账号类型");
    const op = request.operation;
    if (op === "status") {
      const snapshot = this.subscription;
      void this.openai().then((service) =>
        this.refreshSubscriptionStatus(service, { force: true }),
      );
      return snapshot;
    }
    const service = await this.openai();
    // 首次授权不重启 Core 或替换已有授权；无关任务、终端与待确认资源不阻塞它。
    if (op === "login") {
      /** @type {InstanceType<typeof import('./subscription.cjs').SubscriptionStore>|undefined} */
      const store = this.openaiStore;
      if (!store) throw new Error("订阅凭据尚未初始化");
      store.check();
      if (!request.newAccount && !request.accountId && (await service.account.read()))
        throw new Error("请先退出当前 ChatGPT 账号");
      if (
        (request.newAccount || request.accountId) &&
        (this.backend.hasWork() || this.backend.activeCommands || this.backend.starting.size)
      )
        throw new Error("请等待任务和操作完成后再切换 ChatGPT 账号");
      const login = await service.account.begin({
        newAccount: request.newAccount === true,
        accountId: request.accountId,
      });
      this.subscription = {
        ...this.subscription,
        login: service.account.login,
        error: service.account.error,
      };
      this.backend.onChange();
      const completion = service.account.attempt?.done;
      if (completion && this.loginAttempt !== completion) {
        this.loginAttempt = completion;
        // 授权生命周期长于设置页；停止轮询后仍发布目录，account.close 等待此项工作。
        service.account.track(
          completion
            .then(async () => {
              if (service.account.lifetime.signal.aborted || !(await service.account.read()))
                return;
              await this.readSubscription(service);
              await this.chatgpt({ operation: "status" });
            })
            .catch(() => {
              // 状态操作保留显式重试和错误报告入口。
              console.warn("ChatGPT 模型同步失败，请在模型设置中刷新。");
            }),
        );
      }
      return login;
    }
    if (op === "forget") await service.openaiAccount.forget();
    else if (op === "logout" || op === "selectAccount") {
      if (
        this.backend.activeCommands ||
        this.backend.providerUpdating ||
        this.backend.resourcesUpdating ||
        this.backend.starting.size
      )
        throw new Error("请等待任务与操作完成后再切换 ChatGPT 账号");
      this.backend.providerUpdating = true;
      try {
        for (const project of this.backend.projects.values()) {
          if (project.service && !project.client?.ready)
            throw new Error("请先重新连接项目，再切换 ChatGPT 账号");
          // 桌面投影可能保留旧轮次；账号变更以原 Core 的实时空闲状态为准。
          const target = project.client?.ready ? this.target(project) : null;
          if (
            target &&
            !(
              await target.client.request(
                "areal/server/status",
                {},
                { decode: providerContract.serverStatus },
              )
            ).restartSafe
          )
            throw new Error("请先停止正在运行的任务或终端，再切换 ChatGPT 账号");
          if (target) this.requireTarget(target);
        }
        if (op === "selectAccount") {
          if (!request.accountId) throw new Error("请选择 ChatGPT 账号");
          await service.openaiAccount.selectAccount(request.accountId);
        } else await service.account.logout();
      } finally {
        this.backend.providerUpdating = false;
      }
    } else if (op === "cancel") await service.account.cancel();
    else if (op === "probe") return service.probe(request.model);
    else if (op !== "status") throw new Error("不支持的 ChatGPT 操作");
    await this.readSubscription(service);
    this.backend.onChange();
    void this.refreshSubscriptionStatus(service);
    return this.subscription;
  }

  /** @param {CoreProject} project @param {import('@areal/chatgpt-provider/core').CoreSubscription|null} service @returns {SubscriptionScope} */
  subscriptionScope(project, service) {
    return {
      target: this.target(project),
      connectionGeneration: project.connectionGeneration,
      service,
      accountRevision: service?.account.revision,
      accountLifetime: service?.account.lifetime,
    };
  }
  /** @param {SubscriptionScope} scope */
  currentSubscription(scope) {
    const { target, connectionGeneration, service, accountRevision, accountLifetime } = scope;
    return (
      !this.closed &&
      !this.backend.closing &&
      this.currentTarget(target) &&
      (!this.backend.projects || this.backend.projects.get(target.project.id) === target.project) &&
      target.project.connectionGeneration === connectionGeneration &&
      (!service ||
        (service.account.revision === accountRevision &&
          service.account.lifetime === accountLifetime &&
          !!accountLifetime &&
          !accountLifetime.signal.aborted))
    );
  }
  /** @param {CoreProject} project @param {Record<string,unknown>} [correlation] */
  refreshSubscription(project, correlation, { observeOnly = false } = {}) {
    const target = this.target(project),
      connectionGeneration = project.connectionGeneration;
    return Promise.resolve(this.openaiPromise ?? null)
      .then((service) => {
        const scope = {
          ...this.subscriptionScope(project, service),
          target,
          connectionGeneration,
          observeOnly,
        };
        if (!this.currentSubscription(scope)) return;
        const work = (async () => {
          const provider = await this.syncSubscription(project, service, correlation, scope);
          await this.publishSubscription(scope, provider);
        })();
        return service ? service.account.track(work) : work;
      })
      .catch((error) => {
        if (!this.closed && !this.backend.closing)
          console.warn(this.redact(`ChatGPT 模型同步失败：${errorMessage(error)}`));
      });
  }
  /** @param {SubscriptionScope} scope @param {import('./provider-contract.cjs').CoreProvider|null|undefined} provider */
  async publishSubscription(scope, provider) {
    if (!this.currentSubscription(scope)) return;
    const { target } = scope;
    const models = (
      await target.client.request("areal/model/list", {}, { decode: providerContract.models })
    ).data;
    if (!this.currentSubscription(scope)) return;
    if (provider)
      this.subscriptionApplications.set(target.project, {
        scope,
        providerRevision: provider.revision,
      });
    else if (provider === null) this.subscriptionApplications.delete(target.project);
    target.project.models = models;
    this.backend.onChange();
  }
  /** @param {CoreProject} project @param {import('@areal/chatgpt-provider/core').CoreSubscription|null} service @param {Record<string,unknown>} [correlation] @param {SubscriptionScope} [scope] */
  syncSubscription(
    project,
    service,
    correlation = {
      projectId: project.id,
      connectionGeneration: project.connectionGeneration,
      coreGeneration: project.service?.generation,
    },
    scope = this.subscriptionScope(project, service),
  ) {
    const queueTrace = startupTrace("providers.subscription_queue", correlation);
    queueTrace.advance("queue_wait");
    const task = (this.subscriptionSync.get(project.id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => {
        queueTrace.finish("ok");
        return this.applySubscription(scope, correlation);
      });
    this.subscriptionSync.set(project.id, task);
    void task
      .finally(() => {
        if (this.subscriptionSync.get(project.id) === task)
          this.subscriptionSync.delete(project.id);
      })
      .catch(() => {});
    return task;
  }
  /** @param {SubscriptionScope} scope @param {Record<string,unknown>} [correlation] */
  async applySubscription(scope, correlation) {
    const trace = startupTrace("providers.subscription", correlation);
    const {
      target: { project, client },
      service,
    } = scope;
    const current = () => this.currentSubscription(scope);
    const pendingWrite = () => {
      const pending = project.pending?.some(
        (entry) =>
          (entry.method === "areal/provider/upsert" &&
            providerContract.record(entry.params.provider) &&
            entry.params.provider.id === "areal_openai") ||
          (entry.method === "areal/provider/remove" && entry.params.id === "areal_openai"),
      );
      if (pending) throw new Error("ChatGPT 配置提交结果未知，请先查询原提交结果");
    };
    const prepared = this.preparedSubscriptionStatus;
    trace.advance(prepared?.service === service ? "consume_wait" : "account_status");
    try {
      if (!current()) {
        trace.finish("degraded");
        return;
      }
      const status = service ? await this.subscriptionStatus(service, trace) : null;
      if (!current()) {
        trace.finish("degraded");
        return;
      }
      trace.advance("provider_read", status?.modelError ? "degraded" : service ? "ok" : "skipped");
      const existing = (
        await client.request("areal/provider/list", {}, { decode: providerContract.providers })
      ).data.find((p) => p.id === (service?.id ?? "areal_openai"));
      if (!current()) {
        trace.finish("degraded");
        return;
      }
      if (
        status?.modelError ||
        (status?.state && !["ready", "signed_out"].includes(status.state))
      ) {
        trace.finish("degraded");
        return;
      }
      if (!service || !status?.authenticated || status.models?.length === 0) {
        if (scope.observeOnly) {
          trace.finish("skipped");
          return null;
        }
        trace.advance("provider_remove");
        if (existing) pendingWrite();
        if (existing)
          await this.backend.submit(
            project,
            "areal/provider/remove",
            { id: existing.id, expectedRevision: existing.revision },
            { preDispatch: current },
          );
        if (!current()) {
          trace.finish("degraded");
          return;
        }
        trace.finish(existing ? "ok" : "skipped");
        return null;
      }
      trace.advance("local_ready");
      await service.ready();
      if (!current()) {
        trace.finish("degraded");
        return;
      }
      const models = status.models ?? service.models;
      const contexts = subscriptionContexts(models);
      const capabilities = Object.fromEntries(
        models
          .filter((model) => model.reasoningEffortOptions !== undefined)
          .map((model) => [
            model.id,
            {
              tools: true,
              vision: true,
              reasoning: true,
              reasoningEffortOptions: model.reasoningEffortOptions,
            },
          ]),
      );
      const desired = {
        id: service.id ?? "areal_openai",
        contextSource: "account",
        protocol: "responses",
        endpoint: service.endpoint,
        credentialRef: service.id ?? "areal_openai",
        models: models.map((m) => m.id),
        ...(Object.keys(contexts).length ? { modelParameters: contexts } : {}),
        ...(Object.keys(capabilities).length ? { modelCapabilities: capabilities } : {}),
        parameters: {},
      };
      trace.advance(scope.observeOnly ? "provider_confirm" : "provider_upsert");
      let provider = existing;
      if (
        !existing ||
        !isDeepStrictEqual(existing.modelParameters ?? {}, contexts) ||
        !isDeepStrictEqual(existing.modelCapabilities ?? {}, capabilities) ||
        Object.entries(desired).some(
          ([k, v]) => k !== "modelParameters" && JSON.stringify(existing[k]) !== JSON.stringify(v),
        )
      ) {
        if (scope.observeOnly) {
          trace.finish("degraded");
          return null;
        }
        pendingWrite();
        provider = providerContract.provider(
          await this.backend.submit(
            project,
            "areal/provider/upsert",
            {
              provider: { ...desired, revision: existing?.revision ?? 0 },
              expectedRevision: existing?.revision ?? 0,
            },
            { preDispatch: current },
          ),
        );
      }
      if (!current()) {
        trace.finish("degraded");
        return;
      }
      trace.finish("ok");
      return provider;
    } catch (error) {
      trace.finish("error", error);
      throw error;
    }
  }
  /** @param {CoreProject} project @param {string} threadId */
  async refreshGoalTransport(project, threadId) {
    const client = this.target(project).client;
    const { configuration } = await this.backend.refreshConfiguration(project, threadId);
    if (configuration.model?.providerId !== "areal_openai") return;
    const unavailable = () =>
      new Error("当前 ChatGPT 模型不可用，请在模型设置中刷新登录状态或选择其他模型");
    if (!this.openaiPromise) throw unavailable();
    const service = await this.openaiPromise;
    await this.syncSubscription(project, service);
    const current = (
      await client.request("areal/provider/list", {}, { decode: providerContract.providers })
    ).data.find((p) => p.id === "areal_openai");
    if (
      !current ||
      current.endpoint !== service.endpoint ||
      !current.models.includes(configuration.model.modelId)
    )
      throw unavailable();
    if (configuration.provider?.endpoint === current.endpoint) return;
    // 订阅转发端口随后台重启变化；显式启动目标前通过 Core 重绑定，历史 Turn 与队列快照不改写。
    // 保留用户参数，并用读取到的版本防止覆盖并发模型编辑；失败不得继续创建/恢复目标。
    await this.backend.configureThread(project, threadId, {
      expectedRevision: configuration.revision,
      model: configuration.model,
      parameters: configuration.parameters,
    });
  }
  async close() {
    this.closed = true;
    if (this.reconciliationTimer) clearTimeout(this.reconciliationTimer);
    this.preparedSubscriptionStatus = null;
    try {
      if (this.openaiPromise) await (await this.openaiPromise).close();
    } finally {
      await Promise.allSettled(this.subscriptionSync.values());
      await this.subscriptionRefresh;
      await this.reconciliation;
      if (this.networkPromise) (await this.networkPromise).close();
    }
  }
  /** @returns {import("@areal/workbench/desktop-contract/provider").ProviderStatus} */
  public() {
    const value = this.config.public();
    const projects = value.projects.map((item) => ({
      ...item,
      application: this.applicationState(this.backend.projects.get(item.projectId), value.revision),
    }));
    const states = projects.map((item) => item.application);
    /** @type {import("@areal/workbench/desktop-contract/provider").ApplicationState} */
    const application = ["unknown", "failed", "deferred"]
      .map((kind) => states.find((state) => state.kind === kind))
      .find(Boolean) ?? {
      kind: states.some((state) => state.kind === "applied") ? "applied" : "saved",
      revision: value.revision,
    };
    return {
      ...value,
      projects,
      application,
      definitions,
      data: value.data.map((item) => ({
        ...item,
        connection: connectionMetadata(item, value.credentialSources),
      })),
    };
  }
  /** @param {CoreProject|undefined} project @param {string} [revision] @returns {import("@areal/workbench/desktop-contract/provider").ApplicationState} */
  applicationState(project, revision = this.snapshot().revision) {
    if (!project?.service) return { kind: "saved", revision };
    if (this.pendingApplications.has(project.id)) return { kind: "unknown", revision };
    if (!project.client?.ready) return { kind: "deferred", revision, reason: "disconnected" };
    const failure = project.providerFailure;
    if (
      failure &&
      failure.revision === revision &&
      failure.serviceId === project.service.serviceId &&
      failure.generation === project.service.generation
    )
      return { kind: "failed", revision, message: failure.message };
    return project.providerRevision === revision &&
      !project.providerError &&
      (!project.providerProof || this.credentialsReady(project.providerProof, this.snapshot()))
      ? { kind: "applied", revision }
      : { kind: "deferred", revision, reason: "busy" };
  }
  /** @param {ProviderTarget} target @param {string} revision @param {unknown} error */
  applicationFailed(target, revision, error) {
    if (!this.currentTarget(target)) return;
    if (
      (providerContract.record(error) && providerContract.record(error.data)
        ? error.data.reason
        : undefined) === "MODEL_CONFIGURATION_BUSY"
    ) {
      delete target.project.providerFailure;
      target.project.providerError = null;
      return;
    }
    const message = this.redact(errorMessage(error) || "模型配置暂未生效，请重试。");
    target.project.providerFailure = {
      revision,
      serviceId: target.serviceId,
      generation: target.generation,
      message,
    };
    target.project.providerError = message;
  }
  requestReconciliation(delay = 0) {
    if (this.closed || this.backend.closing || this.reconciliationTimer || this.reconciliation)
      return;
    this.reconciliationTimer = setTimeout(() => {
      this.reconciliationTimer = null;
      this.reconciliation = (async () => {
        for (const project of this.backend.projects.values()) {
          if (this.closed || this.backend.closing) break;
          const state = this.applicationState(project);
          if (project.client?.ready && ["deferred", "unknown"].includes(state.kind))
            await this.reconcileProject(project);
        }
      })()
        .catch(() => {})
        .finally(() => {
          this.reconciliation = null;
          this.backend.onChange();
          if (
            [...this.backend.projects.values()].some(
              (project) =>
                project.client?.ready &&
                ["deferred", "unknown"].includes(this.applicationState(project).kind),
            )
          )
            this.requestReconciliation(2000);
        });
    }, delay);
    this.reconciliationTimer.unref?.();
  }
  /** @param {{providerId?:string|null,modelId:string}|null|undefined} ref @param {CoreProject} [project] */
  model(ref, project) {
    return (project?.providerSnapshot ?? this.value).data
      .find((p) => p.id === ref?.providerId)
      ?.models.find((m) => m.id === ref?.modelId);
  }
  /** @param {unknown} selection */
  acceptModelSelection(selection) {
    if (selection == null) return Promise.resolve();
    const accepted = providerContract.acceptedModel(selection);
    // Core 回执与目录是权威来源；串行保存跨项目偏好，迟到结果不能覆盖较新的选择。
    const update = (this.modelSelectionUpdate ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (accepted.acceptedAt <= (this.lastAcceptedModel?.acceptedAt ?? 0)) return;
        await this.backend.save("model-selection.json", accepted);
        this.lastAcceptedModel = accepted;
        this.backend.onChange();
      });
    this.modelSelectionUpdate = update;
    return update;
  }
  /** @param {import('./provider-contract.cjs').ModelCatalogEntry} model @param {CoreProject} project */
  subscriptionAvailable(model, project) {
    return subscriptionAvailable(this, model, project);
  }
  /** @param {import('./provider-contract.cjs').ModelCatalogEntry[]} models @param {CoreProject} project */
  catalog(models, project) {
    return catalog(this, models, project);
  }
  /** @param {CoreProject} project @param {import('./provider-contract.cjs').ModelRef|null|undefined} model @param {unknown} error */
  rejectModel(project, model, error) {
    return rejectModel(this, project, model, error);
  }
  /** @param {{apiKeyEnv?:string}} item */
  key(item) {
    return this.config.key(item);
  }
  environment() {
    return { ...this.config.environment(), AREAL_CREDENTIAL_areal_openai: this.openaiToken };
  }
  /** @param {unknown} message */
  redact(message) {
    let value = this.openaiToken
      ? String(message).split(this.openaiToken).join("[redacted]")
      : String(message);
    for (const reference of Object.keys(this.config.vault.keys)) {
      const key = this.key({ apiKeyEnv: reference });
      if (key) value = value.split(key).join("[redacted]");
    }
    for (const item of this.value.data) {
      const key = this.key(item);
      if (key) value = value.split(key).join("[redacted]");
    }
    return value;
  }
  /** @param {CoreProject} project */
  async syncLocal(project) {
    const client = this.target(project).client;
    // 停用旧桌面目录，不导入其 OAuth 授权，也不改变任务历史。
    const retired = (
      await client.request("areal/provider/list", {}, { decode: providerContract.providers })
    ).data.find((p) => p.id === "areal_chatgpt");
    if (retired)
      await this.backend.submit(project, "areal/provider/remove", {
        id: retired.id,
        expectedRevision: retired.revision,
      });
    for (const id of this.config.legacy?.retired ?? []) {
      if (this.value.data.some((item) => item.id === id)) continue;
      const existing = (
        await client.request("areal/provider/list", {}, { decode: providerContract.providers })
      ).data.find((item) => item.id === id);
      if (existing)
        await this.backend.submit(project, "areal/provider/remove", {
          id,
          expectedRevision: existing.revision,
        });
    }
  }
  /** @param {unknown} rawRequest */
  async command(rawRequest) {
    const request = providerContract.readRequest("providers", rawRequest);
    if (request.operation === "list") {
      if (!this.saving && !this.backend.providerUpdating) {
        await this.config.current();
        for (const project of this.backend.projects.values())
          if (project.client?.ready && this.pendingApplications.has(project.id))
            await this.reconcilePending(this.target(project));
      }
      return this.public();
    }
    if (this.saving || this.backend.providerUpdating)
      throw new Error("模型配置正在保存，请稍后重试");
    if (request.operation === "revealKey") {
      await this.config.current();
      if (request.expectedRevision !== this.value.revision)
        throw new Error("供应商配置已变化，请刷新后重新查看 API Key");
      const provider = this.value.data.find((item) => item.id === request.id);
      if (!provider?.apiKeyEnv) throw new Error("尚未配置可用的 API Key");
      try {
        const apiKey = credentialValue(this.key(provider));
        if (!apiKey) throw new Error();
        return { apiKey };
      } catch {
        throw new Error("无法显示 API Key，请解锁系统安全存储后重试。");
      }
    }
    if (request.operation === "probe" || request.operation === "discover")
      return this.test(request);
    if (["saveAndApply", "removeAndApply", "defaultAndApply"].includes(request.operation))
      return this.saveAndApply(request);
    if (request.operation === "apply") return this.apply(request);
    if (request.operation === "save") return this.save(request);
    if (!["save", "remove", "default"].includes(request.operation))
      throw new Error("不支持的供应商操作");
    return this.write(request);
  }
  /** @param {ProviderRequest} request */
  async save(request) {
    /** @type {ModelSnapshot|undefined} */
    let candidate;
    try {
      await this.write(request, (next) => {
        candidate = structuredClone(next);
      });
    } catch (error) {
      if (!candidate) throw error;
      const observed = await this.config.current().catch(() => null);
      if (
        !observed ||
        observed.revision === request.expectedRevision ||
        !isDeepStrictEqual(observed.data, candidate.data) ||
        !isDeepStrictEqual(observed.defaultModel, candidate.defaultModel)
      )
        throw error;
    }
    this.requestReconciliation();
    return this.public();
  }
  /** @param {ProviderRequest} request @param {(next:ModelSnapshot)=>void} [prepared] */
  async write(request, prepared) {
    this.saving = true;
    try {
      const current = await this.config.current();
      if (request.expectedRevision !== current.revision)
        throw new Error("供应商配置已变化，请刷新后重新保存");
      const next = structuredClone(current);
      if (request.operation === "default") {
        if (request.model != null && !providerContract.modelRef(request.model))
          throw new Error("默认模型配置无效");
        next.defaultModel = request.model ?? null;
      } else if (request.operation === "remove") {
        if (!next.data.some((p) => p.id === request.id)) throw new Error("供应商已不存在");
        next.data = next.data.filter((p) => p.id !== request.id);
        if (next.defaultModel?.providerId === request.id) next.defaultModel = null;
      } else {
        const raw = request.provider;
        if (!providerContract.record(raw) || typeof raw.name !== "string")
          throw new Error("请输入供应商名称");
        const previous = raw.id ? next.data.find((p) => p.id === raw.id) : null;
        if (raw.id && !previous) throw new Error("供应商已不存在，请刷新");
        if (
          request.authentication !== undefined &&
          !(request.authentication === "none" || request.authentication === "apiKey")
        )
          throw new Error("不支持的认证方式");
        if (typeof raw.protocol !== "string") throw new Error("模型协议无效");
        const protocol = protocolToCore(raw.protocol);
        // 只改名称或模型时，保留 CLI 提供的原始 endpoint。
        const endpoint =
          previous && raw.baseUrl === baseUrl(previous.endpoint) && protocol === previous.protocol
            ? previous.endpoint
            : connection(raw.baseUrl, raw.protocol).endpoint;
        if (!Array.isArray(raw.models)) throw new Error("请填写模型列表");
        const models = raw.models.map((m) => {
          if (
            !providerContract.record(m) ||
            typeof m.id !== "string" ||
            (m.displayName !== undefined && typeof m.displayName !== "string") ||
            (m.reportedContextWindowTokens !== undefined &&
              !providerContract.validContextWindow(m.reportedContextWindowTokens))
          )
            throw new Error("模型配置无效");
          return {
            id: m.id.trim(),
            enabled: m.enabled !== false,
            ...(m.displayName?.trim() ? { displayName: m.displayName.trim() } : {}),
            parameters: modelParameters(m.parameters),
            ...(m.reportedContextWindowTokens === undefined
              ? {}
              : { reportedContextWindowTokens: m.reportedContextWindowTokens }),
            ...(m.capabilities === undefined
              ? {}
              : { capabilities: modelCapabilities(m.capabilities) }),
          };
        });
        const item = {
          id: previous?.id ?? `app_${randomUUID().replaceAll("-", "")}`,
          name: raw.name.trim(),
          endpoint,
          protocol,
          models,
          parameters: modelParameters(raw.parameters),
          enabled: raw.enabled !== false,
          ...(previous?.apiKeyEnv ? { apiKeyEnv: previous.apiKeyEnv } : {}),
        };
        if (request.authentication === "none") delete item.apiKeyEnv;
        else if (request.apiKey !== undefined) {
          const reference = await this.config.credential(request.apiKey);
          if (reference) item.apiKeyEnv = reference;
          else if (request.authentication !== "apiKey") delete item.apiKeyEnv;
        }
        if (request.authentication === "apiKey" && !item.apiKeyEnv)
          throw new Error("请填写 API Key，或保留已配置的凭据环境变量。");
        if (request.discoverModels && !previous && item.enabled && item.models.length === 0) {
          const catalog = await this.testConnection(item, { operation: "discover" });
          if (!("models" in catalog) || !catalog.models.length)
            throw new Error("服务未提供模型，请手动添加后保存。");
          item.models = [...new Set(catalog.models)].map((id) =>
            withDefaultModelCapabilities(
              {
                id,
                enabled: true,
                parameters: {},
                ...(catalog.modelParameters?.[id]?.contextWindowTokens === undefined
                  ? {}
                  : {
                      reportedContextWindowTokens: catalog.modelParameters[id].contextWindowTokens,
                    }),
              },
              item.parameters,
            ),
          );
        }
        next.data = previous
          ? next.data.map((p) => (p.id === item.id ? item : p))
          : [...next.data, item];
      }
      prepared?.(next);
      this.config.value = await this.config.execute("write", {
        expectedRevision: current.revision,
        data: next.data,
        defaultModel: next.defaultModel,
      });
      this.backend.onChange();
      return this.public();
    } finally {
      this.saving = false;
    }
  }
  /** @param {CoreProject} project @returns {ProviderTarget} */
  target(project) {
    if (!project.client) throw new Error("Core 尚未连接");
    return {
      project,
      client: project.client,
      serviceId: project.service?.serviceId,
      generation: project.service?.generation,
    };
  }
  /** @template T @param {CoreProject} project @param {()=>Promise<T>} action @returns {Promise<T>} */
  async inProject(project, action) {
    const task = (this.projectApplications.get(project.id) ?? Promise.resolve())
      .catch(() => {})
      .then(action);
    this.projectApplications.set(project.id, task);
    try {
      return await task;
    } finally {
      if (this.projectApplications.get(project.id) === task)
        this.projectApplications.delete(project.id);
    }
  }
  /** @param {ProviderTarget} target */
  currentTarget({ project, client, serviceId, generation }) {
    return (
      client?.ready &&
      project.client === client &&
      project.service?.serviceId === serviceId &&
      project.service?.generation === generation
    );
  }
  /** @param {ProviderTarget} target */
  requireTarget(target) {
    if (!this.currentTarget(target))
      throw new Error("Core 连接已变化，模型配置应用尚未确认，请等待重新连接。");
  }
  /** @param {ProviderTarget} target @param {ConfigurationProof} proof */
  validateProof(target, proof) {
    this.requireTarget(target);
    if (proof.serviceId !== target.serviceId || proof.generation !== target.generation)
      throw new Error("Core 模型配置应用证明无效，请刷新核对。");
    return proof;
  }
  /** @param {ProviderTarget} target @param {string} [requestId] */
  async readProof(target, requestId) {
    const proof = await target.client.request(
      "areal/server/modelConfiguration/read",
      { expectedGeneration: target.generation, ...(requestId ? { requestId } : {}) },
      { decode: providerContract.configurationProof },
    );
    return this.validateProof(target, proof);
  }
  /** @param {ProviderTarget} target @param {ConfigurationProof} proof @param {ModelSnapshot} snapshot */
  rememberProof(target, proof, snapshot) {
    this.validateProof(target, proof);
    const project = target.project;
    project.providerRevision = proof.applied.revision;
    project.providerProof = proof;
    if (snapshot?.revision === proof.applied.revision) project.providerSnapshot = snapshot;
    else if (project.providerSnapshot?.revision !== proof.applied.revision)
      delete project.providerSnapshot;
  }
  /** @param {ProviderTarget} target @param {ConfigurationProof} proof @param {ModelSnapshot} snapshot */
  async confirmProof(target, proof, snapshot, { refreshModels = true } = {}) {
    this.validateProof(target, proof);
    if (proof.applied.revision !== snapshot.revision)
      throw new Error("Core 尚未确认目标模型配置，请刷新核对。");
    this.rememberProof(target, proof, snapshot);
    if (!this.credentialsReady(proof, snapshot))
      throw Object.assign(new Error("Core 尚未确认模型凭据可用，请检查凭据后重试。"), {
        configurationSettled: true,
      });
    if (refreshModels) {
      const models = await target.client.request(
        "areal/model/list",
        {},
        { decode: providerContract.models },
      );
      this.requireTarget(target);
      this.rememberProof(target, proof, snapshot);
      target.project.models = models.data;
    }
    target.project.providerError = null;
    delete target.project.providerFailure;
  }
  /** @param {ConfigurationProof} proof @param {ModelSnapshot} snapshot */
  credentialsReady(proof, snapshot) {
    return !snapshot.data.some(
      (item) =>
        item.enabled !== false &&
        item.apiKeyEnv !== undefined &&
        Object.hasOwn(this.config.vault.keys, item.apiKeyEnv) &&
        proof.credentialStates[item.id] !== "available",
    );
  }
  /** @param {ProviderTarget} target */
  reconcilePending(target) {
    return this.inProject(target.project, () => this.inspectPending(target));
  }
  /** @param {ProviderTarget} target @param {unknown} [notAccepted] @returns {Promise<PendingOutcome|undefined>} */
  async inspectPending(target, notAccepted, { refreshModels = true } = {}) {
    const pending = this.pendingApplications.get(target.project.id);
    if (!pending) return;
    try {
      const sameService =
        pending.serviceId === target.serviceId && pending.generation === target.generation;
      const observed = await this.readProof(target, sameService ? pending.requestId : undefined);
      if (!sameService) {
        this.rememberProof(target, observed, this.snapshot());
        if (observed.applied.revision === pending.snapshot.revision)
          await this.confirmProof(target, observed, pending.snapshot, { refreshModels });
        else
          target.project.providerError =
            "Core 已换代，当前模型配置与原应用目标不同，请刷新后重新应用。";
        this.pendingApplications.delete(target.project.id);
        return { generationChanged: true };
      }
      const operation = observed.operation;
      if (operation?.requestId !== pending.requestId)
        throw new Error("原模型配置操作尚未确认，请等待后刷新。");
      if (operation.state === "applied") {
        const result = this.validateProof(target, operation.result);
        if (
          result.applied.revision !== pending.targetRevision ||
          result.applied.sequence <= pending.expectedApplied.sequence
        )
          throw new Error("Core 返回了不匹配的模型配置回执，请刷新核对。");
        if (
          observed.applied.revision !== result.applied.revision ||
          observed.applied.sequence !== result.applied.sequence
        )
          throw new Error("Core 模型配置已再次变化，请刷新核对。");
        await this.confirmProof(target, result, pending.snapshot, { refreshModels });
        this.pendingApplications.delete(target.project.id);
      } else if (
        operation.state === "rejected" ||
        (operation.state === "unknown" && !operation.error && notAccepted)
      ) {
        this.rememberProof(target, observed, this.snapshot());
        this.pendingApplications.delete(target.project.id);
        const error = operation.error ?? notAccepted;
        target.project.providerError = this.redact(
          errorMessage(error) || "Core 已拒绝模型配置应用。",
        );
        this.applicationFailed(target, pending.targetRevision, error);
        return { rejected: true, error };
      } else throw new Error("模型配置应用仍待确认，请等待后刷新；不会重复提交或回滚。");
    } catch (error) {
      if (this.currentTarget(target))
        target.project.providerError = this.redact(errorMessage(error));
      if (providerContract.record(error) && error.configurationSettled) {
        this.pendingApplications.delete(target.project.id);
        this.applicationFailed(target, pending.targetRevision, error);
        return { rejected: true, error };
      }
      return { pending: true, error };
    }
  }
  /** @param {Iterable<CoreProject>} [projects] */
  async prepareProjects(projects = this.backend.projects.values()) {
    const targets = [];
    for (const project of projects) {
      if (project.service && !project.client?.ready)
        throw new Error("项目尚未连接，重新连接后再保存。");
      if (!project.client?.ready) continue;
      const target = this.target(project);
      await this.inProject(project, async () => {
        this.requireTarget(target);
        if (
          !["areal/server/modelConfiguration/read", "areal/server/modelConfiguration/apply"].every(
            (method) => target.client.capabilities?.methods?.includes(method),
          )
        ) {
          project.providerError = "请更新 Core 后再应用模型配置。";
          throw new Error(project.providerError);
        }
        const reconciled = await this.inspectPending(target);
        if (reconciled?.pending) throw reconciled.error;
        target.proof = await this.readProof(target);
        this.rememberProof(target, target.proof, this.snapshot());
        const status = await target.client.request(
          "areal/server/status",
          {},
          { decode: providerContract.serverStatus },
        );
        this.requireTarget(target);
        if (!status.restartSafe) throw new Error("任务或终端正在运行，完成后再保存；修改仍保留。");
      });
      targets.push(target);
    }
    return targets;
  }
  /** @param {ModelSnapshot} snapshot @param {ProviderTarget[]} [targets] */
  async applyProjects(snapshot, targets) {
    const outcomes = [];
    for (const target of targets ?? (await this.prepareProjects()))
      outcomes.push(
        await this.inProject(target.project, () => this.applyProject(snapshot, target)),
      );
    return outcomes;
  }
  /** @param {ModelSnapshot} snapshot @param {ProviderTarget} target @returns {Promise<ApplyOutcome>} */
  async applyProject(snapshot, target, { refreshModels = true } = {}) {
    try {
      this.requireTarget(target);
      if (!target.proof) throw new Error("缺少 Core 模型配置应用证明");
      if (
        target.proof.applied.revision === snapshot.revision &&
        this.credentialsReady(target.proof, snapshot)
      ) {
        await this.confirmProof(target, target.proof, snapshot, { refreshModels });
        return { target, applied: true };
      }
      const credentials = this.config.credentialsFor(snapshot);
      const pending = {
        requestId: randomUUID(),
        serviceId: target.serviceId,
        generation: target.generation,
        expectedApplied: target.proof.applied,
        targetRevision: snapshot.revision,
        snapshot,
      };
      this.pendingApplications.set(target.project.id, pending);
      try {
        const receipt = this.validateProof(
          target,
          await target.client.request(
            "areal/server/modelConfiguration/apply",
            {
              requestId: pending.requestId,
              expectedGeneration: pending.generation,
              expectedApplied: pending.expectedApplied,
              targetRevision: snapshot.revision,
              credentials,
            },
            { decode: providerContract.configurationProof },
          ),
        );
        if (
          receipt.operation?.requestId !== pending.requestId ||
          receipt.operation.state !== "applied"
        )
          throw new Error("模型配置应用尚未确认，请刷新核对。");
        const result = this.validateProof(target, receipt.operation.result);
        if (
          result.applied.revision !== snapshot.revision ||
          result.applied.sequence <= pending.expectedApplied.sequence ||
          !isDeepStrictEqual(result.applied, receipt.applied)
        )
          throw new Error("Core 返回了不匹配的模型配置回执，请刷新核对。");
        await this.confirmProof(target, result, snapshot, { refreshModels });
        this.pendingApplications.delete(target.project.id);
        return { target, applied: true };
      } catch (error) {
        const notAccepted =
          providerContract.record(error) &&
          error.name === "CoreRpcError" &&
          error.submissionUnknown !== true &&
          ((typeof error.code === "number" && [-32602, -32601, -32003].includes(error.code)) ||
            (error.code === -32010 &&
              providerContract.record(error.data) &&
              error.data.reason === "MODEL_CONFIGURATION_CAPACITY"));
        const reconciled = await this.inspectPending(target, notAccepted ? error : undefined, {
          refreshModels,
        });
        return {
          target,
          applied:
            !this.pendingApplications.has(target.project.id) &&
            !reconciled?.rejected &&
            this.currentTarget(target),
          pending: reconciled?.pending === true,
          error: reconciled?.error ?? error,
        };
      }
    } catch (error) {
      if (this.currentTarget(target))
        target.project.providerError = this.redact(errorMessage(error));
      return {
        target,
        pending: this.pendingApplications.has(target.project.id) || !this.currentTarget(target),
        error,
      };
    }
  }
  /** @param {CoreProject} project */
  reconcileProject(project, { refreshModels = true } = {}) {
    const target = this.target(project);
    return this.inProject(project, async () => {
      try {
        if (this.closed || this.backend.closing) return;
        this.requireTarget(target);
        if (
          !["areal/server/modelConfiguration/read", "areal/server/modelConfiguration/apply"].every(
            (method) => target.client.capabilities?.methods?.includes(method),
          )
        )
          throw new Error("请更新 Core 后再应用模型配置。");
        const reconciled = await this.inspectPending(target, undefined, { refreshModels });
        if (reconciled?.pending) return;
        const snapshot = await this.config.current();
        this.requireTarget(target);
        if (this.applicationState(project, snapshot.revision).kind === "failed") return;
        target.proof = await this.readProof(target);
        this.rememberProof(target, target.proof, snapshot);
        if (
          target.proof.applied.revision === snapshot.revision &&
          this.credentialsReady(target.proof, snapshot)
        ) {
          await this.confirmProof(target, target.proof, snapshot, { refreshModels });
          return;
        }
        if (
          this.saving ||
          this.backend.providerUpdating ||
          this.backend.resourcesUpdating ||
          this.backend.activeCommands ||
          this.backend.starting.size
        ) {
          project.providerError = null;
          return;
        }
        const status = await target.client.request(
          "areal/server/status",
          {},
          { decode: providerContract.serverStatus },
        );
        this.requireTarget(target);
        if (
          !status.restartSafe ||
          this.saving ||
          this.backend.providerUpdating ||
          this.backend.resourcesUpdating ||
          this.backend.activeCommands ||
          this.backend.starting.size
        ) {
          project.providerError = null;
          return;
        }
        this.backend.providerUpdating = true;
        try {
          if (this.closed || this.backend.closing) return;
          const outcome = await this.applyProject(snapshot, target, { refreshModels });
          if (!outcome.applied && !outcome.pending)
            this.applicationFailed(target, snapshot.revision, outcome.error);
        } finally {
          this.backend.providerUpdating = false;
        }
      } catch (error) {
        this.applicationFailed(target, this.snapshot().revision, error);
      } finally {
        this.backend.onChange();
        if (
          project.client?.ready &&
          ["deferred", "unknown"].includes(this.applicationState(project).kind)
        )
          this.requestReconciliation(2000);
      }
    });
  }
  /** @param {ProviderRequest} request */
  async saveAndApply(request) {
    if (
      this.backend.providerUpdating ||
      this.backend.resourcesUpdating ||
      this.backend.activeCommands ||
      this.backend.starting.size ||
      this.backend.hasWork()
    )
      throw new Error("任务或操作正在进行，完成后再保存；修改仍保留。");
    this.backend.providerUpdating = true;
    /** @type {ModelSnapshot|undefined} */ let previous;
    /** @type {{revision:string}|undefined} */ let written;
    /** @type {ModelSnapshot|undefined} */ let candidate;
    /** @type {ProviderTarget[]} */ let targets = [];
    /** @type {ApplyOutcome[]} */ let outcomes = [];
    try {
      previous = await this.config.current();
      if (request.expectedRevision !== previous.revision)
        throw new Error("配置已变化，请刷新后重试。");
      targets = await this.prepareProjects();
      written = await this.write(
        {
          ...request,
          operation:
            request.operation === "removeAndApply"
              ? "remove"
              : request.operation === "defaultAndApply"
                ? "default"
                : "save",
          discoverModels: true,
        },
        (next) => {
          candidate = structuredClone(next);
        },
      );
      outcomes = await this.applyProjects(this.snapshot(), targets);
      if (outcomes.some((outcome) => !outcome.applied))
        throw new Error("项目模型配置应用未全部确认。");
      if ((await this.config.current()).revision !== written.revision)
        throw new Error("模型配置已被外部修改，请刷新核对。");
      const result = this.public();
      if (result.pendingApply) throw new Error("Core 尚未确认配置。");
      return result;
    } catch (error) {
      let rollbackError = null,
        restored = false;
      if (!written && candidate && previous) {
        try {
          const observed = await this.config.current();
          if (
            observed.revision !== previous.revision &&
            isDeepStrictEqual(observed.data, candidate.data) &&
            isDeepStrictEqual(observed.defaultModel, candidate.defaultModel)
          )
            written = observed;
        } catch (failure) {
          rollbackError = failure;
        }
      }
      if (
        written &&
        previous &&
        !outcomes.some((outcome) => outcome.pending) &&
        !targets.some((target) => this.pendingApplications.has(target.project.id))
      ) {
        try {
          const rollback = await this.config.execute("write", {
            expectedRevision: written.revision,
            data: previous.data,
            defaultModel: previous.defaultModel,
          });
          this.config.value = rollback;
          const compensation = await this.applyProjects(rollback);
          if (
            compensation.some((outcome) => !outcome.applied) ||
            (await this.config.current()).revision !== rollback.revision
          )
            throw new Error("原模型配置应用未全部确认");
          restored = true;
        } catch (failure) {
          rollbackError = failure;
        }
      }
      throw new Error(
        `${this.redact(errorMessage(error))}${rollbackError ? " 回滚未确认，请刷新核对配置。" : restored ? " 已恢复原配置，修改仍保留。" : written ? " 配置应用仍待确认，请刷新核对；修改仍保留。" : ""}`,
      );
    } finally {
      this.backend.providerUpdating = false;
      this.backend.onChange();
    }
  }
  /** @param {ProviderRequest} request */
  async apply(request) {
    if (
      this.backend.providerUpdating ||
      this.backend.resourcesUpdating ||
      this.backend.activeCommands ||
      this.backend.starting.size ||
      this.backend.hasWork()
    )
      throw new Error("请等待任务和操作完成，并处理排队消息后再应用模型配置");
    this.backend.providerUpdating = true;
    try {
      const current = await this.config.current();
      if (request.expectedRevision !== current.revision)
        throw new Error("供应商配置已变化，请刷新后重新应用");
      const outcomes = await this.applyProjects(current);
      if (outcomes.some((outcome) => !outcome.applied))
        throw new Error("模型配置应用未全部确认，请等待后刷新核对。");
      if ((await this.config.current()).revision !== current.revision)
        throw new Error("模型配置已被外部修改，请刷新核对。");
      this.backend.onChange();
      return this.public();
    } finally {
      this.backend.providerUpdating = false;
    }
  }
  /** @param {{id?:string,model?:unknown,operation:string,connection?:unknown}} request */
  async test({ id, model, operation, connection: draft }) {
    if (operation === "discover" && draft !== undefined) {
      if (!providerContract.record(draft)) throw new Error("连接配置无效");
      const endpoint = connection(draft.baseUrl, draft.protocol).endpoint;
      const credential = draft.credential;
      if (!providerContract.record(credential)) throw new Error("认证方式无效");
      if (typeof draft.protocol !== "string") throw new Error("模型协议无效");
      let apiKey;
      if (credential?.kind === "none") apiKey = "";
      else if (credential?.kind === "draft") apiKey = credentialValue(credential.value);
      else if (credential?.kind === "saved") {
        await this.config.current();
        if (credential.expectedRevision !== this.value.revision)
          throw new Error("供应商配置已变化，请刷新后重新获取模型");
        const provider = this.value.data.find((item) => item.id === credential.providerId);
        if (!provider) throw new Error("供应商已不存在，请刷新");
        apiKey = this.key(provider);
      } else throw new Error("认证方式无效");
      if (credential.kind !== "none" && !apiKey)
        throw new Error("请填写 API Key，或使用已保存的凭据");
      return this.testConnection(
        { endpoint, protocol: protocolToCore(draft.protocol) },
        { operation, apiKey },
      );
    }
    await this.config.current();
    const provider = this.value.data.find((p) => p.id === id);
    if (!provider) throw new Error("请先保存供应商");
    return this.testConnection(provider, { model, operation });
  }
  /** @param {{endpoint:string,protocol:string,apiKeyEnv?:string,models?:import('./provider-contract.cjs').ModelConfig[]}} provider @param {{model?:unknown,operation:string,apiKey?:string}} request */
  testConnection(provider, request) {
    return testConnection(provider, request, this);
  }
}
module.exports = { AppProviders, connection };
