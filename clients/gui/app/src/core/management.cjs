'use strict';
const {configurePluginAuthentication} = require('./plugin-authentication.cjs');
const { manageTask, taskOperations } = require('./tasks.cjs');
const { workgroupArtifactFile } = require('./workgroup-artifacts.cjs');
const { resolveTerminalPresentation } = require('./terminal-profile.cjs');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function loginTerminalCommand() {
  const user = os.userInfo();
  if (typeof user.username !== 'string' || !user.username || user.username.includes('\0')) throw new Error('无法读取终端所属账户');
  const shell = [user.shell, process.env.SHELL, '/bin/sh'].find(candidate => {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.includes('\0')) return false;
    try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
    catch { return false; }
  });
  if (!shell) throw new Error('没有可用的登录 shell');
  return { shell, argv: ['/usr/bin/env', `SHELL=${shell}`, `USER=${user.username}`, `LOGNAME=${user.username}`, 'TERM=xterm-256color', shell, '-l', '-i'] };
}

function shellFromManagedArgv(argv) {
  if (!Array.isArray(argv)) return undefined;
  if (argv.length === 8 && argv[0] === '/usr/bin/env' && typeof argv[5] === 'string'
    && argv[1] === `SHELL=${argv[5]}` && argv[2]?.startsWith('USER=') && argv[3]?.startsWith('LOGNAME=')
    && argv[4] === 'TERM=xterm-256color' && argv[6] === '-l' && argv[7] === '-i') return argv[5];
  return argv[0];
}

