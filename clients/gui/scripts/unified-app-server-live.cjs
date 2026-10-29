// 真实后端验收：同一客户端仅替换 endpoint/凭据文件；不会启动模型替身。
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { CloudClient } = require("../app/src/core/cloud-client.cjs");
const { CloudSession } = require("../app/src/core/cloud-session.cjs");

async function main() {
  const [configPath, output] = process.argv.slice(2);
  if (!configPath || !output)
    throw Error("usage: node unified-app-server-live.cjs CONFIG OUTPUT_DIRECTORY");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const marker = "UNIFIED_" + randomUUID().replaceAll("-", "");
  const file = marker.toLowerCase() + ".txt";
  let binding = {},
    events = [],
    session;
  const open = () =>
    new CloudSession({
      platform: new CloudClient(config),
      binding,
      save: async (value) => {
        binding = value;
        await fs.writeFile(path.join(output, "binding.json"), JSON.stringify(binding), {
          mode: 0o600,
        });
      },
      onNotification: (method, params) => events.push({ method, params }),
    });
  const query = async (text) => {
    const start = events.length;
    const accepted = await session.query(text);
    assert(accepted.turn?.id, "turn accepted");
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const done = events
        .slice(start)
        .find((e) => e.method === "turn/completed" && e.params.turn.id === accepted.turn.id);
      if (done) {
        assert.equal(done.params.turn.status, "completed");
        assert(!done.params.turn.error);
        return events.slice(start);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error("turn completion timeout");
  };
  try {
    session = open();
    await session.read();
    const first = await query(
      `请调用文件工具在当前工作区根目录创建 ${file}，内容精确为 ${marker}，不要换行。然后调用工具读回，并回复文件内容。`,
    );
    assert(
      first.some((e) => e.method === "item/agentMessage/delta" && e.params.delta),
      "real streaming",
    );
    const original = binding.threadId;
    session.close();
    session = open();
    const restored = await session.read();
    assert.equal(restored.thread.id, original);
    assert(restored.thread.turns.some((t) => t.status === "completed"));
    const second = await query(`请调用工具再次读取当前工作区根目录的 ${file}，仅回复文件内容。`);
    assert(
      second
        .filter((e) => e.method === "item/agentMessage/delta")
        .map((e) => e.params.delta)
        .join("")
        .includes(marker),
      "persistent file read",
    );
    const listed = await session.client.request("thread/list", {});
    assert(
      listed.data.some((t) => t.id === original),
      "native thread listing",
    );
    const saved = await session.read();
    await fs.writeFile(path.join(output, "events.json"), JSON.stringify(events, null, 2), {
      mode: 0o600,
    });
    await fs.writeFile(path.join(output, "history.json"), JSON.stringify(saved, null, 2), {
      mode: 0o600,
    });
    const result = {
      endpoint: config.baseURL,
      threadId: original,
      marker,
      file,
      turns: saved.thread.turns.map((t) => ({ id: t.id, status: t.status })),
      streaming: true,
      reconnect: true,
      threadList: true,
    };
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    console.log(JSON.stringify(result));
  } finally {
    session?.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
