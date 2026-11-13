import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);

export async function readCoreThread({
  binary,
  env,
  gui,
  threadId,
  project,
  workspace,
  inventory,
  connect,
}) {
  const execution = project?.state?.threads?.[threadId];
  const generation = (execution?.executionCore ?? project?.core)?.serviceGeneration;
  const expectedWorkspace = execution?.worktree?.directory ?? workspace;
  const records =
    inventory ??
    JSON.parse(
      (await execute(binary, ["service", "list", "--json"], { env, timeout: 20000 })).stdout,
    );
  const matches = (Array.isArray(records) ? records : [records]).filter(
    (record) =>
      record.state === "ready" &&
      (!generation || record.generation === generation) &&
      record.workspace === expectedWorkspace,
  );
  assert.equal(matches.length, 1, "target workspace must have exactly one matching ready Core");
  const descriptor = matches[0];
  if (!connect) {
    const require = createRequire(join(gui, "app/package.json"));
    const WebSocket = require("ws");
    const { CoreClient } = await import(
      pathToFileURL(join(gui, "packages/runtime-client/core.js"))
    );
    const auth = JSON.parse(await readFile(descriptor.authFile, "utf8"));
    const principal = auth.principals.find((item) => item.permissions.includes("observe"));
    assert.ok(principal?.token, "Core observation principal is required");
    connect = async () => {
      const client = new CoreClient({
        createSocket: () =>
          new WebSocket(descriptor.endpoint, {
            headers: { Authorization: `Bearer ${principal.token}` },
            followRedirects: false,
          }),
      });
      try {
        await client.connect();
      } catch (error) {
        client.close();
        throw error;
      }
      return client;
    };
  }
  const client = await connect(descriptor);
  try {
    return (await client.request("thread/read", { threadId, includeTurns: true })).thread;
  } finally {
    client.close();
  }
}
