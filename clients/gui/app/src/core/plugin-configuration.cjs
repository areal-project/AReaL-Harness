// @ts-check
"use strict";
const { readPluginReadiness } = require("@areal/workbench/desktop-contract/management");
const { serverStatus } = require("./provider-contract.cjs");

/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend
 * @param {import('./project-state.cjs').CoreProject} project
 * @param {import('@areal/workbench/desktop-contract/management').ManagementRequestMap['pluginUserConfigSave']} request */
async function configurePluginValues(backend, project, request) {
  if (
    backend.providerUpdating ||
    backend.resourcesUpdating ||
    backend.starting.size ||
    backend.hasWork()
  )
    throw new Error("请等待任务和操作完成后保存插件配置");
  const client = project.client;
  if (!client) throw new Error("Core 连接不可用");
  const detail = await client.request(
    "areal/plugin/read",
    { id: request.id },
    { decode: readPluginReadiness },
  );
  if (
    detail.installedDigest !== request.expectedDigest ||
    detail.revision !== request.expectedRevision
  )
    throw new Error("插件快照或配置版本已变化，请刷新后保存");
  const fields = detail.userConfiguration?.fields ?? {};
  const clearKeys = request.clearKeys ?? [];
  const updates = [...Object.keys(request.values), ...Object.keys(request.secrets), ...clearKeys];
  if (
    new Set(updates).size !== updates.length ||
    updates.some((key) => !Object.hasOwn(fields, key))
  )
    throw new Error("插件配置字段无效或重复");
  for (const [key, value] of Object.entries(request.values))
    if (fields[key].definition.sensitive || fields[key].definition.type !== value.kind)
      throw new Error("插件普通配置与字段定义不匹配");
  for (const [key, secret] of Object.entries(request.secrets))
    if (!fields[key].definition.sensitive || fields[key].definition.type !== "string" || !secret)
      throw new Error("插件敏感配置与字段定义不匹配");
  backend.providerUpdating = true;
  try {
    /** @type {import('@areal/workbench/desktop-contract/management').ProtocolRequestMap['pluginUserConfigSave']['values']} */
    const values = { ...request.values };
    for (const [key, secret] of Object.entries(request.secrets)) {
      const reference = await backend.providers.config.credential(secret);
      if (!reference) throw new Error("插件凭据未保存");
      // 配置键允许 __proto__，写成自有属性以保留原字段名。
      Object.defineProperty(values, key, {
        enumerable: true,
        value: { kind: "secretRef", value: reference.replace(/^AREAL_CREDENTIAL_/, "") },
      });
    }
    if (Object.keys(request.secrets).length) {
      await restartForPluginCredentials(backend, project);
    }
    return await backend.submit(
      project,
      "areal/plugin/userConfig/set",
      {
        id: request.id,
        expectedRevision: request.expectedRevision,
        expectedDigest: request.expectedDigest,
        values,
        ...(clearKeys.length ? { clearKeys } : {}),
      },
      { requestId: request.requestId },
    );
  } finally {
    backend.providerUpdating = false;
    backend.onChange();
  }
}
/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {import('./project-state.cjs').CoreProject} project */
async function restartForPluginCredentials(backend, project) {
  if (!project.client) throw new Error("Core 连接不可用");
  const drained = await project.client.request(
    "areal/server/drain",
    { strategy: "ifIdle", timeoutMs: 30000 },
    { timeoutMs: 35000, decode: serverStatus },
  );
  if (!drained.restartSafe) throw new Error("后台尚未结算，请等待后重新载入凭据");
  await backend.restartProject(project);
}
/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {import('./project-state.cjs').CoreProject} project */
async function reloadPluginCredentials(backend, project) {
  if (
    backend.providerUpdating ||
    backend.resourcesUpdating ||
    backend.starting.size ||
    backend.hasWork()
  )
    throw new Error("请等待任务和操作完成后重新载入插件凭据");
  backend.providerUpdating = true;
  try {
    await restartForPluginCredentials(backend, project);
    return { reloaded: true };
  } finally {
    backend.providerUpdating = false;
    backend.onChange();
  }
}
module.exports = { configurePluginValues, reloadPluginCredentials };
