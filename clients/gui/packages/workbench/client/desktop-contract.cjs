'use strict';

/** @typedef {{message:string, code?:string|number, reason?:string, submissionUnknown?:boolean, requestId?:string, delivery?:'resultUnavailable', outcome?:import('../../runtime-client/core.js').FailureOutcome, recovery?:import('../../runtime-client/core.js').Recovery}} DesktopError */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:DesktopError}} DesktopResult */
/** @typedef {{id:string,revision:string}} ResourceRef */
/** @typedef {{projectId:string,profile?:ResourceRef}} PrepareCreatorRequest */
/** @typedef {{sourceRoot?:string,ref?:string,worktreeRoot?:string,branch?:string,branchPrefix?:string,environmentId?:string,environmentRevision?:number,mode?:'source'|'worktree'}} WorktreeSpec */
/** @typedef {{projectId:string,threadId:string,requestId?:string,expectedRevision?:number,model?:{providerId:string,modelId:string}|null,profile?:ResourceRef,options?:Record<string,unknown>,parameters?:Record<string,unknown>,selectedSkills?:ResourceRef[]}} ConfigureRequest */
/** @typedef {{projectId:string,operation:'start',sourceThreadId:string,requestId:string,text:string,workspaceAccess:'none'|'readOnly',model?:{providerId:string,modelId:string},resetModel?:boolean,anchor?:Record<string,unknown>|null,selection?:Record<string,unknown>|null,parameters?:Record<string,unknown>}|{projectId:string,operation:'create',sourceThreadId:string,requestId:string,firstInput?:{text:string}}|{projectId:string,operation:'close',threadId:string,requestId:string}|{projectId:string,operation:'recover',requestId:string,sourceThreadId?:string,threadId?:string,method?:'areal/side/start'|'areal/side/create'|'areal/side/close'}|{projectId:string,operation:'send',threadId:string,text:string}|{projectId:string,operation:'context',threadId:string,cursor?:string,evidenceRef?:string,maxBytes?:number}|{projectId:string,operation:'list',sourceThreadId:string,includeArchived?:boolean,cursor?:string}} SideRequest */
/** @typedef {{projectId:string,threadId:string,expectedTurnId:string,expectedConfigRevision?:number,requestId?:string}} ContinueRequest */
/** @typedef {{projectId:string,sourceThreadId:string,requestId?:string,workspaceMode:'sharedCurrent',anchor:{turnId:string,boundary:'before'|'after'},target?:Record<string,unknown>}} ForkRequest */
/** @typedef {{projectId:string,threadId:string,viewId:string,operation:'acquire'|'loadOlder'|'release'}|{projectId:string,threadId:string,viewId:string,operation:'loadItem',itemId:string}} HistoryRequest */

/** @typedef {{operation:'status'|'retry'}|{operation:'setEnabled',enabled:boolean,expectedRevision:string}} TrajectoryRequest */
/** @typedef {{id:string,status:'pending'|'uploading'|'failed'|'uploaded'|'evicted',created_at:number,uploaded_at:number|null,attempts:number,next_attempt_at:number|null,bytes:number,error:string|null,turn_id?:string|null,event_name?:string|null,model_name?:string|null,harness_version?:string|null,execution_duration_ms?:number|null,model_call_duration_ms?:number|null,occurred_at?:number|null}} TrajectoryRecord */
/** @typedef {{scope:'recent_records',record_limit:100,records_considered:number,model_calls:number,total_duration_ms:number|null,mean_duration_ms:number|null,max_duration_ms:number|null}} TrajectoryModelCallSummary */
/** @typedef {{enabled:boolean,config_revision?:string,capture_apply_pending?:boolean,capture_apply_error?:string|null,state:'disabled'|'ready'|'degraded'|'invalid',endpoint:string,configPath:string|null,spool_dir:string,worker_running:boolean,queue:{pending:number,uploading:number,failed:number,uploaded:number,evicted:number,bytes:number,max_bytes:number,dropped_memory:number,dropped_oversize:number},last_error:string|null,last_success_at:number|null,records:TrajectoryRecord[],model_call_summary?:TrajectoryModelCallSummary,limits:{max_retries:number,upload_interval_ms:number,max_memory_bytes:number}}} TrajectoryStatus */

