// 既有 JS owner 仅作为冻结行为语料，由明确的测试入口调用。
"use strict";
const originalRequire = require("node:module").createRequire(
  require.resolve("@areal/workbench-service/desktop/core/providers.cjs"),
);
const { SubscriptionStore, requestAudit } = require("@areal/workbench-service/desktop/core/subscription.cjs");
async function legacyOpenAI() {
  if (!this.openaiPromise)
    this.openaiPromise = import(originalRequire.resolve("@areal/chatgpt-provider/core"))
      .then(({ CoreSubscription }) => {
        this.openaiStore = new SubscriptionStore(this.backend, this.hostVault);
        const onRequest =
          process.env.AREAL_CORE_PROVIDER_AUDIT === "1"
            ? requestAudit(this.backend.home)
            : undefined;
        const transport = this.transport;
        if (!transport) throw new Error("订阅传输尚未初始化");
        const service = new CoreSubscription({
          store: this.openaiStore,
          fetch: async (...args) => (await this.network()).fetch(...args),
          token: this.openaiToken,
          port: transport.port,
          onListen: async (port) => {
            const next = { ...transport, port };
            const saved = await this.hostVault.replace(
              {
                kind: "subscriptionTransport",
                sourceId: this.backend.host.sourceId,
              },
              this.transportRevision,
              next,
            );
            transport.port = port;
            this.transportRevision = saved.revision;
          },
          kind: "openai",
          onRequest,
        });
        service.account.activateAuthorized = async (id, activate) => {
          if (
            this.backend.hasWork() ||
            this.backend.activeCommands ||
            this.backend.providerUpdating ||
            this.backend.resourcesUpdating ||
            this.backend.starting.size
          )
            return false;
          this.backend.providerUpdating = true;
          try {
            for (const project of this.backend.projects.values()) {
              if (!this.manages(project)) continue;
              if (project.service && !project.client?.ready) return false;
              if (
                project.client?.ready &&
                !(
                  await project.client.request(
                    "areal/server/status",
                    {},
                    { decode: providerContract.serverStatus },
                  )
                ).restartSafe
              )
                return false;
            }
            await activate();
            return true;
          } finally {
            this.backend.providerUpdating = false;
          }
        };
        this.openaiService = service;
        return service;
      })
      .catch((error) => {
        this.openaiPromise = null;
        throw error;
      });
  return this.openaiPromise;
}
module.exports = { legacyOpenAI };
