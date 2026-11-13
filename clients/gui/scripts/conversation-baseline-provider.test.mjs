import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { baselineContent } from "./support/conversation-baseline.mjs";
import { createBaselineServer } from "./support/conversation-baseline-provider.mjs";

test(
  "ACP and SSE deliver identical gated baseline chunks through real transports",
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "baseline-protocol-"));
    const gatePath = join(dir, "release");
    const logPath = join(dir, "requests.jsonl");
    const server = createBaselineServer({ gatePath, logPath });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const child = spawn(
      process.execPath,
      [new URL("./support/conversation-baseline-provider.mjs", import.meta.url).pathname, "acp"],
      {
        env: { ...process.env, BASELINE_GATE: gatePath, BASELINE_LOG: logPath },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const exited = once(child, "exit");
    const pending = new Map();
    const acpChunks = [];
    let nextId = 0;
    let firstChunk;
    const initialChunk = new Promise((resolve) => {
      firstChunk = resolve;
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.method === "session/update") {
        acpChunks.push(message.params.update.content.text);
        firstChunk();
      } else {
        const result = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) result?.reject(new Error(message.error.message));
        else result?.resolve(message.result);
      }
    });
    const rpc = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    try {
      assert.equal((await rpc("initialize")).agentCapabilities.loadSession, true);
      const { sessionId } = await rpc("session/new");
      const prompt = rpc("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "BASELINE:STREAM" }],
      });
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        {
          method: "POST",
          body: JSON.stringify({
            messages: [
              { role: "user", content: "BASELINE:STREAM" },
              { role: "user", content: "AReaL runtime context (not a user request): guidance" },
            ],
          }),
        },
      );
      const reader = response.body.getReader();
      const first = await reader.read();
      await initialChunk;
      assert.deepEqual(acpChunks, [baselineContent.initialResponse]);
      assert.ok(new TextDecoder().decode(first.value).includes("Paragraph 080"));
      await writeFile(gatePath, "release");
      let body = new TextDecoder().decode(first.value);
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        body += new TextDecoder().decode(result.value);
      }
      assert.equal((await prompt).stopReason, "end_turn");
      const sseChunks = body
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice(6)).choices[0].delta.content)
        .filter((text) => text !== undefined);
      assert.deepEqual(acpChunks, [baselineContent.initialResponse, ...baselineContent.stream]);
      assert.deepEqual(sseChunks, acpChunks);
      const records = (await readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(records.filter((record) => record.kind === "request").length, 2);
      assert.equal(records.filter((record) => record.kind === "chunk").length, 82);
      await rpc("session/close", { sessionId });
      await rpc("session/load", { sessionId });
      assert.equal(
        (
          await rpc("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: "normal short message" }],
          })
        ).stopReason,
        "end_turn",
      );
      assert.equal(acpChunks.at(-1), "BASELINE_SHORT_COMPLETE");
      const prediction = await fetch(
        `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
        {
          method: "POST",
          body: JSON.stringify({
            messages: [
              {
                role: "system",
                content: "Predict the next user prompt from the conversation data.",
              },
              { role: "user", content: "BASELINE:STREAM" },
            ],
          }),
        },
      );
      const predictionBody = await prediction.text();
      assert.ok(predictionBody.includes("BASELINE_SHORT_COMPLETE"));
      assert.ok(!predictionBody.includes("Paragraph 001"));
    } finally {
      child.stdin.end();
      await exited;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