/** @typedef {{effect:'read'|'subscription'|'mutation',requestId?:'requestId'|'draftId'}} CommandEffect */
/** @type {CommandEffect} */
const read = Object.freeze({ effect: 'read' });
/** @type {CommandEffect} */
const subscription = Object.freeze({ effect: 'subscription' });
/** @type {CommandEffect} */
const mutation = Object.freeze({ effect: 'mutation' });
/** @type {CommandEffect} */
const recoverable = Object.freeze({ effect: 'mutation', requestId: 'requestId' });
/** @param {CommandEffect} semantics @param {string} names */
const operations = (semantics, names) => Object.fromEntries(names.split(' ').map(name => [name, semantics]));
const commandDefinitions = Object.freeze({
  connect: ['service', 'project', subscription], list: ['service', 'project', read], open: ['service', 'thread', subscription],
  history: ['service', 'thread', operations(read, 'acquire loadOlder loadItem release')],
  create: ['service', 'project', recoverable], prepareCreator: ['service', 'project', mutation], fork: ['service', 'project', recoverable],
  side: ['service', 'project', { ...operations(read, 'recover context list'), ...operations(recoverable, 'start send create close') }],
  prediction: ['service', 'thread', mutation],
  send: ['service', 'thread', recoverable], editMessage: ['service', 'thread', recoverable], continue: ['service', 'thread', recoverable], stop: ['service', 'thread', recoverable],
  attachBrowser: ['service', 'thread', recoverable], respond: ['service', 'thread', mutation], reconcile: ['service', 'project', read], configure: ['service', 'thread', recoverable],
  queue: ['service', 'thread', read], queueEdit: ['service', 'thread', recoverable],
  library: ['service', 'app', operations(mutation, 'dropSidebar renameProject renameThread pinThread pinProject createSection renameSection removeSection orderSection moveThread moveProject readThread markAllRead orderSidebarThread hideProject orderProject orderThread settings')],
  manage: ['service', 'project', {
    ...operations(read, 'pluginHooks pluginMcp mcpApps genUiSource mcpForms mcpToolResult plugins plugin providers mcp profile skills skill inspect context inheritedHistory plan processes process processWait goal permissions interactions processOutput executions execution executionArtifact executionWait agents agentWait workflows server workflow workgroupPolicy workgroups workgroup workgroupWait workgroupArtifact workgroupArtifactStatus workgroupCapabilities workgroupSubmission pluginCapabilities pluginReadiness pluginSubmission processSubmission agentSubmission mcpFormResourceSubmission tasks task taskInbox taskChannel taskDraftHistory taskDraftRead taskSchedulePreview taskScheduleContext taskHistoryCapabilities taskRuns taskRun'),
    ...operations(subscription, 'taskWatch taskUnwatch'),
    ...operations(recoverable, 'pluginArchiveImport mcpFormResourceStage pluginHooksConfigure hookAcknowledge marketplaceAdd marketplaceAddGit marketplaceRemove marketplaceUpdate pluginResolve pluginAuthConfigure pluginConnection connectorConfigure connectorCredential pluginInstall pluginConfigure pluginComponentConfigure pluginUninstall pluginSetup providerSave providerRemove mcpSave mcpConnect mcpDisconnect archive unarchive processCloseStdin processStart processWrite processResize processTerminate goalCreate goalUpdate goalPause goalResume goalClear workgroupStart workflowStart workgroupRevise agentSpawn taskCreate taskUpdate taskRunNow taskPause taskResume taskStopRun taskResumeRun taskCancel taskDelete taskReply taskDraftSend'),
    ...operations(mutation, 'pluginArchivePick pluginAuth pluginAuthCredential mcpAppOpen mcpAppOpenFromResult mcpAppRequest mcpAppClose mcpExtensionCall mcpFormRespond mcpFormPreview mcpFormResourcePrepare mcpFormResourceRelease executionCancel executionApply serverDrain serverGc workgroupApplyArtifact workgroupCancel closeResources planUpdate toolAcknowledge contextCompact permissionsForget providerProbe taskDraftConfirm'),
    taskDraftStart: { effect: 'mutation', requestId: 'draftId' },
  }],
  workspace: ['service', 'project', { ...operations(read, 'worktreeList worktreeOptions worktreeRead list search read review reviewCommits reviewBranches turnReview status info gitState'), ...operations(recoverable, 'worktreeCreate worktreeAction worktreeDelete'), ...operations(mutation, 'worktreeSettings worktreeEnvironmentSave worktreeEnvironmentDelete worktreeCancel worktreeOpen save gitStage gitUnstage gitCommit gitPush') }],
  media: ['service', 'thread', { ...operations(read, 'list read'), upload: mutation, release: recoverable }],
  steer: ['service', 'thread', recoverable], dismissRecovery: ['service', 'project', mutation],
  providers: ['service', 'app', { ...operations(read, 'list revealKey discover'), ...operations(mutation, 'probe apply save saveAndApply removeAndApply defaultAndApply remove default') }],
  chatgpt: ['service', 'app', operations(mutation, 'status login forget logout selectAccount cancel probe')],
  analytics: ['service', 'app', { ...operations(read, 'read sync') }],
  resources: ['service', 'app', { ...operations(read, 'hooks builtinSkill skills mcp skillRead'), ...operations(mutation, 'hooksSave skillToggle skillSave mcpSave mcpConnect mcpDisconnect') }],
  projectless: ['service', 'app', { directory: mutation, prepare: recoverable }], tasks: ['service', 'app', operations(read, 'list inbox preview')],
  trajectory: ['service', 'app', { status: read, ...operations(mutation, 'retry setEnabled') }],
  feedback: ['service', 'app', { ...operations(read, 'status read'), ...operations(mutation, 'preference prepare draft refine submit close') }],
  serviceLifecycle: ['main', 'app', { check: read, ...operations(mutation, 'update stop recover quitInterface stopAndQuit') }],
  serviceStatus: ['main', 'app', read], stopService: ['main', 'app', mutation], recoverResources: ['main', 'app', mutation],
  browserData: ['main', 'app', { status: read, ...operations(mutation, 'importChrome clearCache clearAll') }],
  computerControl: ['main', 'app', { status: read, ...operations(mutation, 'requestAccess openSettings restart stop') }],
  exportDiagnostics: ['main', 'app', read], connectService: ['main', 'app', subscription], export: ['main', 'thread', read], remoteControl: ['main', 'app', mutation],
});
/** @param {string} name @param {Record<string,unknown>} request @returns {CommandEffect} */
function commandSemantics(name, request) {
  const definition = commandDefinitions[/** @type {CommandName} */ (name)];
  if (!definition) invalid();
  const declared = /** @type {CommandEffect|Record<string,CommandEffect>} */ (definition[2]);
  const selected = typeof declared.effect === 'string' ? declared : declared[String(request.operation)];
  if (!selected || !['read', 'subscription', 'mutation'].includes(selected.effect)) invalid();
  return /** @type {CommandEffect} */ (selected);
}
/** @typedef {keyof typeof commandDefinitions} CommandName */
/** @template {CommandName} N @typedef {N extends 'history' ? HistoryRequest : N extends 'serviceLifecycle' ? {operation:'update'|'stop'|'check'|'recover'|'quitInterface'|'stopAndQuit'} : N extends 'stop' ? {projectId:string,threadId:string,turnId:string,requestId:string} : N extends 'continue' ? ContinueRequest : N extends 'prepareCreator' ? PrepareCreatorRequest : N extends 'fork' ? ForkRequest : N extends 'configure' ? ConfigureRequest : N extends 'side' ? SideRequest : N extends 'trajectory' ? TrajectoryRequest : Record<string,unknown>} CommandParams */
/** @typedef {'show'|'navigate'|'back'|'forward'|'reload'|'stop'|'state'|'external'|'devtools'|'openLink'|'release'|'claim'|'takeover'|'captureRegion'|'captureElement'|'selectElement'|'cancelElementSelection'|'checkElement'|'endRegion'|'beginStyleTrial'|'applyStyleTrial'|'undoStyleTrial'|'redoStyleTrial'|'styleTrialState'|'captureStyleTrialAfter'|'clearStyleTrial'|'newPage'|'selectPage'|'subscribe'|'unsubscribe'|'allowNextDownload'|'cancelFileHandoff'|'cancelDownload'|'authorizeFrameOrigin'|'reloadFrameOrigin'|'revokeFrameOrigin'} OwnedPreviewOperation */
/** @typedef {{operation:'hide',projectId?:string,threadId?:string,pageId?:string,captureId?:string}|{operation:OwnedPreviewOperation,projectId:string,threadId:string,pageId?:string,captureId?:string,x?:number,y?:number,elementId?:string,trialId?:string,property?:string,value?:string,downloadId?:string,url?:string,userIntent?:boolean,visible?:boolean,bounds?:{x:number,y:number,width:number,height:number}}} PreviewRequest */
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** @param {unknown} value @returns {value is string} */
function identifier(value) { return typeof value === 'string' && !!value.trim() && value.length <= 256; }
/** @returns {never} */
function invalid() { throw Object.assign(new Error('无效桌面操作或参数'), { code: 'INVALID_DESKTOP_REQUEST' }); }
/** @param {unknown} value */
function resource(value) { return record(value) && identifier(value.id) && identifier(value.revision); }

