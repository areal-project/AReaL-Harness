'use strict';

/** @typedef {{message:string, code?:string|number, submissionUnknown?:boolean, requestId?:string}} DesktopError */
/** @template T @typedef {{ok:true,value:T}|{ok:false,error:DesktopError}} DesktopResult */
/** @typedef {{id:string,revision:string}} ResourceRef */
/** @typedef {{projectId:string,threadId:string,expectedRevision?:number,model?:{providerId:string,modelId:string}|null,profile?:ResourceRef,options?:Record<string,unknown>,parameters?:Record<string,unknown>,selectedSkills?:ResourceRef[]}} ConfigureRequest */

// 名称、作用域和执行层只维护一份；Main 专属能力不能从后台服务入口调用。
const commandDefinitions = Object.freeze({
  connect: ['service', 'project'], list: ['service', 'project'], open: ['service', 'thread'],
  create: ['service', 'project'], send: ['service', 'thread'], stop: ['service', 'thread'],
  respond: ['service', 'thread'], reconcile: ['service', 'project'], configure: ['service', 'thread'],
  queue: ['service', 'thread'], queueEdit: ['service', 'thread'], library: ['service', 'app'],
  manage: ['service', 'project'], workspace: ['service', 'project'], media: ['service', 'thread'],
  steer: ['service', 'thread'], dismissRecovery: ['service', 'project'], providers: ['service', 'app'],
  chatgpt: ['service', 'app'], analytics: ['service', 'app'], resources: ['service', 'app'],
  projectless: ['service', 'app'], tasks: ['service', 'app'],
  serviceStatus: ['main', 'app'], stopService: ['main', 'app'], recoverResources: ['main', 'app'],
  connectService: ['main', 'app'], export: ['main', 'thread'], remoteControl: ['main', 'app'],
});
/** @typedef {keyof typeof commandDefinitions} CommandName */
/** @template {CommandName} N @typedef {N extends 'configure' ? ConfigureRequest : Record<string,unknown>} CommandParams */
/** @typedef {'show'|'navigate'|'back'|'forward'|'reload'|'stop'|'state'|'external'|'devtools'|'openLink'|'release'} OwnedPreviewOperation */
/** @typedef {{operation:'hide',projectId?:string,threadId?:string}|{operation:OwnedPreviewOperation,projectId:string,threadId:string,url?:string,visible?:boolean,bounds?:{x:number,y:number,width:number,height:number}}} PreviewRequest */
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
  if (request.operation === 'hide') return;
  if (!['show', 'navigate', 'back', 'forward', 'reload', 'stop', 'state', 'external', 'devtools', 'openLink', 'release'].includes(String(request.operation))
    || !identifier(request.projectId) || !identifier(request.threadId)) invalid();
  if (request.url !== undefined && typeof request.url !== 'string') invalid();
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
  return {
    message: typeof value.message === 'string' ? value.message : '桌面操作失败',
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
    ...('submissionUnknown' in value && value.submissionUnknown === true ? { submissionUnknown: true } : {}),
    ...(typeof requestId === 'string' ? { requestId } : {}),
  };
}

module.exports = { commandDefinitions, validateCommand, validatePreview, desktopError };
