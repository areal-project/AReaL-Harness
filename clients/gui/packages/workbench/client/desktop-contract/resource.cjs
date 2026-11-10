// @ts-check
"use strict";
/** @typedef {Record<string,unknown>} Fields */
/** @typedef {{revision:number,skills:Record<string,Record<string,boolean>>}} ResourceState */
/** @typedef {{id:string,scope:string,managed:boolean,enabled:boolean,root:string,name:string,description:string,revision:string,error?:undefined}} AvailableSkill */
/** @typedef {AvailableSkill|{id:string,scope:string,managed:boolean,enabled:false,name:string,root?:string,error:string}} Skill */
/** @typedef {{id:string,revision:string,root:string,metadata:{name:string,description:string}}} DeployedSkill */
/** @typedef {Fields & {pluginId:string,installedDigest:string,trusted:boolean,state:string}} PluginConnection */
/** @param {unknown} value @returns {value is Fields} */
function record(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** @param {unknown} value @returns {value is string[]} */
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
/** @param {unknown} value @returns {ResourceState} */
function resources(value) {
  if (
    !record(value) ||
    typeof value.revision !== "number" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    !record(value.skills)
  )
    throw new Error("资源配置记录无效");
  const skills = Object.fromEntries(
    Object.entries(value.skills).map(([scope, entries]) => {
      if (!record(entries)) throw new Error("技能启用记录无效");
      return [
        scope,
        Object.fromEntries(
          Object.entries(entries).map(([id, enabled]) => {
            if (typeof enabled !== "boolean") throw new Error("技能启用记录无效");
            return [id, enabled];
          }),
        ),
      ];
    }),
  );
  return { revision: value.revision, skills };
}
/** @param {unknown} value @returns {DeployedSkill[]} */
function deployedSkills(value) {
  if (!Array.isArray(value)) throw new Error("技能部署记录无效");
  return value.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.revision !== "string" ||
      typeof item.root !== "string" ||
      !record(item.metadata) ||
      typeof item.metadata.name !== "string" ||
      typeof item.metadata.description !== "string"
    )
      throw new Error("技能部署记录无效");
    return {
      id: item.id,
      revision: item.revision,
      root: item.root,
      metadata: { name: item.metadata.name, description: item.metadata.description },
    };
  });
}
/** @param {unknown} value */
function deployment(value) {
  if (!record(value) || !Array.isArray(value.profiles) || !value.profiles.length)
    throw new Error("桌面资源配置无效");
  const profiles = value.profiles.map((item) => {
    if (!record(item) || typeof item.id !== "string" || typeof item.revision !== "string")
      throw new Error("桌面任务配置无效");
    return { ...item, id: item.id, revision: item.revision };
  });
  return { ...value, profiles };
}
/** @param {unknown} value @returns {{data:PluginConnection[]}} */
function pluginConnections(value) {
  if (!record(value) || !Array.isArray(value.data)) throw new Error("Core 插件连接目录无效");
  const data = value.data.map((item) => {
    if (
      !record(item) ||
      typeof item.pluginId !== "string" ||
      typeof item.installedDigest !== "string" ||
      typeof item.trusted !== "boolean" ||
      typeof item.state !== "string"
    )
      throw new Error("Core 插件连接记录无效");
    return {
      ...item,
      pluginId: item.pluginId,
      installedDigest: item.installedDigest,
      trusted: item.trusted,
      state: item.state,
    };
  });
  return { data };
}
/** @param {unknown} value */
function availableSkills(value) {
  if (!record(value) || !Array.isArray(value.data)) throw new Error("Core 技能目录无效");
  const data = value.data.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      typeof item.revision !== "string" ||
      typeof item.available !== "boolean"
    )
      throw new Error("Core 技能记录无效");
    return { ...item, id: item.id, revision: item.revision, available: item.available };
  });
  return { data };
}