/** @param {string} name @param {unknown} params @param {{serviceOnly?:boolean}} [options] */
function validateCommand(name, params, { serviceOnly = false } = {}) {
  if (!Object.hasOwn(commandDefinitions, name) || !record(params)) invalid();
  const [layer, scope] = commandDefinitions[/** @type {CommandName} */ (name)];
  if (serviceOnly && layer !== 'service') invalid();
  if (scope !== 'app' && !(name === 'workspace' && ['worktreeList','worktreeSettings'].includes(String(params.operation))) && !identifier(params.projectId)) invalid();
  if (scope === 'thread' && !identifier(params.threadId)) invalid();
  if (name === 'prediction' && (!identifier(params.sourceTurnId) || !['request', 'cancel'].includes(String(params.operation))
    || Object.keys(params).some(key => !['projectId', 'threadId', 'sourceTurnId', 'operation'].includes(key)))) invalid();
  if (name === 'history' && (!identifier(params.viewId) || !['acquire', 'loadOlder', 'loadItem', 'release'].includes(String(params.operation))
    || params.operation === 'loadItem' && !identifier(params.itemId)
    || Object.keys(params).some(key => !['projectId', 'threadId', 'viewId', 'operation', ...(params.operation === 'loadItem' ? ['itemId'] : [])].includes(key)))) invalid();
  if (name === 'browserData' && Object.keys(params).some(key => key !== 'operation')) invalid();
  if (name === 'computerControl' && (Object.keys(params).some(key => !['operation', 'capability'].includes(key))
    || (['requestAccess', 'openSettings'].includes(String(params.operation))
      ? !['accessibility', 'screenRecording', 'inputMonitoring'].includes(String(params.capability))
      : params.capability !== undefined))) invalid();
  if (name === 'exportDiagnostics' && Object.keys(params).length !== 0) invalid();
  if (name === 'serviceLifecycle' && (!['update', 'stop', 'check', 'recover', 'quitInterface', 'stopAndQuit'].includes(String(params.operation))
    || Object.keys(params).some(key => key !== 'operation'))) invalid();
  if (name === 'stop' && (!identifier(params.turnId) || typeof params.requestId !== 'string'
    || !/^[0-9a-f-]{36}$/.test(params.requestId)
    || Object.keys(params).some(key => !['projectId', 'threadId', 'turnId', 'requestId'].includes(key)))) invalid();
  if (name === 'prepareCreator' && (Object.keys(params).some(key => !['projectId', 'profile'].includes(key))
    || params.profile !== undefined && (!record(params.profile) || !resource(params.profile) || Object.keys(params.profile).some(key => !['id', 'revision'].includes(key))))) invalid();
  if (params.conversationQuotes !== undefined && (!['send', 'editMessage', 'steer', 'queueEdit'].includes(name)
    || !Array.isArray(params.conversationQuotes) || params.conversationQuotes.length > 8
    || params.conversationQuotes.some(quote => !record(quote) || Object.keys(quote).some(key => key !== 'text') || typeof quote.text !== 'string' || !quote.text.trim() || quote.text.length > 8000)
    || params.conversationQuotes.reduce((total, quote) => total + quote.text.length, 0) > 16000)) invalid();
  if (name === 'send' && params.requestId !== undefined && (typeof params.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(params.requestId))) invalid();
  if (name === 'editMessage' && (!identifier(params.expectedTurnId) || !identifier(params.itemId)
    || typeof params.text !== 'string' || !params.text.trim()
    || !Number.isSafeInteger(params.expectedConfigRevision) || Number(params.expectedConfigRevision) < 0
    || typeof params.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(params.requestId)
    || Object.keys(params).some(key => !['projectId', 'threadId', 'expectedTurnId', 'itemId', 'expectedConfigRevision', 'requestId', 'text', 'attachments', 'mcpContent', 'conversationQuotes'].includes(key)))) invalid();
  if (name === 'continue' && (!identifier(params.expectedTurnId)
    || Object.keys(params).some(key => !['projectId', 'threadId', 'expectedTurnId', 'expectedConfigRevision', 'requestId'].includes(key))
    || params.requestId !== undefined && (typeof params.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(params.requestId))
    || params.expectedConfigRevision !== undefined && (!Number.isSafeInteger(params.expectedConfigRevision) || Number(params.expectedConfigRevision) < 0))) invalid();
  if (['create', 'configure', 'fork', 'attachBrowser'].includes(name) && params.requestId !== undefined
    && (typeof params.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(params.requestId))) invalid();
  if (name === 'create' && params.browserEnabled !== undefined && typeof params.browserEnabled !== 'boolean') invalid();
  if (name === 'create' && params.worktree !== undefined) {
    const spec = params.worktree;
    if (!record(spec) || Object.keys(spec).some(key => !['sourceRoot', 'ref', 'worktreeRoot', 'branch', 'branchPrefix', 'environmentId', 'environmentRevision', 'mode'].includes(key))
      || Object.entries(spec).some(([key,value]) => key === 'environmentRevision' ? !Number.isSafeInteger(value) || Number(value) < 0 : typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))
      || spec.mode !== undefined && !['source','worktree'].includes(String(spec.mode))) invalid();
  }
  if (name === 'workspace' && String(params.operation).startsWith('worktree')) {
    const optionalRevision = value => value === undefined || Number.isSafeInteger(value) && Number(value) >= 0;
    const script = value => record(value) && Object.keys(value).every(key => ['default','macos','linux'].includes(key))
      && typeof value.default === 'string' && Object.values(value).every(item => typeof item === 'string' && item.length <= 32768 && !item.includes('\0'));
    const environment = value => record(value) && Object.keys(value).every(key => ['id','name','setup','cleanup','actions'].includes(key))
      && identifier(value.id) && identifier(value.name) && script(value.setup) && script(value.cleanup) && Array.isArray(value.actions) && value.actions.length <= 50
      && new Set(value.actions.map(action => action.id)).size === value.actions.length
      && value.actions.every(action => record(action) && Object.keys(action).every(key => ['id','name','script'].includes(key)) && identifier(action.id) && identifier(action.name) && script(action.script));
    const keys = {
      worktreeList: [], worktreeOptions: ['sourceRoot'], worktreeSettings: ['worktreeRoot','branchPrefix','fetchBeforeCreate','autoCleanup','keepCount','expectedRevision'],
      worktreeEnvironmentSave: ['environment','expectedRevision'], worktreeEnvironmentDelete: ['environmentId','expectedRevision'],
      worktreeCancel: ['requestId'], worktreeRead: ['requestId'], worktreeOpen: ['requestId'],
      worktreeAction: ['requestId','worktreeRequestId','actionId'], worktreeDelete: ['requestId','worktreeRequestId'],
    }[String(params.operation)];
    if (keys && Object.keys(params).some(key => !['projectId','operation',...keys].includes(key))) invalid();
    if (['worktreeCancel','worktreeRead','worktreeOpen','worktreeAction','worktreeDelete'].includes(String(params.operation))
      && (typeof params.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(params.requestId))) invalid();
    if (['worktreeAction','worktreeDelete'].includes(String(params.operation)) && (typeof params.worktreeRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(params.worktreeRequestId))) invalid();
    if (params.operation === 'worktreeAction' && !identifier(params.actionId)) invalid();
    if (params.operation === 'worktreeOptions' && params.sourceRoot !== undefined && (typeof params.sourceRoot !== 'string' || !params.sourceRoot || params.sourceRoot.length > 4096 || /[\x00-\x1f\x7f]/.test(params.sourceRoot))) invalid();
    if (params.operation === 'worktreeSettings' && (typeof params.worktreeRoot !== 'string' || params.worktreeRoot.length > 4096 || /[\x00-\x1f\x7f]/.test(params.worktreeRoot)
      || typeof params.branchPrefix !== 'string' || !params.branchPrefix || params.branchPrefix.length > 128 || /[\x00-\x1f\x7f]/.test(params.branchPrefix)
      || ['fetchBeforeCreate','autoCleanup'].some(key => params[key] !== undefined && typeof params[key] !== 'boolean')
      || params.keepCount !== undefined && (!Number.isSafeInteger(params.keepCount) || Number(params.keepCount) < 1 || Number(params.keepCount) > 1000) || !optionalRevision(params.expectedRevision))) invalid();
    if (['worktreeEnvironmentSave','worktreeEnvironmentDelete'].includes(String(params.operation)) && (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0)) invalid();
    if (params.operation === 'worktreeEnvironmentSave' && !environment(params.environment)) invalid();
    if (params.operation === 'worktreeEnvironmentDelete' && !identifier(params.environmentId)) invalid();
  }
  if (name === 'fork' && (!identifier(params.sourceThreadId) || !record(params.anchor)
    || !identifier(params.anchor.turnId) || !['before', 'after'].includes(String(params.anchor.boundary))
    || params.workspaceMode !== 'sharedCurrent')) invalid();
  if (name === 'side' && (!['start', 'create', 'close', 'recover', 'send', 'context', 'list'].includes(String(params.operation))
    || (params.operation === 'start' && (!identifier(params.sourceThreadId) || typeof params.text !== 'string' || !params.text.trim()))
    || (params.operation === 'send' && (!identifier(params.threadId) || typeof params.text !== 'string' || !params.text.trim()))
    || (params.operation === 'create' && (!identifier(params.sourceThreadId) || !identifier(params.requestId)
      || params.firstInput !== undefined && (!record(params.firstInput) || typeof params.firstInput.text !== 'string' || !params.firstInput.text.trim() || Object.keys(params.firstInput).some(key => key !== 'text'))
      || Object.keys(params).some(key => !['operation', 'projectId', 'sourceThreadId', 'requestId', 'firstInput'].includes(key))))
    || (params.operation === 'close' && (!identifier(params.threadId) || !identifier(params.requestId)
      || Object.keys(params).some(key => !['operation', 'projectId', 'threadId', 'requestId'].includes(key))))
    || (params.operation === 'recover' && (!identifier(params.requestId) || params.method !== undefined && !['areal/side/start', 'areal/side/create', 'areal/side/close'].includes(String(params.method))))
    || (params.operation === 'context' && !identifier(params.threadId))
    || (params.operation === 'list' && (!identifier(params.sourceThreadId) || params.includeArchived !== undefined && typeof params.includeArchived !== 'boolean')))) invalid();
  if (name === 'side' && (params.resetModel !== undefined && typeof params.resetModel !== 'boolean' || params.resetModel === true && params.model !== undefined || params.workspaceAccess !== undefined && !['none', 'readOnly'].includes(String(params.workspaceAccess)) || params.model !== undefined && (!record(params.model) || !identifier(params.model.providerId) || !identifier(params.model.modelId)))) invalid();
  if (name === 'attachBrowser' && (typeof params.expectedToolsetRevision !== 'number'
    || !Number.isSafeInteger(params.expectedToolsetRevision)
    || params.expectedToolsetRevision < 0)) invalid();

  // 导出目标与配置路径只由可信启动配置选择，Renderer 不能扩展 CLI 参数。
  if (name === 'trajectory') {
    const toggling = params.operation === 'setEnabled';
    if ((!toggling && !['status', 'retry'].includes(String(params.operation)))
      || Object.keys(params).some(key => !(toggling ? ['operation','enabled','expectedRevision'] : ['operation']).includes(key))
      || toggling && (typeof params.enabled !== 'boolean' || typeof params.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(params.expectedRevision))) invalid();
  }
  if (name === 'feedback') {
    const operation = String(params.operation);
    if (!['status','preference','prepare','read','draft','refine','submit','close'].includes(operation)) invalid();
    const fields = ['operation', ...(operation === 'preference' ? ['enabled'] : operation === 'status' ? [] :
      ['projectId','threadId', ...(operation === 'prepare' ? ['turnId','itemId','rating'] : ['id']),
        ...(['draft','refine','submit'].includes(operation) ? ['rating','reason','analysis','analysisItemId'] : []),
        ...(operation === 'refine' ? ['text'] : [])])];
    if (Object.keys(params).some(key => !fields.includes(key))) invalid();
    if (operation === 'preference' && typeof params.enabled !== 'boolean') invalid();
    if (!['status','preference'].includes(operation) && (!identifier(params.projectId) || !identifier(params.threadId))) invalid();
    if (operation === 'prepare' && (!identifier(params.turnId) || !identifier(params.itemId) || !['up','down'].includes(String(params.rating)))) invalid();
    if (!['status','preference','prepare'].includes(operation) && !identifier(params.id)) invalid();
    if (params.rating !== undefined && !['up','down'].includes(String(params.rating))) invalid();
    if (params.analysisItemId !== undefined && (typeof params.analysisItemId !== 'string' || params.analysisItemId.length > 256)) invalid();
    for (const [key, max] of /** @type {[string,number][]} */ ([['reason',32768],['analysis',65536],['text',16384]])) {
      if (params[key] !== undefined && (typeof params[key] !== 'string' || new TextEncoder().encode(/** @type {string} */ (params[key])).length > max)) invalid();
    }
  }
  if (['manage', 'workspace', 'media', 'queueEdit', 'library', 'providers', 'chatgpt', 'analytics', 'resources', 'projectless', 'tasks', 'remoteControl'].includes(name)
    && !identifier(params.operation)) invalid();
  if (name === 'providers' && params.operation === 'revealKey'
    && (!identifier(params.id) || !identifier(params.expectedRevision)
      || Object.keys(params).some(key => !['operation', 'id', 'expectedRevision'].includes(key)))) invalid();
  if (name === 'tasks' && (!['list', 'inbox', 'preview'].includes(String(params.operation))
    || Object.keys(params).some(key => !['operation', 'projectId', 'sourceThreadId', 'limit', 'requestId', 'viewEpoch'].includes(key))
    || params.projectId !== undefined && !identifier(params.projectId)
    || params.sourceThreadId !== undefined && (!['list', 'preview'].includes(String(params.operation)) || !identifier(params.sourceThreadId) || !identifier(params.projectId))
    || params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 1024)
    || params.requestId !== undefined && (typeof params.requestId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(params.requestId))
    || params.viewEpoch !== undefined && (!Number.isSafeInteger(params.viewEpoch) || Number(params.viewEpoch) < 0))) invalid();
  if (name === 'resources' && params.operation === 'builtinSkill'
    && (params.id !== 'openai-skill-creator' || Object.keys(params).some(key => !['operation', 'id'].includes(key)))) invalid();
  if (name === 'manage' && params.operation === 'pluginReadiness'
    && (!identifier(params.id) || !identifier(params.expectedDigest)
      || Object.keys(params).some(key => !['operation', 'projectId', 'id', 'expectedDigest'].includes(key)))) invalid();
  if (name === 'manage' && ['pluginArchivePick', 'pluginArchiveImport'].includes(String(params.operation))) {
    const importing = params.operation === 'pluginArchiveImport';
    if (serviceOnly && !importing) invalid();
    const keys = ['operation', 'projectId', ...(importing ? ['expectedRevision', 'requestId', serviceOnly ? 'path' : 'selectionToken'] : [])];
    if (Object.keys(params).some(key => !keys.includes(key))) invalid();
    if (importing && (!identifier(params.requestId) || !Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0)) invalid();
    if (importing && (serviceOnly
      ? typeof params.path !== 'string' || params.path.length > 4096 || params.path.includes('\0') || !params.path.startsWith('/')
      : !identifier(params.selectionToken))) invalid();
  }
  if (name === 'manage' && ['plugin', 'pluginInstall', 'pluginConfigure', 'pluginComponentConfigure', 'pluginUninstall', 'pluginSetup', 'pluginResolve', 'marketplaceAdd', 'marketplaceAddGit', 'marketplaceRemove', 'marketplaceUpdate'].includes(String(params.operation))) {
    if (!String(params.operation).startsWith('marketplace') && !identifier(params.id)) invalid();
    if (params.operation === 'marketplaceAdd' && (typeof params.root !== 'string' || !params.root.trim() || params.root.length > 4096 || params.root.includes('\0'))) invalid();
    if (['pluginInstall', 'pluginConfigure'].includes(String(params.operation)) && !['user', 'project'].includes(String(params.scope))) invalid();
    if (params.operation === 'pluginInstall' && (typeof params.source !== 'string' || !params.source.trim() || params.source.length > 4096 || params.source.includes('\0') || !identifier(params.expectedDigest))) invalid();
    if (params.operation === 'pluginConfigure' && typeof params.enabled !== 'boolean') invalid();
    if (params.operation === 'pluginComponentConfigure' && (typeof params.enabled !== 'boolean' || !identifier(params.expectedDigest) || !record(params.component) || !['skill', 'mcpServer'].includes(String(params.component.kind)) || !identifier(params.component.id) || Object.keys(params.component).some(key => !['kind', 'id'].includes(key)))) invalid();
    if (params.operation !== 'plugin' && params.operation !== 'pluginSetup' && (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0)) invalid();
    if (params.threadId !== undefined && !identifier(params.threadId)) invalid();
    if (params.requestId !== undefined && !identifier(params.requestId)) invalid();
  }
  if (name === 'manage' && params.operation === 'pluginSubmission'
    && (!identifier(params.requestId) || !['pluginArchiveImport', 'marketplaceAdd', 'marketplaceAddGit', 'marketplaceRemove', 'marketplaceUpdate', 'pluginResolve', 'pluginConnection', 'pluginHooksConfigure', 'hookAcknowledge', 'pluginAuthConfigure', 'connectorConfigure', 'pluginInstall', 'pluginConfigure', 'pluginComponentConfigure', 'pluginUninstall', 'pluginSetup'].includes(String(params.mutation)))) invalid();
  if (name === 'manage') {
    if (['mcpFormResourcePrepare', 'mcpFormResourceStage', 'mcpFormResourceSubmission', 'mcpFormResourceRelease'].includes(String(params.operation))) {
      const operation = String(params.operation);
      // Only native Main mediation may acquire selection tokens or submit filesystem paths.
      if (operation !== 'mcpFormResourceRelease' && !serviceOnly) invalid();
      const keys = operation === 'mcpFormResourceStage' ? ['selectionToken', 'requestId', 'paths']
        : operation === 'mcpFormResourceSubmission' ? ['requestId']
        : ['threadId', 'requestId', 'fieldName', ...(operation === 'mcpFormResourceRelease' ? ['uri'] : [])];
      if (Object.keys(params).some(key => !['operation', 'projectId', ...keys].includes(key))
        || !identifier(params.requestId)) invalid();
      if (operation === 'mcpFormResourceStage') {
        if (!identifier(params.selectionToken) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(params.requestId))
          || !Array.isArray(params.paths) || params.paths.length < 1 || params.paths.length > 256
          || params.paths.some(path => typeof path !== 'string' || path.length > 4096 || path.includes('\0')
            || !(/^(?:\/|[a-zA-Z]:[\\/])/.test(path)))) invalid();
      } else if (operation !== 'mcpFormResourceSubmission') {
        if (!identifier(params.threadId) || typeof params.fieldName !== 'string' || !params.fieldName || params.fieldName.length > 4096) invalid();
        if (operation === 'mcpFormResourceRelease' && (typeof params.uri !== 'string' || !params.uri || params.uri.length > 4096 || params.uri.includes('\0'))) invalid();
      }
    }

    if (params.operation === 'mcpAppOpenFromResult' && (Object.keys(params).some(key => !['operation', 'projectId', 'threadId', 'turnId', 'itemId', 'requestId'].includes(key)) || !['threadId', 'turnId', 'itemId', 'requestId'].every(key => identifier(params[key])))) invalid();
    // Main grants file paths; renderer requests cannot supply a saved grant.
    if (params.operation === 'mcpAppOpen' && params.fileResource !== undefined) {
      const grant = params.fileResource;
      if (!serviceOnly || !record(grant) || !identifier(params.threadId)
        || typeof grant.uri !== 'string' || !/^areal-file:\/\/[^\s/]+$/.test(grant.uri) || grant.uri.length > 512
        || typeof grant.path !== 'string' || !grant.path.trim() || grant.path.length > 4096 || grant.path.includes('\0')
        || Object.keys(grant).some(key => key !== 'uri' && key !== 'path')) invalid();
    }
    if (['pluginConnection','connectorConfigure','connectorCredential'].includes(String(params.operation)) && (!identifier(params.id) || typeof params.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(params.expectedDigest) || !identifier(params.requestId))) invalid();
    if (params.operation === 'pluginConnection' && typeof params.connect !== 'boolean') invalid();
    if (params.operation === 'pluginHooksConfigure' && (!identifier(params.id) || !identifier(params.requestId) || typeof params.enabled !== 'boolean' || typeof params.trusted !== 'boolean' || (params.allowReadOnlyCommands !== undefined && typeof params.allowReadOnlyCommands !== 'boolean') || typeof params.expectedDigest !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(params.expectedDigest) || typeof params.definitionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(params.definitionDigest))) invalid();
    if (params.operation === 'hookAcknowledge' && (!identifier(params.threadId) || !identifier(params.requestId) || !identifier(params.invocationId) || typeof params.inspection !== 'string' || !params.inspection.trim() || params.inspection.length > 8192)) invalid();
    if (['connectorConfigure','connectorCredential'].includes(String(params.operation)) && (!identifier(params.connectorId) || params.provider !== 'github')) invalid();
    if (params.operation === 'connectorCredential' && (typeof params.secret !== 'string' || !params.secret.trim() || params.secret.length > 16384 || /[\r\n]/.test(params.secret))) invalid();
    if (params.operation === 'connectorConfigure' && !identifier(params.credentialRef)) invalid();
    if (['pluginAuthCredential','pluginAuthConfigure'].includes(String(params.operation))) {
      if (!identifier(params.id) || !identifier(params.server) || typeof params.expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(params.expectedDigest) || !identifier(params.requestId)
        || !record(params.configuration) || Object.keys(params.configuration).some(key => !['clientSecretRef','privateKeyRef','privateKeyId','clientMetadataUrl','apiKeyRef','callbackUrl'].includes(key))) invalid();
      for (const key of ['clientSecretRef','privateKeyRef','privateKeyId']) if (params.configuration[key] !== undefined && !identifier(params.configuration[key])) invalid();
      for (const key of ['clientMetadataUrl','callbackUrl']) if (params.configuration[key] !== undefined && (typeof params.configuration[key] !== 'string' || params.configuration[key].length > 4096 || params.configuration[key].includes('\0'))) invalid();
      if (params.operation === 'pluginAuthCredential') {
        if (!record(params.credentials) || Object.keys(params.credentials).some(key => !['clientSecret','privateKeyPem','apiKey'].includes(key))) invalid();
        for (const [key,value] of Object.entries(params.credentials)) if (typeof value !== 'string' || value.length > (key === 'privateKeyPem' ? 32768 : 16384) || value.includes('\0') || (key !== 'privateKeyPem' && /[\r\n]/.test(value))) invalid();
      }
    }
    if (params.operation === 'pluginAuth' && (!identifier(params.id) || !identifier(params.server) || !['start','status','cancel'].includes(String(params.authOperation)))) invalid();
  }
  if (name !== 'configure') return;
  if (params.expectedRevision !== undefined && (!Number.isSafeInteger(params.expectedRevision) || Number(params.expectedRevision) < 0)) invalid();
  if (params.model !== undefined && params.model !== null && (!record(params.model) || !identifier(params.model.providerId) || !identifier(params.model.modelId))) invalid();
  if (params.profile !== undefined && !resource(params.profile)) invalid();
  for (const key of ['options', 'parameters']) if (params[key] !== undefined && !record(params[key])) invalid();
  if (params.selectedSkills !== undefined && (!Array.isArray(params.selectedSkills) || !params.selectedSkills.every(resource))) invalid();
  if (!['model', 'profile', 'options', 'parameters', 'selectedSkills'].some(key => params[key] !== undefined)) invalid();
}

