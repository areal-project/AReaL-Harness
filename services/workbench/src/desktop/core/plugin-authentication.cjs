// @ts-check
"use strict";
// Values stay inside the existing encrypted credential owner and trusted launch inputs.
const { record, pluginConnections } = require("./resource-contract.cjs");
const { serverStatus } = require("./provider-contract.cjs");
const fields = [
  "clientSecretRef",
  "privateKeyRef",
  "privateKeyId",
  "clientMetadataUrl",
  "apiKeyRef",
  "callbackUrl",
];
/** @param {InstanceType<typeof import("./backend.cjs").CoreBackend>} backend @param {import("./project-state.cjs").CoreProject} project @param {Record<string,unknown>} request */
async function configurePluginAuthentication(backend, project, request) {
  if (
    backend.providerUpdating ||
    backend.resourcesUpdating ||
    backend.starting.size ||
    backend.hasWork()
  )
    throw Error("请等待任务和操作完成后保存认证配置");
  const client = project.client;
  if (!client) throw Error("Core 连接不可用");
  const current = await client.request("areal/plugin/mcp/list", {}, { decode: pluginConnections });
  const row = current.data?.find((item) => item.pluginId === request.id);
  if (
    !row ||
    row.installedDigest !== request.expectedDigest ||
    !Array.isArray(row.servers) ||
    !row.servers.some((server) => record(server) && server.serverId === request.server)
  )
    throw Error("插件服务器或已安装摘要已变化");
  if (row.state === "connected" || row.state === "partial")
    throw Error("请先断开插件，再更改认证配置");
  const source = record(request.configuration) ? request.configuration : {};
  const configuration = Object.fromEntries(
    fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
  const values = request.credentials ?? {};
  if (
    !record(values) ||
    Object.keys(values).some((key) => !["clientSecret", "privateKeyPem", "apiKey"].includes(key))
  )
    throw Error("认证凭据字段无效");
  backend.providerUpdating = true;
  try {
    let changed = false;
    for (const { field, ref, privateKey } of [
      { field: "clientSecret", ref: "clientSecretRef", privateKey: false },
      { field: "privateKeyPem", ref: "privateKeyRef", privateKey: true },
      { field: "apiKey", ref: "apiKeyRef", privateKey: false },
    ]) {
      if (values[field] === undefined || values[field] === "") continue;
      const reference = await backend.providers.config.credential(values[field], { privateKey });
      if (!reference) throw Error("认证凭据不能为空");
      configuration[ref] = reference.replace(/^AREAL_CREDENTIAL_/, "");
      changed = true;
    }
    if (changed) {
      const drained = await client.request(
        "areal/server/drain",
        { strategy: "ifIdle", timeoutMs: 30000 },
        { timeoutMs: 35000, decode: serverStatus },
      );
      if (!drained.restartSafe) throw Error("后台尚未结算，请等待后重试");
      await backend.restartProject(project);
    }
    return await backend.submit(
      project,
      "areal/plugin/auth/configure",
      {
        id: request.id,
        server: request.server,
        expectedDigest: request.expectedDigest,
        configuration,
      },
      { requestId: typeof request.requestId === "string" ? request.requestId : undefined },
    );
  } finally {
    backend.providerUpdating = false;
    backend.onChange();
  }
}
module.exports = { configurePluginAuthentication };