/** @typedef {{scope:'user',projectId?:string}|{scope:'project',projectId:string}} Scope */
/** @typedef {{name:string,event:'PreToolUse'|'PostToolUse'|'PostToolUseFailure',matcher:string,argv:string[],timeoutMs:number}} Hook */
/** @typedef {{operation:'hooks'}|{operation:'hooksSave',expectedRevision:string,hooks:Hook[]}|{operation:'builtinSkill',id:'openai-skill-creator'}| (Scope & ({operation:'skills'}|{operation:'skillRead',id:string}|{operation:'skillToggle',id:string,enabled:boolean,expectedRevision:number}|{operation:'skillSave',id:string,name?:string|null,description?:string|null,content:string,expectedRevision:number}))} ResourceRequest */
/** @typedef {{path:string,external:boolean,revision:string,hooks:Hook[],projects:Array<{projectId:string,root:string,connected:boolean,applied:boolean}>}} HooksStatus */
/** @typedef {{skill:{id:string,revision:string,name:string,description:string},provenance:{upstream:string,revision:string,contentDigest:string}}} BuiltinSkill */
/** @typedef {{revision:number,data:Array<Skill & {overridden:boolean}>,customDeployment:boolean}} SkillsStatus */
/** @typedef {{revision:number,warning:string|null}} ResourceSaved */
/** @template {string} N @typedef {N extends 'resources' ? ResourceRequest : never} Request */
/** @template {string} N @template P @typedef {N extends 'resources' ? P extends {operation:'hooks'|'hooksSave'} ? HooksStatus : P extends {operation:'builtinSkill'} ? BuiltinSkill : P extends {operation:'skills'} ? SkillsStatus : P extends {operation:'skillRead'} ? {content:string,truncated:boolean} : P extends {operation:'skillToggle'|'skillSave'} ? ResourceSaved : never : never} Response */
/** @param {unknown} value @returns {value is string} */
function text(value) {
  return typeof value === "string";
}
/** @param {unknown} value @returns {value is number} */
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
/** @param {unknown} value @returns {value is Hook} */
function hook(value) {
  return (
    record(value) &&
    text(value.name) &&
    ["PreToolUse", "PostToolUse", "PostToolUseFailure"].some((entry) => entry === value.event) &&
    text(value.matcher) &&
    strings(value.argv) &&
    integer(value.timeoutMs)
  );
}
/** @template {string} N @param {N} name @param {unknown} value @returns {value is Request<N>} */
function isRequest(name, value) {
  if (name !== "resources" || !record(value)) return false;
  if (value.operation === "hooks") return true;
  if (value.operation === "hooksSave")
    return text(value.expectedRevision) && Array.isArray(value.hooks) && value.hooks.every(hook);
  if (value.operation === "builtinSkill")
    return (
      value.id === "openai-skill-creator" &&
      Object.keys(value).every((key) => ["operation", "id"].includes(key))
    );
  if (
    !(value.scope === "user" || value.scope === "project") ||
    (value.projectId !== undefined && !text(value.projectId)) ||
    (value.scope === "project" && !text(value.projectId))
  )
    return false;
  if (value.operation === "skills") return true;
  if (!text(value.id)) return false;
  if (value.operation === "skillRead") return true;
  if (!integer(value.expectedRevision)) return false;
  if (value.operation === "skillToggle") return typeof value.enabled === "boolean";
  return (
    value.operation === "skillSave" &&
    text(value.content) &&
    (value.name == null || text(value.name)) &&
    (value.description == null || text(value.description))
  );
}
/** @param {unknown} value @returns {value is BuiltinSkill} */
function builtin(value) {
  return (
    record(value) &&
    record(value.skill) &&
    ["id", "revision", "name", "description"].every((k) =>
      text(value.skill && record(value.skill) ? value.skill[k] : undefined),
    ) &&
    record(value.provenance) &&
    ["upstream", "revision", "contentDigest"].every(
      (k) => record(value.provenance) && text(value.provenance[k]),
    )
  );
}
/** @param {unknown} value @returns {value is Skill} */
function skill(value) {
  return (
    record(value) &&
    text(value.id) &&
    text(value.scope) &&
    typeof value.managed === "boolean" &&
    typeof value.enabled === "boolean" &&
    text(value.name) &&
    (value.error === undefined
      ? text(value.root) && text(value.description) && text(value.revision)
      : text(value.error) &&
        value.enabled === false &&
        (value.root === undefined || text(value.root)))
  );
}
/** @param {unknown} value @returns {value is ResourceSaved} */
function saved(value) {
  return (
    record(value) && integer(value.revision) && (value.warning === null || text(value.warning))
  );
}
/** @template {string} N @template P @param {N} name @param {P} request @param {unknown} value @returns {value is Response<N,P>} */
function isResponse(name, request, value) {
  if (name !== "resources" || !record(request) || !record(value)) return false;
  if (request.operation === "hooks" || request.operation === "hooksSave")
    return (
      text(value.path) &&
      typeof value.external === "boolean" &&
      text(value.revision) &&
      Array.isArray(value.hooks) &&
      value.hooks.every(hook) &&
      Array.isArray(value.projects) &&
      value.projects.every(
        (item) =>
          record(item) &&
          text(item.projectId) &&
          text(item.root) &&
          typeof item.connected === "boolean" &&
          typeof item.applied === "boolean",
      )
    );
  if (request.operation === "builtinSkill") return builtin(value);
  if (request.operation === "skills")
    return (
      integer(value.revision) &&
      Array.isArray(value.data) &&
      value.data.every(
        (item) => record(item) && typeof item.overridden === "boolean" && skill(item),
      ) &&
      typeof value.customDeployment === "boolean"
    );
  if (request.operation === "skillRead")
    return text(value.content) && typeof value.truncated === "boolean";
  return ["skillSave", "skillToggle"].some((entry) => entry === request.operation) && saved(value);
}
/** @param {unknown} value @returns {Hook[]} */
function readHooks(value) {
  if (!Array.isArray(value) || !value.every(hook)) throw new Error("钩子配置结构无效");
  return value;
}
module.exports = {
  readHooks,
  record,
  resources,
  deployedSkills,
  deployment,
  pluginConnections,
  availableSkills,
  isRequest,
  isResponse,
  hook,
  builtin,
};