const mutations = {
  pluginArchiveImport: 'areal/plugin/importArchive',
  mcpFormResourceStage: 'areal/mcp/form/resource/stage',
  pluginHooksConfigure:'areal/plugin/hooks/configure', hookAcknowledge:'areal/hook/acknowledge', marketplaceAdd: 'areal/marketplace/add', marketplaceAddGit: 'areal/marketplace/addGit', marketplaceRemove: 'areal/marketplace/remove', marketplaceUpdate: 'areal/marketplace/update', pluginResolve: 'areal/plugin/resolve', pluginAuthConfigure:'areal/plugin/auth/configure', pluginConnection: 'areal/plugin/connection', connectorConfigure: 'areal/plugin/connector/configure', pluginInstall: 'areal/plugin/install',
  pluginConfigure: 'areal/plugin/configure', pluginComponentConfigure: 'areal/plugin/component/configure', pluginUninstall: 'areal/plugin/uninstall', pluginSetup: 'areal/plugin/setup',
  providerSave: 'areal/provider/upsert', providerRemove: 'areal/provider/remove',
  mcpSave: 'areal/mcp/configure', mcpConnect: 'areal/mcp/connect', mcpDisconnect: 'areal/mcp/disconnect',
  archive: 'areal/thread/archive', unarchive: 'areal/conversation/unarchive',
  processCloseStdin: 'areal/process/closeStdin', processStart: 'areal/process/start', processWrite: 'areal/process/write', processResize: 'areal/process/resize', processTerminate: 'areal/process/terminate',
  goalCreate: 'areal/goal/create', goalUpdate: 'areal/goal/update', goalPause: 'areal/goal/pause', goalResume: 'areal/goal/resume', goalClear: 'areal/goal/clear',
};
// Goal receipts belong to the owning Thread, unlike deployment management receipts.
const threadMutationMethods = new Set(Object.values(mutations).filter(method => method.startsWith('areal/goal/')));
const managementMethods = new Set(['areal/blob/release', 'areal/queue/steer', ...Object.values(mutations).filter(method => !method.startsWith('areal/process/') && !threadMutationMethods.has(method)), ...['update', 'remove', 'reorder', 'pause', 'resume'].map(name => `areal/queue/${name}`)]);
const fields = {
  pluginArchiveImport: ['path', 'expectedRevision'],
  mcpFormResourceStage: ['selectionToken', 'paths'],
  pluginHooksConfigure:['id','expectedDigest','definitionDigest','enabled','trusted','allowReadOnlyCommands'], hookAcknowledge:['threadId','invocationId','inspection'], marketplaceAdd: ['root', 'expectedRevision'], marketplaceAddGit: ['url', 'refName', 'sparsePaths', 'expectedRevision'], marketplaceRemove: ['root', 'expectedRevision'], marketplaceUpdate: ['expectedRevision'], pluginResolve: ['id', 'expectedRevision'], pluginAuthConfigure:['id','server','expectedDigest','configuration'], pluginConnection: ['id', 'expectedDigest', 'connect'], connectorConfigure: ['id', 'connectorId', 'provider', 'credentialRef', 'expectedDigest'], pluginInstall: ['id', 'scope', 'expectedRevision', 'source', 'expectedDigest'],
  pluginConfigure: ['id', 'scope', 'enabled', 'expectedRevision'], pluginComponentConfigure: ['id', 'component', 'enabled', 'expectedRevision', 'expectedDigest'], pluginUninstall: ['id', 'expectedRevision'],
  pluginSetup: ['id', 'threadId'],
  providerSave: ['provider', 'expectedRevision'], providerRemove: ['id', 'expectedRevision'],
  mcpSave: ['id', 'expectedRevision', 'config'], mcpConnect: ['id', 'expectedRevision'], mcpDisconnect: ['id', 'expectedRevision'],
  archive: ['threadId'], unarchive: ['threadId'],
  processStart: ['threadId', 'lifetime', 'argv', 'cwd', 'tty', 'cols', 'rows', 'timeoutMs'],
  processCloseStdin: ['threadId', 'id'], processWrite: ['threadId', 'id', 'dataBase64'], processResize: ['threadId', 'id', 'cols', 'rows'], processTerminate: ['threadId', 'id'],
  goalCreate: ['threadId', 'expectedRevision', 'objective', 'tokenBudget', 'maxTurns', 'maxActiveSeconds', 'inferLimits'],
  goalUpdate: ['threadId', 'expectedRevision', 'goalId', 'objective', 'tokenBudget', 'maxTurns', 'maxActiveSeconds', 'inferLimits'],
  goalPause: ['threadId', 'expectedRevision', 'goalId'], goalResume: ['threadId', 'expectedRevision', 'goalId'], goalClear: ['threadId', 'expectedRevision', 'goalId'],
};
const reads = {
  mcpFormResourcePrepare: ['areal/mcp/form/resource/prepare', ['threadId', 'requestId', 'fieldName']],
  mcpFormResourceRelease: ['areal/mcp/form/resource/release', ['threadId', 'requestId', 'fieldName', 'uri']],
  pluginHooks:['areal/plugin/hooks/list',[]], pluginMcp: ['areal/plugin/mcp/list', []], mcpApps: ['areal/mcp/apps/list', ['threadId']], genUiSource: ['areal/genUi/source', ['threadId','turnId','itemId','path']], mcpForms: ['areal/mcp/forms/list', ['threadId']], mcpToolResult:['areal/mcp/tool/result',['threadId','callId']], plugins: ['areal/plugin/list', []], plugin: ['areal/plugin/read', ['id']],
  providers: ['areal/provider/list', []], mcp: ['areal/mcp/list', []],
  profile: ['areal/profile/read', ['id', 'revision']], skills: ['areal/skill/list', ['threadId', 'agentProfile']],
  skill: ['areal/skill/read', ['threadId', 'agentProfile', 'skill', 'resource', 'offset', 'maxBytes']],
  inspect: ['areal/thread/inspect', ['threadId']], context: ['areal/context/read', ['threadId', 'offset', 'limit']],
  inheritedHistory: ['areal/conversation/history', ['threadId', 'view', 'cursor', 'maxBytes']],
  plan: ['areal/plan/read', ['threadId']], processes: ['areal/process/list', ['threadId']],
  process: ['areal/process/get', ['threadId', 'id']],
  processWait: ['areal/process/wait', ['threadId', 'id', 'timeoutMs']],
  goal: ['areal/goal/get', ['threadId']],
  permissions: ['areal/permissions/read', ['threadId']],
  interactions: ['areal/interaction/list', ['threadId']],
  processOutput: ['areal/process/read', ['threadId', 'id', 'after', 'maxBytes', 'waitMs']],
  executions: ['areal/execution/list', ['parentThreadId', 'offset', 'limit']],
  execution: ['areal/execution/read', ['parentThreadId', 'executionId', 'offset']],
  executionArtifact: ['areal/execution/artifact', ['parentThreadId', 'executionId', 'path', 'offset']],
  executionWait: ['areal/execution/wait', ['parentThreadId', 'executionId', 'timeoutMs']],
  agents: ['areal/agent/list', ['parentThreadId', 'cursor', 'limit']],
  agentWait: ['areal/agent/wait', ['parentThreadId', 'threadIds', 'timeoutMs']],
  workflows: ['areal/workflow/list', []], server: ['areal/server/status', []],
  workflow: ['areal/workflow/read', ['id', 'revision']],
  workgroupPolicy: ['areal/workgroup/policy', []], workgroups: ['areal/workgroup/list', []],
  workgroup: ['areal/workgroup/read', ['id']], workgroupWait: ['areal/workgroup/wait', ['id', 'afterRevision', 'timeoutMs']],
  workgroupArtifact: ['areal/workgroup/artifact', ['id', 'path', 'offset']],
};
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
async function manage(backend, project, request, context = {}) {
  const { operation } = request;
  if (operation === 'mcpFormResourceSubmission') {
    const method = 'areal/mcp/form/resource/stage';
    if (typeof request.requestId !== 'string' || !request.requestId.trim()) throw new Error('Missing upload submission ID');
    return backend.readSubmission(project, method, { requestId: request.requestId });
  }
  if (operation === 'pluginSubmission') {
    const method = mutations[request.mutation];
    if (!['pluginArchiveImport', 'marketplaceAdd', 'marketplaceAddGit', 'marketplaceRemove', 'marketplaceUpdate', 'pluginResolve', 'pluginConnection', 'pluginHooksConfigure', 'hookAcknowledge', 'pluginAuthConfigure', 'connectorConfigure', 'pluginInstall', 'pluginConfigure', 'pluginComponentConfigure', 'pluginUninstall', 'pluginSetup'].includes(request.mutation)
      || typeof request.requestId !== 'string' || !request.requestId.trim()) throw new Error('缺少原插件提交标识');
    const receipt = await backend.readSubmission(project, method, { requestId: request.requestId, ...(request.threadId ? { threadId: request.threadId } : {}) });
    if (!receipt.confirmed) return receipt;
    const { result, error } = receipt;
    let warning;
    if (!error && request.mutation === 'pluginSetup' && result?.thread?.id) {
      try {
        await backend.openThread(project, result.thread.id);
        await backend.listThreads(project);
      } catch (cause) { warning = `设置已受理，刷新对话失败：${cause.message}`; }
    }
    backend.onChange();
    return { ...receipt, ...(warning ? { warning } : {}) };
  }
  if (operation === 'pluginAuthCredential') return configurePluginAuthentication(backend,project,request);
  if (operation === 'connectorCredential') {
    if (request.provider !== 'github' || typeof request.secret !== 'string' || !request.secret.trim() || typeof request.requestId !== 'string' || !request.requestId) throw new Error('请填写 GitHub 凭据和提交标识');
    if (backend.providerUpdating || backend.resourcesUpdating || backend.starting.size || backend.hasWork()) throw new Error('请等待任务和操作完成后保存凭据');
    backend.providerUpdating = true;
    try {
      // Reuse the encrypted credential owner. Core receives secrets only through trusted launch inputs.
      const reference = await backend.providers.config.credential(request.secret);
      const drained = await project.client.request('areal/server/drain', {strategy:'ifIdle', timeoutMs:30000}, {timeoutMs:35000});
      if (!drained.restartSafe) throw new Error('后台仍有未结算任务，请等待后重试');
      await backend.restartProject(project);
      const credentialRef = reference.replace(/^AREAL_CREDENTIAL_/, '');
      const result = await backend.submit(project, 'areal/plugin/connector/configure', {...pick(request,['id','connectorId','provider','expectedDigest']),credentialRef}, {requestId:request.requestId});
      return {...result, credentialRef};
    } finally { backend.providerUpdating = false; }
  }
  if (operation === 'pluginAuth' || ['mcpAppOpen','mcpAppOpenFromResult','mcpAppRequest','mcpAppClose','mcpExtensionCall','mcpFormRespond','mcpFormPreview'].includes(operation)) {
    const [method, keys] = {
      pluginAuth:['areal/plugin/auth',['id','server','operation']],
      mcpAppOpenFromResult:['areal/mcp/app/openFromResult',['threadId','turnId','itemId','requestId']],
      mcpAppOpen:['areal/mcp/app/open',['threadId','serverId','expectedGeneration','toolName','arguments','requestId','fileResource','deepLink']],
      mcpAppRequest:['areal/mcp/app/request',['threadId','instanceId','generation','request','requestId']],
      mcpAppClose:['areal/mcp/app/close',['threadId','instanceId','generation']],
      mcpExtensionCall:['areal/mcp/extension/call',['threadId','serverId','expectedGeneration','kind','arguments','requestId']],
      mcpFormRespond:['areal/mcp/form/respond',['threadId','requestId','response']],
      mcpFormPreview:['areal/mcp/form/preview',['threadId','requestId','target']],
    }[operation];
    const params=pick(request,keys);
    if (operation === 'pluginAuth') params.operation=request.authOperation;
    const client = project.client;
    if (operation === 'mcpAppOpen') {
      // Manual opens execute a tool turn, so bind the existing tools before submitting it.
      await backend.readObservation(project, request.threadId, { client, resume: true });
      backend.requireConnection(project, client);
    }
    try {
      const result = await client.request(method,params,{timeoutMs:120000});
      if (operation === 'mcpAppOpen' || operation === 'mcpAppOpenFromResult')
        context.onMcpAppOpened?.(project, client, request, result);
      return result;
    }
    catch (error) { if (typeof error.code !== 'number' || error.code === -32603) {error.submissionUnknown=true;error.message=`操作结果待核对，不会自动重发。${error.message}`;} throw error; }
  }
  if (operation === 'pluginReadiness') {
    if (typeof request.id !== 'string' || !request.id.trim() || typeof request.expectedDigest !== 'string' || !request.expectedDigest.trim()) throw new Error('Missing installed plugin snapshot');
    const detail = await project.client.request('areal/plugin/read', {id: request.id});
    if (detail.id !== request.id || !detail.installed || detail.installedDigest !== request.expectedDigest) throw new Error('Installed plugin snapshot changed; refresh plugin details');
    if (!detail.enabled) throw new Error('Plugin is disabled in this project');
    const disabledSkills = new Set(detail.componentChoices?.disabledSkills ?? []);
    const requiredTools = [...new Set((detail.installedSkills ?? []).filter(skill => !disabledSkills.has(skill.id)).flatMap(skill => skill.requiredTools ?? []))].sort();
    const deployed = new Set(backend.desktopTools(project).map(tool => tool.name));
    const missingTools = requiredTools.filter(name => !deployed.has(name));
    return {pluginId: detail.id, installedDigest: detail.installedDigest, requiredTools, missingTools, available: missingTools.length === 0};
  }
  if (operation === 'pluginCapabilities') return { enabled: project.client.capabilities?.methods?.includes('areal/plugin/list') === true };
  if (operation === 'executionCancel') return project.client.request('areal/execution/cancel', pick(request, ['parentThreadId', 'executionId', 'mode']));
  // Core 管理整组交付与未知结果恢复，客户端不会自动重放写入。
  if (operation === 'executionApply') return project.client.request('areal/execution/apply', pick(request, ['parentThreadId', 'executionId']));
  if (operation === 'serverDrain' || operation === 'serverGc') {
    // These Core methods have no receipt. Never use the receipt-based submission journal.
    try {
      return await project.client.request(operation === 'serverDrain' ? 'areal/server/drain' : 'areal/server/gc',
        operation === 'serverDrain' ? { strategy: 'ifIdle', timeoutMs: 30_000 } : {}, { timeoutMs: 35_000 });
    } catch (error) {
      if (typeof error.code !== 'number' || error.code === -32603) {
        error.submissionUnknown = true;
        error.message = `维护操作结果待核对，不会自动重发。${error.message}`;
      }
      throw error;
    }
  }
  if (operation === 'workgroupApplyArtifact' || operation === 'workgroupArtifactStatus') return workgroupArtifactFile(project, request, operation === 'workgroupApplyArtifact');
  if (operation === 'workgroupSubmission') {
    if (typeof request.requestId !== 'string' || !request.requestId) throw new Error('缺少原提交标识');
    const receipt = await backend.recoverWorkgroupSubmission(project, request.requestId);
    return receipt ? { confirmed: true, ...receipt } : { confirmed: false };
  }
  if (operation === 'workgroupCapabilities') return { enabled: project.client.capabilities?.methods?.includes('areal/workgroup/start') === true };
  if (['workgroupStart', 'workflowStart', 'workgroupRevise'].includes(operation)) {
    const definition = {
      workgroupStart: ['areal/workgroup/start', ['plan', 'workers', 'admission']],
      workflowStart: ['areal/workflow/start', ['workflow', 'workers', 'admission']],
      workgroupRevise: ['areal/workgroup/revise', ['id', 'expectedRevision', 'plan']],
    }[operation];
    const value = await backend.submit(project, definition[0], pick(request, definition[1]), { requestId: request.requestId });
    return { id: value.id, record: value.record, historyCount: value.historyCount, verificationCount: value.verificationCount };
  }
  // Cancel has no requestId. Core owns cancellation and cleanup; never replay it.
  if (operation === 'workgroupCancel') {
    const value = await project.client.request('areal/workgroup/cancel', pick(request, ['id']));
    return { id: value.id, record: value.record, historyCount: value.historyCount, verificationCount: value.verificationCount };
  }
  if (taskOperations.has(operation)) return manageTask(backend, project, request);
  if (operation === 'closeResources') {
    if (typeof request.threadId !== 'string' || !request.threadId) throw new Error('缺少资源所属会话');
    // Core owns the resource gate and may partially clean before refusing.
    // This method has no receipt: never enter the submission replay journal.
    try {
      return await project.client.request('areal/thread/closeResources', { threadId: request.threadId });
    } catch (error) {
      if (typeof error.code !== 'number' || error.code === -32603) error.submissionUnknown = true;
      throw error;
    }
  }
  if (operation === 'processSubmission') {
    if (typeof request.threadId !== 'string' || !request.threadId || typeof request.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(request.requestId)) throw new Error('缺少原终端请求标识或任务');
    const result = await backend.recoverProcessSubmission(project, request.threadId, request.requestId);
    if (!result) return { confirmed: false };
    const presentation = await resolveTerminalPresentation(backend.library?.value.settings, backend.userHome);
    return { confirmed: true, result: { ...result, shell: shellFromManagedArgv(result.argv), ...presentation } };
  }
  if (operation === 'agentSubmission') {
    if (typeof request.parentThreadId !== 'string' || !request.parentThreadId || typeof request.requestId !== 'string' || !request.requestId) throw new Error('缺少原创建请求标识或父任务');
    const receipt = await backend.recoverAgentSubmission(project, request.parentThreadId, request.requestId);
    return receipt ? { confirmed: true, ...receipt } : { confirmed: false };
  }
  if (operation === 'agentSpawn') {
    if (typeof request.parentThreadId !== 'string' || !request.parentThreadId) throw new Error('缺少父任务');
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new Error('请输入子任务指令');
    const result = await backend.submit(project, 'areal/agent/spawn', {
      // threadId belongs only to the desktop submission journal. Core has no
      // public spawn receipt; requestSubmission strips both journal fields.
      threadId: request.parentThreadId, parentThreadId: request.parentThreadId,
      input: [{ type: 'text', text: request.prompt }], workspaceMode: 'sharedReadOnly',
      ...pick(request, ['agentProfile', 'model', 'instructions', 'skills', 'toolAllowlist']),
    }, { requestId: request.requestId });
    try {
      await backend.openThread(project, result.threadId);
      await backend.listThreads(project);
    } catch (error) { project.error = `子任务已创建，刷新失败：${error.message}`; }
    backend.onChange();
    return result;
  }
  if (reads[operation]) {
    const [method, keys] = reads[operation];
    const result = await project.client.request(method, pick(request, keys));
    if (operation === 'goal') project.model.setGoal(request.threadId, result);
    if (operation === 'plan') project.model.setPlan(request.threadId, result);
    if (operation === 'interactions') project.model.setInteractions(request.threadId, result);
    if (operation === 'workgroup' || operation === 'workgroupWait') return { id: result.id, record: result.record, historyCount: result.historyCount, verificationCount: result.verificationCount };
    return result;
  }
  if (operation === 'planUpdate') {
    // Plan updates use optimistic revisions, not request receipts. Never replay.
    try {
      const result = await project.client.request('areal/plan/update', pick(request, ['threadId', 'expectedRevision', 'steps']));
      project.model.setPlan(request.threadId, result);
      return result;
    } catch (error) {
      const current = await project.client.request('areal/plan/read', { threadId: request.threadId }).catch(() => null);
      if (current) project.model.setPlan(request.threadId, current);
      throw error;
    }
  }
  if (operation === 'toolAcknowledge') {
    if (typeof request.threadId !== 'string' || !request.threadId || typeof request.itemId !== 'string' || !request.itemId) throw new Error('缺少原会话或执行项');
    if (typeof request.inspection !== 'string' || !request.inspection.trim() || Buffer.byteLength(request.inspection, 'utf8') > 1024) throw new Error('核查说明应包含 1–1024 个 UTF-8 字节');
    const refresh = async () => {
      await project.client.request('thread/read', { threadId: request.threadId, includeTurns: true }, {
        onResult: result => project.model.replace(result.thread),
      });
      backend.onChange();
    };
    // This public method has no request receipt. Never send it through the
    // mutation replay journal or confuse it with process cleanup acknowledgement.
    try {
      await project.client.request('areal/tool/acknowledge', pick(request, ['threadId', 'itemId', 'inspection']));
    } catch (error) {
      await refresh().catch(() => {});
      throw error;
    }
    await refresh();
    return {};
  }
  if (operation === 'contextCompact') {
    const client = project.client;
    const refresh = async () => {
      const result = await client.request('thread/read', { threadId: request.threadId, includeTurns: true });
      backend.requireConnection(project, client);
      if (result.thread?.id !== request.threadId) throw new Error('压缩后的会话身份不匹配');
      project.model.replace(result.thread);
      backend.onChange();
    };
    let result;
    try { result = await client.request('areal/context/compact', pick(request, ['threadId'])); }
    catch (error) { await refresh().catch(() => {}); throw error; }
    await refresh();
    return result;
  }
  // Scope-wide forgetting has no request receipt and must never be replayed.
  if (operation === 'permissionsForget') {
    if (typeof request.project !== 'boolean') throw new Error('请选择撤销授权的作用域');
    return project.client.request('areal/permissions/forget', pick(request, ['threadId', 'project']));
  }
  if (operation === 'providerProbe') return project.client.request('areal/provider/probe', pick(request, ['id', 'model']));
  const method = mutations[operation];
  if (!method) throw new Error('不支持的管理操作');
  if (threadMutationMethods.has(method)) {
    if (typeof request.threadId !== 'string' || !request.threadId || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw new Error('目标缺少有效的会话或版本，请刷新后重试');
    if (operation !== 'goalCreate' && (typeof request.goalId !== 'string' || !request.goalId)) throw new Error('缺少目标 ID');
    if (operation === 'goalCreate' || request.objective !== undefined) {
      if (typeof request.objective !== 'string' || !request.objective.trim() || [...request.objective].length > 4000) throw new Error('目标应包含 1–4000 个字符');
    }
    if (request.inferLimits !== undefined && typeof request.inferLimits !== 'boolean') throw new Error('目标限制解析标识无效');
    for (const key of ['tokenBudget', 'maxTurns', 'maxActiveSeconds']) {
      if (request[key] !== undefined && request[key] !== null && (!Number.isSafeInteger(request[key]) || request[key] <= 0)) throw new Error('目标预算必须为正整数');
    }
  }
  let terminal;
  if (operation === 'processStart') {
    if (request.terminal !== undefined && typeof request.terminal !== 'boolean') throw new Error('无效终端启动标识');
    if (request.terminal === true) {
      if (request.argv !== undefined || request.tty !== true) throw new Error('登录终端需要 tty，且不能同时指定 argv');
      terminal = loginTerminalCommand();
    }
  }
  let result;
  try {
    if (operation === 'goalCreate' || operation === 'goalResume') await backend.providers.refreshGoalTransport(project, request.threadId);
    result = await backend.submit(project, method, { ...pick(request, fields[operation]), ...(terminal ? { argv: terminal.argv } : {}) }, { requestId: request.requestId });
  }
  catch (error) {
    if (threadMutationMethods.has(method)) {
      // Refresh a conflict/unknown result, never retry the mutation with a new revision.
      const state = await project.client.request('areal/goal/get', { threadId: request.threadId }).catch(() => null);
      if (state) project.model.setGoal(request.threadId, state);
    }
    throw error;
  }
  if (threadMutationMethods.has(method)) project.model.setGoal(request.threadId, result);
  try {
  if (operation === 'pluginSetup' && result.thread?.id) {
    await backend.openThread(project, result.thread.id);
    await backend.listThreads(project);
  }
  if (operation.startsWith('provider')) {
    const models = await project.client.request('areal/model/list');
    project.models = models.data ?? [];
  }
  if (operation === 'archive' || operation === 'unarchive') {
    const snapshot = await project.client.request('thread/read', { threadId: request.threadId, includeTurns: true });
    project.model.replace(snapshot.thread);
    await backend.listThreads(project);
  }
  } catch (error) { if (request.threadId) backend.observationFailure(project, request.threadId, error); }
  backend.onChange();
  return terminal ? { ...result, shell: terminal.shell, ...await resolveTerminalPresentation(backend.library?.value.settings, backend.userHome) } : result;
}
module.exports = { manage, managementMethods, threadMutationMethods };
