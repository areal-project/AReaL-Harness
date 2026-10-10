'use strict';
const { readFile, appendFile } = require('node:fs/promises');
const { join } = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { SubscriptionStore } = require('./subscription.cjs');
const { ModelConfiguration, protocolToCore, baseUrl: endpointBase } = require('./model-config.cjs');

function connection(baseUrl, protocol) {
  if (!['chatCompletions', 'responses'].includes(protocol)) throw new Error('请选择 Chat Completions 或 Responses');
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的 Base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须是无认证信息、查询参数和片段的 HTTP(S) 地址');
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses)$/, '');
  const base = url.toString().replace(/\/$/, '');
  return { baseUrl: base, endpoint: base + (protocol === 'responses' ? '/responses' : '/chat/completions') };
}

function modelParameters(raw = {}) {
  const result = {};
  for (const [name, valid] of Object.entries({ temperature: v => Number.isFinite(v) && v >= 0 && v <= 2, maxOutputTokens: v => Number.isSafeInteger(v) && v > 0, reasoningEffort: v => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(v) })) {
    if (raw[name] != null) { if (!valid(raw[name])) throw new Error('模型参数无效'); result[name] = raw[name]; }
  }
  return result;
}

/** Core-owned metadata, with desktop-only encrypted credentials and OAuth. */
class AppProviders {
  constructor(backend, encryption) { this.backend = backend; this.encryption = encryption; this.config = new ModelConfiguration(backend, encryption); this.openaiToken = null; }
  async init() {
    await this.config.init();
    // 与 Core 的本机连接令牌一样，权限为 0600 的能力文件仅由后台读取。
    // 保留端口与令牌，避免后台重启后失效仍在运行的 Core 中冻结的传输配置。
    try { this.transport = JSON.parse(await readFile(join(this.backend.home, 'subscription-transport.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (this.transport && (!/^[a-f0-9]{64}$/.test(this.transport.token) || !Number.isInteger(this.transport.port) || this.transport.port < 0 || this.transport.port > 65535)) throw new Error('本地订阅传输配置无效');
    if (!this.transport) {
      this.transport = { token: randomBytes(32).toString('hex'), port: 0 };
      await this.backend.save('subscription-transport.json', this.transport);
    }
    this.openaiToken = this.transport.token;
  }
  get value() { return this.config.value ?? { data: [] }; }
  async openai() {
    if (!this.openaiPromise) this.openaiPromise = import('@areal/chatgpt-provider/core').then(({ CoreSubscription }) => {
      this.openaiStore = new SubscriptionStore(this.backend, this.encryption);
      const onRequest = process.env.AREAL_CORE_PROVIDER_AUDIT === '1' ? async ({ providerId, protocol, model, startedAt, completedAt, upstreamHttpStatus, upstreamContentType, localHttpStatus, outcome, failureKind, streamFailureReason }) => {
        await appendFile(join(this.backend.home, 'provider-requests.jsonl'), JSON.stringify({ providerId, protocol, model, startedAt, completedAt,
          upstreamHttpStatus, upstreamContentType, localHttpStatus, outcome, failureKind, streamFailureReason }) + '\n', { mode: 0o600 });
      } : undefined;
      return new CoreSubscription({ store: this.openaiStore, token: this.openaiToken, port: this.transport.port, onListen: async port => { this.transport.port = port; await this.backend.save('subscription-transport.json', this.transport); }, kind: 'openai', onRequest });
    }).catch(error => { this.openaiPromise = null; throw error; });
    return this.openaiPromise;
  }
  async prepare() {
    try { const saved = JSON.parse(await readFile(join(this.backend.home, 'openai-subscription.json'), 'utf8')); if (!saved.secret) return; }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await (await this.openai()).ready();
  }
  async chatgpt(request) {
    if ((request.provider ?? 'openai') !== 'openai') throw new Error('不支持的账号类型');
    const service = await this.openai();
    const op = request.operation;
    // Initial authorization neither restarts Core nor replaces an existing grant.
    // Unrelated tasks, terminals and unresolved resources must not block it.
    if (op === 'login') {
      this.openaiStore.check();
      if (await service.account.read()) throw new Error('请先退出当前 ChatGPT 账号');
      const login = await service.account.begin();
      const completion = service.account.attempt?.done;
      if (completion && this.loginAttempt !== completion) {
        this.loginAttempt = completion;
        // Authorization outlives the settings page. Publish its catalog even
        // when the renderer has stopped polling; account.close waits for this work.
        service.account.track(completion.then(async () => {
          if (service.account.lifetime.signal.aborted || !(await service.account.read())) return;
          await this.chatgpt({ operation: 'status' });
        }).catch(() => {
          // The status action remains the explicit retry and error-reporting path.
          console.warn('ChatGPT 模型同步失败，请在模型设置中刷新。');
        }));
      }
      return login;
    }
    if (op === 'forget') await service.account.forget();
    else if (op === 'logout') {
      if (this.backend.hasWork() || this.backend.activeCommands || this.backend.providerUpdating || this.backend.resourcesUpdating || this.backend.starting.size) throw new Error('请等待任务与操作完成后再切换 ChatGPT 账号');
      this.backend.providerUpdating = true;
      try {
        for (const project of this.backend.projects.values()) {
          if (project.service && !project.client?.ready) throw new Error('请先重新连接项目，再切换 ChatGPT 账号');
          if (project.client?.ready && !(await project.client.request('areal/server/status')).restartSafe) throw new Error('请先停止正在运行的任务或终端，再切换 ChatGPT 账号');
        }
        await service.account.logout();
      } finally { this.backend.providerUpdating = false; }
    } else if (op === 'cancel') await service.account.cancel();
    else if (op === 'probe') return service.probe(request.model);
    else if (op !== 'status') throw new Error('不支持的 ChatGPT 操作');
    const status = await service.account.status();
    await service.ready();
    // OAuth completion does not restart Core or alter existing task selections.
    for (const project of this.backend.projects.values()) {
      if (!project.client?.ready) continue;
      await this.syncSubscription(project, service);
      project.models = (await project.client.request('areal/model/list')).data ?? [];
    }
    this.backend.onChange();
    return status;
  }
  syncSubscription(project, service) {
    const task = (this.subscriptionSync ?? Promise.resolve()).catch(() => {}).then(() => this.applySubscription(project, service));
    this.subscriptionSync = task; return task;
  }
  async applySubscription(project, service) {
    const status = service ? await service.account.status() : { authenticated: false };
    const existing = (await project.client.request('areal/provider/list')).data.find(p => p.id === (service?.id ?? 'areal_openai'));
    if (status.modelError) return;
    if (!status.authenticated || status.models?.length === 0) {
      if (existing) await this.backend.submit(project, 'areal/provider/remove', { id: existing.id, expectedRevision: existing.revision });
      return;
    }
    await service.ready();
    const desired = { id: service.id ?? 'areal_openai', protocol: 'responses', endpoint: service.endpoint, credentialRef: service.id ?? 'areal_openai', models: (status.models ?? service.models).map(m => m.id), parameters: {} };
    if (!existing || Object.entries(desired).some(([k,v]) => JSON.stringify(existing[k]) !== JSON.stringify(v)))
      await this.backend.submit(project, 'areal/provider/upsert', { provider: { ...desired, revision: existing?.revision ?? 0 }, expectedRevision: existing?.revision ?? 0 });
  }
  async refreshGoalTransport(project, threadId) {
    const { configuration } = await this.backend.refreshConfiguration(project, threadId);
    if (configuration.model?.providerId !== 'areal_openai') return;
    const unavailable = () => new Error('当前 ChatGPT 模型不可用，请在模型设置中刷新登录状态或选择其他模型');
    if (!this.openaiPromise) throw unavailable();
    const service = await this.openaiPromise;
    await this.syncSubscription(project, service);
    const current = (await project.client.request('areal/provider/list')).data.find(p => p.id === 'areal_openai');
    if (!current || current.endpoint !== service.endpoint || !current.models.includes(configuration.model.modelId)) throw unavailable();
    if (configuration.provider?.endpoint === current.endpoint) return;
    // 订阅转发端口随后台重启变化；显式启动目标前通过 Core 重绑定，历史 Turn 与队列快照不改写。
    // 保留用户参数，并用读取到的版本防止覆盖并发模型编辑；失败不得继续创建/恢复目标。
    await this.backend.configureThread(project, threadId, {
      expectedRevision: configuration.revision, model: configuration.model, parameters: configuration.parameters,
    });
  }
  async close() { if (this.openaiPromise) await (await this.openaiPromise).close(); }
  public() { return this.config.public(); }
  model(ref, project) { return (project?.providerSnapshot ?? this.value).data.find(p => p.id === ref?.providerId)?.models.find(m => m.id === ref.modelId); }
  catalog(models, project) { return models.map(m => ({ ...m, displayName: this.model(m, project)?.displayName || m.displayName || m.modelId })); }
  key(item) { return this.config.key(item); }
  environment() { return { ...this.config.environment(), AREAL_CREDENTIAL_areal_openai: this.openaiToken }; }
  redact(message) {
    let value = this.openaiToken ? String(message).split(this.openaiToken).join('[redacted]') : String(message);
    for (const reference of Object.keys(this.config.vault.keys)) { const key = this.key({ apiKeyEnv: reference }); if (key) value = value.split(key).join('[redacted]'); }
    for (const item of this.value.data) { const key = this.key(item); if (key) value = value.split(key).join('[redacted]'); }
    return value;
  }
  async sync(project) {
    // Retire the previous desktop catalog without importing its OAuth grant or changing task history.
    const retired = (await project.client.request('areal/provider/list')).data.find(p => p.id === 'areal_chatgpt');
    if (retired) await this.backend.submit(project, 'areal/provider/remove', { id: retired.id, expectedRevision: retired.revision });
    await this.syncSubscription(project, this.openaiPromise ? await this.openaiPromise : null);
    for (const id of this.config.legacy?.retired ?? []) {
      if (this.value.data.some(item => item.id === id)) continue;
      const existing = (await project.client.request('areal/provider/list')).data.find(item => item.id === id);
      if (existing) await this.backend.submit(project, 'areal/provider/remove', { id, expectedRevision: existing.revision });
    }
  }
  async command(request) {
    if (this.saving || this.backend.providerUpdating) throw new Error('模型配置正在保存，请稍后重试');
    if (request.operation === 'list') { await this.config.current(); return this.public(); }
    if (request.operation === 'probe' || request.operation === 'discover') { await this.config.current(); return this.test(request); }
    if (request.operation === 'apply') return this.apply(request);
    if (!['save', 'remove', 'default'].includes(request.operation)) throw new Error('不支持的供应商操作');
    this.saving = true;
    try {
      const current = await this.config.current();
      if (request.expectedRevision !== current.revision) throw new Error('供应商配置已变化，请刷新后重新保存');
      const next = structuredClone(current);
      if (request.operation === 'default') next.defaultModel = request.model ?? null;
      else if (request.operation === 'remove') {
        if (!next.data.some(p => p.id === request.id)) throw new Error('供应商已不存在');
        next.data = next.data.filter(p => p.id !== request.id);
        if (next.defaultModel?.providerId === request.id) next.defaultModel = null;
      } else {
        const raw = request.provider;
        if (!raw || typeof raw.name !== 'string') throw new Error('请输入供应商名称');
        const previous = raw.id ? next.data.find(p => p.id === raw.id) : null;
        if (raw.id && !previous) throw new Error('供应商已不存在，请刷新');
        if (request.authentication !== undefined && !['none', 'apiKey'].includes(request.authentication)) throw new Error('不支持的认证方式');
        const protocol = protocolToCore(raw.protocol);
        // Name/model-only edits preserve an exact endpoint supplied by the CLI.
        const endpoint = previous && raw.baseUrl === endpointBase(previous.endpoint) && protocol === previous.protocol
          ? previous.endpoint : connection(raw.baseUrl, raw.protocol).endpoint;
        if (!Array.isArray(raw.models)) throw new Error('请填写模型列表');
        const models = raw.models.map(m => ({ id: m.id?.trim(), enabled: m.enabled !== false, ...(m.displayName?.trim() ? { displayName: m.displayName.trim() } : {}), parameters: modelParameters(m.parameters) }));
        const item = { id: previous?.id ?? `app_${randomUUID().replaceAll('-', '')}`, name: raw.name.trim(), endpoint, protocol, models, parameters: modelParameters(raw.parameters), enabled: raw.enabled !== false,
          ...(previous?.apiKeyEnv ? { apiKeyEnv: previous.apiKeyEnv } : {}) };
        if (request.authentication === 'none') delete item.apiKeyEnv;
        else if (request.apiKey !== undefined) {
          const reference = await this.config.credential(request.apiKey);
          if (reference) item.apiKeyEnv = reference;
          else if (request.authentication !== 'apiKey') delete item.apiKeyEnv;
        }
        if (request.authentication === 'apiKey' && !item.apiKeyEnv) throw new Error('请填写 API Key，或保留已配置的凭据环境变量。');
        next.data = previous ? next.data.map(p => p.id === item.id ? item : p) : [...next.data, item];
      }
      this.config.value = await this.config.execute('write', { expectedRevision: current.revision, data: next.data, defaultModel: next.defaultModel });
      this.backend.onChange();
      return this.public();
    } finally { this.saving = false; }
  }
  async apply(request) {
    if (this.backend.providerUpdating || this.backend.resourcesUpdating || this.backend.activeCommands || this.backend.starting.size || this.backend.hasWork()) throw new Error('请等待任务和操作完成，并处理排队消息后再应用模型配置');
    this.backend.providerUpdating = true;
    try {
      const current = await this.config.current();
      if (request.expectedRevision !== current.revision) throw new Error('供应商配置已变化，请刷新后重新应用');
      for (const project of this.backend.projects.values()) {
        if (project.service && !project.client?.ready) throw new Error('请先重新连接项目，再应用模型配置');
        if (project.client?.ready && !(await project.client.request('areal/server/status')).restartSafe) throw new Error('请先停止正在运行的任务或终端，再应用模型配置');
      }
      const drained = [];
      try {
        // Core 在同一准入锁下检查空闲并关闭受理，阻止预检后的新任务竞态。
        // 全部通过后才重启；失败时只恢复已确认排空的实例，忙碌实例不受影响。
        for (const project of this.backend.projects.values()) if (project.client?.ready) {
          const status = await project.client.request('areal/server/drain', { strategy: 'ifIdle', timeoutMs: 30_000 }, { timeoutMs: 35_000 });
          if (!status.restartSafe) throw new Error('Core 尚有未结算任务或终端，请等待后重试');
          drained.push(project);
        }
      } catch (error) {
        const failures = await this.restart(drained);
        this.backend.onChange();
        throw new Error(`模型配置未完全应用：${this.redact(error.message)}${failures.length ? `；以下项目需重新连接：${failures.join('、')}` : ''}`);
      }
      const failures = await this.restart(this.backend.projects.values());
      await this.config.current();
      this.backend.onChange();
      return { ...this.public(), warning: failures.length ? `以下项目需重新连接：${failures.join('、')}` : null };
    } finally { this.backend.providerUpdating = false; }
  }
  async restart(projects) {
    const failures = [];
    for (const project of projects) {
      try {
        await this.backend.restartProject(project);
      } catch (error) { project.error = this.redact(error.message); failures.push(project.root); }
    }
    return failures;
  }
  async test({ id, model, operation }) {
    const provider = this.value.data.find(p => p.id === id);
    if (!provider) throw new Error('请先保存供应商');
    const key = this.key(provider);
    const url = operation === 'discover' ? `${endpointBase(provider.endpoint)}/models` : provider.endpoint;
    if (operation === 'probe' && !provider.models.some(m => m.id === model && m.enabled)) throw new Error('请选择已启用的模型');
    const body = provider.protocol === 'responses' ? { model, input: [{ role: 'user', content: 'Reply with OK.' }], store: false, stream: true } : { model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true };
    let response;
    try {
      response = await fetch(url, { method: operation === 'discover' ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, ...(operation === 'probe' ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new Error('连接失败：请检查 Base URL、网络及服务是否可用'); }
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? '认证失败：请检查 API Key 及模型访问权限' : `模型服务返回 HTTP ${response.status}`); }
    if (operation === 'probe') {
      const { probeResponse } = await import('@areal/chatgpt-provider/core');
      try { return await probeResponse(response, provider.protocol === 'chat-completions' ? 'chatCompletions' : provider.protocol); }
      catch { throw new Error('模型服务未完成有效的流式文本回复，请检查模型和协议'); }
    }
    // Do not reflect upstream response text (which may contain the credential) into IPC.
    let bytes = 0, chunks = [];
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('模型服务响应过大'); chunks.push(chunk); }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('模型服务未返回有效的 JSON 响应'); }
    if (operation === 'discover') {
      if (!Array.isArray(data.data)) throw new Error('服务未返回模型列表，请手动添加模型');
      return { models: data.data.map(p => p.id).filter(v => typeof v === 'string' && v.length <= 256 && (!key || !v.includes(key))).slice(0, 64) };
    }
    throw new Error('不支持的供应商测试操作');
  }
}
module.exports = { AppProviders, connection };
