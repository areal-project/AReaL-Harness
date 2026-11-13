import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);

async function withCore(
  { binary, env, gui, threadId, project, workspace, inventory, connect },
  observe,
) {
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
    return await observe(client);
  } finally {
    client.close();
  }
}

export async function readCoreThread(options) {
  return withCore(
    options,
    async (client) =>
      (await client.request("thread/read", { threadId: options.threadId, includeTurns: true }))
        .thread,
  );
}

export async function listCoreSides(options) {
  return withCore(options, async (client) => {
    const ids = [];
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.request("areal/conversation/list", {
        view: "side",
        includeArchived: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      assert.ok(Array.isArray(page.data), "Core side list data must be an array");
      for (const item of page.data) {
        assert.ok(typeof item.id === "string" && item.id, "Core side list identity is required");
        ids.push(item.id);
      }
      cursor = page.nextCursor;
      if (cursor) {
        assert.ok(
          typeof cursor === "string" && !cursors.has(cursor),
          "Core side list cursor must advance",
        );
        cursors.add(cursor);
      }
    } while (cursor);
    return ids;
  });
}