/** @param {unknown} request */
function validatePreview(request) {
  if (!record(request)) invalid();
  if (request.operation === 'hide') {
    if (request.captureId !== undefined && (!identifier(request.captureId) || !identifier(request.projectId)
      || !identifier(request.threadId) || !identifier(request.pageId))) invalid();
    return;
  }
  if (!['show', 'navigate', 'back', 'forward', 'reload', 'stop', 'state', 'external', 'devtools', 'openLink', 'release', 'claim', 'takeover', 'captureRegion', 'captureElement', 'selectElement', 'cancelElementSelection', 'checkElement', 'endRegion', 'beginStyleTrial', 'applyStyleTrial', 'undoStyleTrial', 'redoStyleTrial', 'styleTrialState', 'captureStyleTrialAfter', 'clearStyleTrial', 'newPage', 'selectPage', 'subscribe', 'unsubscribe', 'allowNextDownload', 'cancelFileHandoff', 'cancelDownload', 'authorizeFrameOrigin', 'reloadFrameOrigin', 'revokeFrameOrigin'].includes(String(request.operation))
    || !identifier(request.projectId) || !identifier(request.threadId)) invalid();
  if (['authorizeFrameOrigin', 'reloadFrameOrigin', 'revokeFrameOrigin'].includes(String(request.operation))
    && (!identifier(request.pageId) || request.userIntent !== true || Object.keys(request).some(key =>
      !['operation', 'projectId', 'threadId', 'pageId', 'userIntent'].includes(key)))) invalid();
  if (request.url !== undefined && typeof request.url !== 'string') invalid();
  if (request.pageId !== undefined && !identifier(request.pageId)) invalid();
  if (request.captureId !== undefined && !identifier(request.captureId)) invalid();
  if (request.downloadId !== undefined && !identifier(request.downloadId)) invalid();
  if (['allowNextDownload', 'cancelFileHandoff', 'cancelDownload'].includes(String(request.operation))
    && Object.keys(request).some(key => !['operation', 'projectId', 'threadId', 'pageId', 'downloadId', 'userIntent'].includes(key))) invalid();
  if (['allowNextDownload', 'cancelFileHandoff', 'cancelDownload'].includes(String(request.operation)) && !identifier(request.pageId)) invalid();
  if (request.operation === 'cancelDownload' && !identifier(request.downloadId)) invalid();
  if (['allowNextDownload', 'cancelDownload'].includes(String(request.operation)) && request.userIntent !== true) invalid();
  if (request.operation === 'endRegion' && (!identifier(request.pageId) || !identifier(request.captureId))) invalid();
  if (request.operation === 'checkElement' && (!identifier(request.pageId) || !identifier(request.captureId))) invalid();
  if (request.operation === 'checkElement' && !identifier(request.elementId)) invalid();
  if (request.operation === 'selectElement' && (!identifier(request.pageId) || !identifier(request.captureId)
    || ![request.x, request.y].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))) invalid();
  if (request.operation === 'beginStyleTrial' && (!identifier(request.pageId) || !identifier(request.captureId) || !identifier(request.elementId))) invalid();
  if (['applyStyleTrial', 'undoStyleTrial', 'redoStyleTrial', 'styleTrialState', 'captureStyleTrialAfter', 'clearStyleTrial'].includes(String(request.operation))
    && (!identifier(request.pageId) || !identifier(request.trialId))) invalid();
  if (request.operation === 'applyStyleTrial' && (typeof request.property !== 'string' || typeof request.value !== 'string'
    || request.property.length > 40 || request.value.length > 500)) invalid();
  if (request.userIntent !== undefined && typeof request.userIntent !== 'boolean') invalid();
  if (request.operation === 'release' && request.userIntent !== true) invalid();
  if (request.operation === 'selectPage' && !identifier(request.pageId)) invalid();
  if (['navigate', 'openLink'].includes(String(request.operation)) && typeof request.url !== 'string') invalid();
  if (request.visible !== undefined && typeof request.visible !== 'boolean') invalid();
  const bounds = request.bounds;
  if (bounds !== undefined && (!record(bounds) || !['x', 'y', 'width', 'height'].every(key => typeof bounds[key] === 'number' && Number.isFinite(bounds[key])))) invalid();
}

