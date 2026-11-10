"use strict";
const { HostCoreClient } = require("@areal/workbench-service/host-core-client");

/**
 * 测试用 Host Core 投影：真实的 HostCoreClient，Host 一侧由夹具回答。
 * 准入规则在 Rust Host 里验证，这里默认放行，只为让后台走到被测逻辑。
 * @param {{request:(method:string,params:unknown)=>unknown,capabilities?:unknown,admit?:(params:unknown)=>unknown}} options
 */
async function hostCoreClient({ request, capabilities = {}, admit = () => ({ admitted: true }) }) {
  const client = new HostCoreClient({
    sourceId: "fixture-source",
    projectId: "fixture-project",
    host: async (method, params) => {
      if (method === "core.attach")
        return {
          lease: "fixture-lease",
          coreInstanceId: "fixture-core",
          coreGeneration: "fixture-generation",
          connectionId: "fixture-connection",
          capabilities,
        };
      if (method === "core.detach") return {};
      if (method === "execution.admit") return admit(params);
      if (method === "core.request" || method === "execution.submit")
        return { result: await request(params.method, params.params), sequence: 0 };
      throw new Error(`unexpected Host method ${method}`);
    },
  });
  await client.connect();
  return client;
}

module.exports = { hostCoreClient };
