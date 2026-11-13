// @ts-check
"use strict";
const { readPluginReadiness } = require("@areal/workbench/desktop-contract/management");

/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend
 * @param {import('./project-state.cjs').CoreProject} project
 * @param {import('@areal/workbench/desktop-contract/management').ManagementRequestMap['pluginUserConfigSave']} request */
async function configurePluginValues(backend, project, request) {
  if (backend.providerUpdating || backend.resourcesUpdating || backend.starting.size)
    throw new Error("请等待操作完成后保存插件配置");
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
    /** @type {Record<string, string>} */
    const credentials = {};
    for (const [key, secret] of Object.entries(request.secrets)) {
      const reference = await backend.providers.config.credential(secret);
      if (!reference) throw new Error("插件凭据未保存");
      const ref = reference.replace(/^AREAL_CREDENTIAL_/, "");
      // 交给 Core 的是 vault 里规范化后的值，与重启时注入的一致。
      credentials[ref] = backend.providers.config.key({ apiKeyEnv: reference });
      // 配置键允许 __proto__，写成自有属性以保留原字段名。
      Object.defineProperty(values, key, {
        enumerable: true,
        value: { kind: "secretRef", value: ref },
      });
    }
    const reloadDeferred = Object.keys(credentials).length
      ? await registerPluginCredentials(backend, project, credentials)
      : false;
    const result = await backend.submit(
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
    return reloadDeferred
      ? { .../** @type {Record<string, unknown>} */ (result), reloadDeferred: true }
      : result;
  } finally {
    backend.providerUpdating = false;
    backend.onChange();
  }
}
/**
 * 新凭据已存进 Host vault，再按引用交给在线 Core，不重启。本项目必须成功；其他项目登记失败时
 * 下次启动从 vault 取，返回 true 让界面提示稍后生效。
 * @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend
 * @param {import('./project-state.cjs').CoreProject} project
 * @param {Record<string, string>} credentials 引用（不含 AREAL_CREDENTIAL_ 前缀）→ 值
 */
async function registerPluginCredentials(backend, project, credentials) {
  if (!project.client) throw new Error("Core 连接不可用");
  await project.client.request("areal/plugin/credentials/register", { credentials });
  let deferred = false;
  for (const other of backend.projects?.values?.() ?? []) {
    if (
      other === project ||
      !other.client ||
      (backend.providers.manages && !backend.providers.manages(other))
    )
      continue;
    try {
      await other.client.request("areal/plugin/credentials/register", { credentials });
    } catch {
      deferred = true;
    }
  }
  return deferred;
}
module.exports = { configurePluginValues, registerPluginCredentials };
