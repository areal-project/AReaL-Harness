import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listCoreSides, readCoreThread } from "./core-observation.mjs";

const gui = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const require = createRequire(import.meta.url);
const { executeCore } = require("./core-process-fixture.cjs");

test("real Core observation reads the created thread", { timeout: 120000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "areal-observe-")));
  const workspace = join(root, "workspace");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("AREAL_"))),
    HOME: join(root, "user"),
    AREAL_CORE_HOME: join(root, "core"),
    AREAL_HARNESS_HOME: join(root, "home"),
    AREAL_HARNESS_SERVICE_HOME: join(root, "services"),
    AREAL_GUI_USER_DATA: join(root, "gui"),
    OTEL_SDK_DISABLED: "true",
  };
  const binary = resolve(process.env.AREAL_CORE_BIN ?? join(gui, "../../target/debug/areal"));
  let service,
    client,
    stopped = false;
  try {
    await mkdir(workspace);
    await mkdir(env.HOME);
    const config = join(root, "config.toml");
    await writeFile(
      config,
      'schema_version = 1\n[model]\nname = "fixture"\n[model.providers.default]\nprotocol = "chat-completions"\nendpoint = "http://127.0.0.1:1"\n',
    );
    service = JSON.parse(
      (
        await executeCore(
          binary,
          ["service", "ensure", "--workspace", workspace, "--config", config, "--json"],
          {
            env,
            timeout: 60000,
          },
        )
      ).stdout,
    );
    const { connect } = await import("../../../../examples/desktop-api/client.mjs");
    client = await connect(service.endpoint, service.authFile);
    const { thread } = await client.call("areal/thread/start", {
      requestId: randomUUID(),
      cwd: workspace,
    });
    const observed = await readCoreThread({
      binary,
      env,
      gui,
      threadId: thread.id,
      workspace,
      project: {
        core: { instanceId: service.generation, serviceGeneration: service.generation },
      },
    });
    assert.equal(observed.id, thread.id);
    assert.deepEqual(await listCoreSides({ binary, env, gui, threadId: thread.id, workspace }), []);
  } finally {
    await client?.close();
    if (service) {
      const receipt = JSON.parse(
        (
          await executeCore(
            binary,
            ["service", "stop", "--instance", service.serviceId, "--cancel", "--json"],
            { env, timeout: 60000 },
          )
        ).stdout,
      );
      assert.equal(receipt.state, "stopped");
      assert.equal(receipt.generation, service.generation);
      stopped = true;
    }
    if (stopped) await rm(root, { recursive: true, force: true });
    else console.error(`Retained observation fixture: ${root}`);
  }
});
