import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../../app/package.json", import.meta.url));
const { HostClient: LocalHostClient } = require("@areal/client/node");
const WebSocket = require("ws");
const esbuild = createRequire(new URL("../../packages/browser-data/package.json", import.meta.url))(
  "esbuild",
);
let modulePromise;
async function clientModule() {
  modulePromise ??= esbuild
    .build({
      stdin: {
        contents:
          'export { HostClient } from "./index.ts"; export { connectWebSocket } from "./websocket.ts";',
        resolveDir: fileURLToPath(new URL("../../packages/client/src/", import.meta.url)),
      },
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
    })
    .then(
      ({ outputFiles }) =>
        import(
          `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
        ),
    );
  return modulePromise;
}

// 独立观察原 Host，不经过 Renderer 故障代理；界面可见性仍由调用方的 DOM 断言证明。
export async function nativeRecoverySnapshot(env, target = {}) {
  const local = new LocalHostClient();
  let reads;
  try {
    await local.connect(env.AREAL_HARNESS_SERVICE_HOME);
    const bootstrap = await local.request("web.ticket", {
      origin: "areal-ui://app",
      expectedGeneration: local.generation,
      profile: env.AREAL_GUI_USER_DATA,
    });
    const { HostClient, connectWebSocket } = await clientModule();
    const options = { origin: "areal-ui://app", bootstrap: async () => bootstrap };
    reads = new HostClient({
      ...options,
      transport: ({ current, signal, onEvent }) =>
        connectWebSocket(
          options,
          current,
          signal,
          onEvent,
          () => {},
          (url) => new WebSocket(url, { origin: options.origin }),
        ),
    });
    await reads.retry();
    const shell = reads.readsSnapshot().shell;
    assert.equal(shell.state, "fresh", "Rust Host shell observation must be fresh");
    const projects = shell.value.snapshot.projects
      .filter((entry) => entry.alias?.sourceId === bootstrap.preferredSourceId)
      .map((entry) => ({
        id: entry.alias.projectId,
        hostProjectId: entry.projectId,
        root: entry.workspace,
        core: { serviceGeneration: entry.serviceGeneration },
        state: { connected: entry.state === "ready", threads: {} },
        serviceState: entry.state,
        scheduleActivationSuppressed: entry.scheduleActivationSuppressed,
      }));
    if (target.threadId) {
      const project = projects.find((entry) => entry.id === target.projectId);
      assert.ok(project, "original source project must still be registered");
      await reads.selectSession({
        projectId: project.hostProjectId,
        threadId: target.threadId,
        persisted: project.serviceState !== "ready",
      });
      const session = reads.readsSnapshot().session;
      assert.equal(session.state, "fresh", "Rust Host original session observation must be fresh");
      assert.equal(session.value.threadId, target.threadId);
      assert.equal(session.value.projectId, project.hostProjectId);
      project.state.threads[target.threadId] = session.value.snapshot.thread;
    }
    return {
      connection: { state: reads.snapshot().connection },
      projects,
      host: { hostId: local.hostId, generation: local.generation },
    };
  } finally {
    reads?.close();
    local.close();
  }
}
