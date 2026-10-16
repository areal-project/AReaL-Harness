'use strict';

/** @typedef {{message:string, code?:string|number, reason?:string, submissionUnknown?:boolean, requestId?:string}} DesktopError */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:DesktopError}} DesktopResult */
/** @typedef {{id:string,revision:string}} ResourceRef */
/** @typedef {{projectId:string,threadId:string,expectedRevision?:number,model?:{providerId:string,modelId:string}|null,profile?:ResourceRef,options?:Record<string,unknown>,parameters?:Record<string,unknown>,selectedSkills?:ResourceRef[]}} ConfigureRequest */
/** @typedef {{projectId:string,operation:'start',sourceThreadId:string,requestId:string,text:string,workspaceAccess:'none'|'readOnly',model?:{providerId:string,modelId:string},resetModel?:boolean,anchor?:Record<string,unknown>|null,selection?:Record<string,unknown>|null,parameters?:Record<string,unknown>}|{projectId:string,operation:'recover',requestId:string}|{projectId:string,operation:'send',threadId:string,text:string}|{projectId:string,operation:'context',threadId:string,cursor?:string,evidenceRef?:string,maxBytes?:number}|{projectId:string,operation:'list',sourceThreadId:string,includeArchived?:boolean,cursor?:string}} SideRequest */
/** @typedef {{projectId:string,sourceThreadId:string,requestId?:string,workspaceMode:'sharedCurrent',anchor:{turnId:string,boundary:'before'|'after'},target?:Record<string,unknown>}} ForkRequest */

/** @typedef {{operation:'status'|'retry'}|{operation:'setEnabled',enabled:boolean,expectedRevision:string}} TrajectoryRequest */
/** @typedef {{id:string,status:'pending'|'uploading'|'failed'|'uploaded'|'evicted',created_at:number,uploaded_at:number|null,attempts:number,next_attempt_at:number|null,bytes:number,error:string|null,turn_id?:string|null,event_name?:string|null,model_name?:string|null,harness_version?:string|null,execution_duration_ms?:number|null,model_call_duration_ms?:number|null,occurred_at?:number|null}} TrajectoryRecord */
/** @typedef {{scope:'recent_records',record_limit:100,records_considered:number,model_calls:number,total_duration_ms:number|null,mean_duration_ms:number|null,max_duration_ms:number|null}} TrajectoryModelCallSummary */
/** @typedef {{enabled:boolean,config_revision?:string,capture_apply_pending?:boolean,capture_apply_error?:string|null,state:'disabled'|'ready'|'degraded'|'invalid',endpoint:string,configPath:string|null,spool_dir:string,worker_running:boolean,queue:{pending:number,uploading:number,failed:number,uploaded:number,evicted:number,bytes:number,max_bytes:number,dropped_memory:number,dropped_oversize:number},last_error:string|null,last_success_at:number|null,records:TrajectoryRecord[],model_call_summary?:TrajectoryModelCallSummary,limits:{max_retries:number,upload_interval_ms:number,max_memory_bytes:number}}} TrajectoryStatus */

// 名称、作用域和执行层只维护一份；Main 专属能力不能从后台服务入口调用。
const commandDefinitions = Object.freeze({
  connect: ['service', 'project'], list: ['service', 'project'], open: ['service', 'thread'],
  create: ['service', 'project'], fork: ['service', 'project'], side: ['service', 'project'], send: ['service', 'thread'], stop: ['service', 'thread'],
  attachBrowser: ['service', 'thread'],
  respond: ['service', 'thread'], reconcile: ['service', 'project'], configure: ['service', 'thread'],
  queue: ['service', 'thread'], queueEdit: ['service', 'thread'], library: ['service', 'app'],
  manage: ['service', 'project'], workspace: ['service', 'project'], media: ['service', 'thread'],
  steer: ['service', 'thread'], dismissRecovery: ['service', 'project'], providers: ['service', 'app'],
  chatgpt: ['service', 'app'], analytics: ['service', 'app'], resources: ['service', 'app'],
  projectless: ['service', 'app'], tasks: ['service', 'app'], trajectory: ['service', 'app'], feedback: ['service', 'app'],
  serviceStatus: ['main', 'app'], stopService: ['main', 'app'], recoverResources: ['main', 'app'],
  connectService: ['main', 'app'], export: ['main', 'thread'], remoteControl: ['main', 'app'],
});
/** @typedef {keyof typeof commandDefinitions} CommandName */
/** @template {CommandName} N @typedef {N extends 'fork' ? ForkRequest : N extends 'configure' ? ConfigureRequest : N extends 'side' ? SideRequest : N extends 'trajectory' ? TrajectoryRequest : Record<string,unknown>} CommandParams */
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
  if (scope !== 'app' && !identifier(params.projectId)) invalid();
  if (scope === 'thread' && !identifier(params.threadId)) invalid();
  if (name === 'create' && params.browserEnabled !== undefined && typeof params.browserEnabled !== 'boolean') invalid();
  if (name === 'fork' && (!identifier(params.sourceThreadId) || !record(params.anchor)
    || !identifier(params.anchor.turnId) || !['before', 'after'].includes(String(params.anchor.boundary))
    || params.workspaceMode !== 'sharedCurrent')) invalid();
  if (name === 'side' && (!['start', 'recover', 'send', 'context', 'list'].includes(String(params.operation))
    || (params.operation === 'start' && (!identifier(params.sourceThreadId) || typeof params.text !== 'string' || !params.text.trim()))
    || (params.operation === 'send' && (!identifier(params.threadId) || typeof params.text !== 'string' || !params.text.trim()))
    || (params.operation === 'recover' && !identifier(params.requestId))
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
  return {
    message: typeof value.message === 'string' ? value.message : '桌面操作失败',
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...('submissionUnknown' in value && value.submissionUnknown === true ? { submissionUnknown: true } : {}),
    ...(typeof requestId === 'string' ? { requestId } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** @param {string} name @param {unknown} params @param {unknown} value */
function validateCommandResponse(name, params, value) {
  if (!record(params)) invalid();
  if (name === 'configure' && (!record(value) || !Array.isArray(value.projects))) invalid();
  if (name === 'fork' && (!record(value) || !identifier(value.threadId) || !identifier(value.requestId))) invalid();
  if (name !== 'side') return;
  if (!record(value)) invalid();
  if (params.operation === 'start' && (!identifier(value.threadId) || !identifier(value.requestId))) invalid();
  if (params.operation === 'recover' && (typeof value.confirmed !== 'boolean' || value.confirmed && !identifier(value.threadId))) invalid();
  if (params.operation === 'list' && (!Array.isArray(value.data) || !value.data.every(record) || value.nextCursor !== undefined && value.nextCursor !== null && typeof value.nextCursor !== 'string')) invalid();
  if (params.operation === 'context' && (!identifier(value.snapshotId) || !Array.isArray(value.evidence) || !value.evidence.every(record) || value.nextCursor !== undefined && value.nextCursor !== null && typeof value.nextCursor !== 'string')) invalid();
  if (params.operation === 'send' && (!record(value.turn) || !identifier(value.turn.id))) invalid();
}
module.exports = { commandDefinitions, validateCommand, validateCommandResponse, validatePreview, desktopError };