/** @param {unknown} error @returns {DesktopError} */
function desktopError(error) {
  const value = record(error) || error instanceof Error ? error : {};
  const code = 'code' in value ? value.code : undefined;
  const requestId = 'requestId' in value ? value.requestId : undefined;
  const reason = 'data' in value && record(value.data) && typeof value.data.reason === 'string'
    ? value.data.reason
    : 'reason' in value && typeof value.reason === 'string' ? value.reason : undefined;
  const data = 'data' in value && record(value.data) ? value.data : {};
  const rawOutcome = 'outcome' in value ? value.outcome : data.outcome;
  const rawRecovery = 'recovery' in value ? value.recovery : data.recovery;
  /** @type {DesktopError['outcome']} */
  let outcome;
  if (record(rawOutcome) && (rawOutcome.kind === 'noMutation' || rawOutcome.kind === 'rejected')) outcome = { kind: rawOutcome.kind };
  if (record(rawOutcome) && (rawOutcome.kind === 'admitted' || rawOutcome.kind === 'unconfirmed') && record(rawOutcome.operation)) {
    const op = rawOutcome.operation;
    const target = op.target;
    if (typeof op.method === 'string' && /^[A-Za-z][A-Za-z0-9/]*$/.test(op.method) && op.method.length <= 128
      && (op.requestId === undefined || identifier(op.requestId)) && record(target)) {
      /** @type {import('../../runtime-client/core.js').OperationTarget | undefined} */
      let safeTarget;
      if (target.kind === 'project') safeTarget = { kind: 'project' };
      if (target.kind === 'thread' && identifier(target.threadId)) safeTarget = { kind: 'thread', threadId: String(target.threadId) };
      if (target.kind === 'task' && identifier(target.taskId)) safeTarget = { kind: 'task', taskId: String(target.taskId) };
      if (safeTarget) outcome = { kind: rawOutcome.kind, operation: { method: op.method,
        ...(typeof op.requestId === 'string' ? { requestId: op.requestId } : {}), target: safeTarget } };
    }
  }
  /** @type {DesktopError['recovery']} */
  const recovery = record(rawRecovery) && ['retryRead', 'queryOriginal', 'needsUser', 'none'].includes(String(rawRecovery.kind))
    ? { kind: /** @type {NonNullable<DesktopError['recovery']>['kind']} */ (rawRecovery.kind) } : undefined;
  const originalId = outcome && 'operation' in outcome ? outcome.operation.requestId : requestId;
  const unknown = outcome ? outcome.kind === 'admitted' || outcome.kind === 'unconfirmed' : 'submissionUnknown' in value && value.submissionUnknown === true;
  return {
    message: typeof value.message === 'string' ? value.message.slice(0, 4096) : '桌面操作失败',
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...(unknown ? { submissionUnknown: true } : {}),
    ...(typeof originalId === 'string' && identifier(originalId) ? { requestId: originalId } : {}),
    ...(reason ? { reason: reason.slice(0, 128) } : {}),
    ...(('delivery' in value ? value.delivery : data.delivery) === 'resultUnavailable' ? { delivery: /** @type {const} */ ('resultUnavailable') } : {}),
    ...(outcome ? { outcome } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

/** @param {string} name @param {unknown} params @param {unknown} value */
function validateCommandResponse(name, params, value) {
  if (!record(params)) invalid();
  if (name === 'manage' && params.operation === 'pluginReadiness') {
    if (!record(value) || value.pluginId !== params.id || value.installedDigest !== params.expectedDigest
      || !Array.isArray(value.requiredTools) || !value.requiredTools.every(identifier)
      || !Array.isArray(value.missingTools) || !value.missingTools.every(name => identifier(name) && Array.isArray(value.requiredTools) && value.requiredTools.includes(name))
      || value.available !== (value.missingTools.length === 0)
      || Object.keys(value).some(key => !['pluginId', 'installedDigest', 'requiredTools', 'missingTools', 'available'].includes(key))) invalid();
  }

  if (name === 'providers' && params.operation === 'revealKey') {
    if (!record(value) || typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 16384
      || Object.keys(value).some(key => key !== 'apiKey')) invalid();
    return;
  }
  if (name === 'prepareCreator') {
    if (!record(value) || !identifier(value.projectId) || value.projectId !== params.projectId
      || Object.keys(value).some(key => !['projectId', 'profile', 'skill', 'provenance'].includes(key))
      || !record(value.profile) || !resource(value.profile) || Object.keys(value.profile).some(key => !['id', 'revision'].includes(key))
      || !record(value.skill) || !resource(value.skill) || Object.keys(value.skill).some(key => !['id', 'revision', 'name', 'description'].includes(key))
      || typeof value.skill.name !== 'string' || !value.skill.name.trim() || value.skill.name.length > 256
      || typeof value.skill.description !== 'string' || value.skill.description.length > 8192
      || !record(value.provenance) || Object.keys(value.provenance).some(key => !['upstream', 'revision', 'contentDigest'].includes(key))
      || !identifier(value.provenance.upstream) || !identifier(value.provenance.revision)
      || typeof value.provenance.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.provenance.contentDigest)) invalid();
    return;
  }
  if (name === 'tasks') {
    const preview = params.operation === 'preview';
    if (params.projectId !== undefined && (!record(value) || value.projectId !== params.projectId
      || value.requestId !== params.requestId || value.viewEpoch !== params.viewEpoch
      || !Array.isArray(value.owners) || value.owners.length !== 1 || !record(value.owners[0]) || value.owners[0].projectId !== params.projectId)) {
      throw Object.assign(new Error('当前后台不支持按所有者读取任务目录。请安全更新后台后重试。'), { code: 'SERVICE_COMMAND_UNSUPPORTED' });
    }
    if (!record(value) || !Array.isArray(value.data) || !value.data.every(record) || !Array.isArray(value.errors) || !value.errors.every(record) || typeof value.hasMore !== 'boolean'
      || params.projectId !== undefined && (value.data.some(row => row.projectId !== params.projectId) || value.errors.some(error => error.projectId !== params.projectId)
        || !(preview ? ['unobserved', 'error'] : ['ready', 'error']).includes(String(value.owners[0].status)) || value.owners[0].status === 'ready' && (!Number.isSafeInteger(value.owners[0].connectionGeneration) || value.owners[0].connectionGeneration < 0))
      || preview && (value.source !== 'published' || value.executionState !== 'unobserved' || !Array.isArray(value.owners)
        || value.owners.some(owner => !record(owner) || !identifier(owner.projectId) || !['unobserved', 'error'].includes(String(owner.status)) || 'connectionGeneration' in owner))) invalid();
    return;
  }
  if (name === 'continue' && (!record(value) || !(record(value.turn) && identifier(value.turn.id) || Number.isSafeInteger(value.queueRevision) && Number(value.queueRevision) >= 0))) invalid();
  if (name === 'configure' && (!record(value) || !Array.isArray(value.projects))) invalid();
  if (name === 'fork' && (!record(value) || !identifier(value.threadId) || !identifier(value.requestId))) invalid();
  if (name !== 'side') return;
  if (!record(value)) invalid();
  if (['start', 'create'].includes(String(params.operation)) && (!identifier(value.threadId) || !identifier(value.requestId))) invalid();
  if (params.operation === 'create' && value.turnId !== undefined && !identifier(value.turnId)) invalid();
  if (params.operation === 'close' && (!identifier(value.threadId) || !identifier(value.requestId) || typeof value.accepted !== 'boolean' || typeof value.cleanupConfirmed !== 'boolean')) invalid();
  if (params.operation === 'recover' && (typeof value.confirmed !== 'boolean' || value.confirmed && !identifier(value.threadId))) invalid();
  if (params.operation === 'list' && (!Array.isArray(value.data) || !value.data.every(record) || value.nextCursor !== undefined && value.nextCursor !== null && typeof value.nextCursor !== 'string')) invalid();
  if (params.operation === 'context' && (!identifier(value.snapshotId) || !Array.isArray(value.evidence) || !value.evidence.every(record) || value.nextCursor !== undefined && value.nextCursor !== null && typeof value.nextCursor !== 'string')) invalid();
  if (params.operation === 'send' && (!record(value.turn) || !identifier(value.turn.id))) invalid();
}
/** @param {unknown} value @param {number} maximum */
function pageBounded(value, maximum) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > maximum) throw new Error('Invalid page tool size');
}
/** @param {unknown} value @param {string[]} keys @returns {value is Record<string,unknown>} */
function pageFields(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
/** @param {unknown} value */
function pageRevision(value) { return Number.isSafeInteger(value) && Number(value) >= 0; }
/** @param {unknown} value */
function pageOffset(value) { return pageRevision(value) && Number(value) <= 65536; }
/** @param {unknown} value */
function validateMcpPageDeclaration(value) {
  if (!pageFields(value, ['version', 'documentId', 'tools']) || value.version !== 1
    || !identifier(value.documentId) || value.documentId.length > 128
    || !Array.isArray(value.tools) || value.tools.length < 1 || value.tools.length > 2
    || new Set(value.tools).size !== value.tools.length
    || value.tools.some(kind => !['getSelection', 'applyPatch'].includes(kind))) throw new Error('Invalid page tool declaration');
  pageBounded(value, 1024);
}
/** @param {unknown} value */
function validateMcpPageCall(value) {
  if (!pageFields(value, ['callId', 'kind', 'documentId', 'arguments']) || !identifier(value.callId)
    || !identifier(value.documentId)) throw new Error('Invalid page tool call');
  const args = value.arguments;
  if (value.kind === 'getSelection' && pageFields(args, [])) return;
  if (value.kind !== 'applyPatch' || !pageFields(args, ['expectedDocumentRevision', 'patch'])
    || !pageRevision(args.expectedDocumentRevision) || !pageFields(args.patch, ['from', 'to', 'insert'])
    || !pageOffset(args.patch.from) || !pageOffset(args.patch.to) || Number(args.patch.from) > Number(args.patch.to)
    || typeof args.patch.insert !== 'string' || args.patch.insert.length > 4096 || args.patch.insert.includes('\r')) throw new Error('Invalid page tool arguments');
  pageBounded(args, 32768);
}
/** @param {unknown} value */
function validateMcpPageReply(value) {
  pageBounded(value, 32768);
  if (pageFields(value, ['status']) && value.status === 'unknown') return;
  if (pageFields(value, ['status', 'reason']) && value.status === 'noEffect'
    && ['cancelled', 'closed', 'unavailable'].includes(String(value.reason))) return;
  if (!pageFields(value, ['status', 'result']) || value.status !== 'completed' || !record(value.result)) throw new Error('Invalid page tool reply');
  const result = value.result;
  if (!identifier(result.documentId) || !pageRevision(result.documentRevision)) throw new Error('Invalid page tool result');
  if (result.kind === 'selection' && pageFields(result, ['kind', 'documentId', 'documentRevision', 'anchor', 'head', 'selectedText', 'truncated', 'dirty'])
    && pageOffset(result.anchor) && pageOffset(result.head) && typeof result.selectedText === 'string'
    && result.selectedText.length <= 4096 && typeof result.truncated === 'boolean' && typeof result.dirty === 'boolean') return;
  if (result.kind === 'applied' && pageFields(result, ['kind', 'documentId', 'previousDocumentRevision', 'documentRevision', 'from', 'to', 'insertedLength', 'dirty'])
    && pageRevision(result.previousDocumentRevision) && pageOffset(result.from) && pageOffset(result.to)
    && pageOffset(result.insertedLength) && Number(result.insertedLength) <= 4096 && typeof result.dirty === 'boolean') return;
  if (result.kind === 'conflict' && pageFields(result, ['kind', 'documentId', 'expectedDocumentRevision', 'documentRevision'])
    && pageRevision(result.expectedDocumentRevision)) return;
  if (result.kind === 'rejected' && pageFields(result, ['kind', 'documentId', 'documentRevision', 'reason'])
    && ['invalidRange', 'documentTooLarge', 'noChange'].includes(String(result.reason))) return;
  throw new Error('Invalid page tool result');
}
module.exports = { commandDefinitions, commandSemantics, validateCommand, validateCommandResponse, validatePreview, desktopError, validateMcpPageDeclaration, validateMcpPageCall, validateMcpPageReply };
