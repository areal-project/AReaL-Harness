// @ts-check
"use strict";
// 插件库登记归 Host（plugins.read / plugins.command）；这里是这些操作在界面侧的请求与回执形状。
const { modelRecord } = require("../core-model-contract.js");
/** @typedef {import('./generated/management-protocol.cjs').ResponseMap} ProtocolResponseMap */
/** @typedef {{projectId?:string,requestId?:string,expectedRevision:number}} Base */
/** @typedef {{
 * pluginInstall:Base&{operation:'pluginInstall',id:string,source:string,expectedDigest:string,scope?:'user'|'project'},
 * pluginUninstall:Base&{operation:'pluginUninstall',id:string},
 * pluginResolve:Base&{operation:'pluginResolve',id:string},
 * pluginConfigure:Base&{operation:'pluginConfigure',id:string,enabled:boolean,scope?:'user'|'project'},
 * marketplaceAdd:Base&{operation:'marketplaceAdd',root:string},
 * marketplaceRemove:Base&{operation:'marketplaceRemove',root:string},
 * marketplaceAddGit:Base&{operation:'marketplaceAddGit',url:string,refName?:string,sparsePaths?:string[]},
 * marketplaceUpdate:Base&{operation:'marketplaceUpdate'},
 * marketplaceSyncDefault:Base&{operation:'marketplaceSyncDefault'},
 * mcp:{operation:'mcp',projectId?:string},
 * mcpSave:{operation:'mcpSave',name:string,server:Record<string,unknown>,expectedRevision:number},
 * mcpRemove:{operation:'mcpRemove',name:string,expectedRevision:number}
 * }} PluginStoreRequestMap */
/** @typedef {{name:string,id:string,server:Record<string,unknown>}} LocalMcp */
/** @typedef {{
 * pluginInstall:ProtocolResponseMap['plugin'],pluginResolve:ProtocolResponseMap['plugin'],pluginConfigure:ProtocolResponseMap['plugin'],
 * pluginUninstall:ProtocolResponseMap['plugins'],marketplaceAdd:ProtocolResponseMap['plugins'],marketplaceRemove:ProtocolResponseMap['plugins'],
 * marketplaceAddGit:ProtocolResponseMap['plugins'],marketplaceUpdate:ProtocolResponseMap['plugins'],marketplaceSyncDefault:ProtocolResponseMap['plugins'],
 * mcp:{revision:number,data:LocalMcp[]},mcpSave:ProtocolResponseMap['plugin'],mcpRemove:ProtocolResponseMap['plugins']
 * }} PluginStoreResponseMap */
/** @typedef {keyof PluginStoreRequestMap} PluginStoreOperation */

/** @type {Readonly<Record<PluginStoreOperation,'detail'|'list'|'mcp'>>} */
const results = Object.freeze({
  pluginInstall: "detail",
  pluginResolve: "detail",
  pluginConfigure: "detail",
  mcpSave: "detail",
  pluginUninstall: "list",
  marketplaceAdd: "list",
  marketplaceRemove: "list",
  marketplaceAddGit: "list",
  marketplaceUpdate: "list",
  marketplaceSyncDefault: "list",
  mcpRemove: "list",
  mcp: "mcp",
});
/** @param {unknown} value @returns {value is PluginStoreOperation} */
function pluginStoreOperation(value) {
  return typeof value === "string" && Object.hasOwn(results, value);
}
/** @param {unknown} value */
const text = (value) => typeof value === "string" && value.length > 0;
/** @param {unknown} value */
const revision = (value) => Number.isSafeInteger(value) && Number(value) >= 0;
/** @param {Record<string,unknown>} value */
function base(value) {
  return (
    revision(value.expectedRevision) &&
    (value.projectId === undefined || text(value.projectId)) &&
    (value.requestId === undefined || typeof value.requestId === "string")
  );
}
/** @param {unknown} value */
function isPluginStoreRequest(value) {
  if (!modelRecord(value) || !pluginStoreOperation(value.operation)) return false;
  const scope = value.scope === undefined || value.scope === "user" || value.scope === "project";
  switch (value.operation) {
    case "mcp":
      return value.projectId === undefined || text(value.projectId);
    case "mcpSave":
      return text(value.name) && modelRecord(value.server) && revision(value.expectedRevision);
    case "mcpRemove":
      return text(value.name) && revision(value.expectedRevision);
    case "pluginInstall":
      return (
        base(value) &&
        scope &&
        text(value.id) &&
        text(value.source) &&
        typeof value.expectedDigest === "string" &&
        /^[0-9a-f]{64}$/.test(value.expectedDigest)
      );
    case "pluginConfigure":
      return base(value) && scope && text(value.id) && typeof value.enabled === "boolean";
    case "pluginUninstall":
    case "pluginResolve":
      return base(value) && text(value.id);
    case "marketplaceAdd":
    case "marketplaceRemove":
      return base(value) && text(value.root);
    case "marketplaceAddGit":
      return (
        base(value) &&
        text(value.url) &&
        (value.refName === undefined || typeof value.refName === "string") &&
        (value.sparsePaths === undefined ||
          (Array.isArray(value.sparsePaths) &&
            value.sparsePaths.every((item) => typeof item === "string")))
      );
    case "marketplaceUpdate":
    case "marketplaceSyncDefault":
      return base(value);
  }
}
/** @param {PluginStoreOperation} operation @param {unknown} value @param {(operation:string,value:unknown)=>boolean} protocolResponse */
function isPluginStoreResponse(operation, value, protocolResponse) {
  const kind = results[operation];
  if (kind === "detail") return protocolResponse("plugin", value);
  if (kind === "list") return protocolResponse("plugins", value);
  return (
    modelRecord(value) &&
    revision(value.revision) &&
    Array.isArray(value.data) &&
    value.data.every(
      (item) => modelRecord(item) && text(item.name) && text(item.id) && modelRecord(item.server),
    )
  );
}
/** 收窄成 Host 接受的字段：安装只有用户级，项目只用于读与“在此项目启用”。 @param {Record<string,unknown>} request */
function hostPluginStoreParams(request) {
  const { requestId: _requestId, scope, projectId, ...rest } = request;
  const keepProject =
    projectId !== undefined &&
    (request.operation === "plugins" ||
      request.operation === "plugin" ||
      request.operation === "mcp" ||
      request.operation === "pluginInstall" ||
      (request.operation === "pluginConfigure" && scope === "project"));
  return keepProject ? { ...rest, projectId } : rest;
}
module.exports = {
  pluginStoreOperation,
  isPluginStoreRequest,
  isPluginStoreResponse,
  hostPluginStoreParams,
};
