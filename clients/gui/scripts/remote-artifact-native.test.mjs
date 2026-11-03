import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { pushRelay, phone, until, runWithIsolatedCA } from "./remote-native-push-fixture.mjs";

if (!process.env.RC12_TLS_HOME) {
  test("native artifact reads use the isolated process CA", async () => {
    await runWithIsolatedCA(import.meta.filename);
  });
} else {
  test(
    "phone reads an original native Task image through Rust Host",
    { timeout: 180000 },
    async (t) => {
      const relay = await pushRelay(t);
      const f = await nativeHostFixture(t);
      const project = await nativeCoreProject(t, f);
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      );
      const proof = { owner: "Rust Host", projectId: project.projectId, responses: [] };
      t.after(() =>
        writeFile(
          join(f.evidence.root, "native-task-artifact.json"),
          JSON.stringify(proof, null, 2),
        ),
      );
      let generated = false;
      const model = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const strings = (value) =>
          typeof value === "string"
            ? [value]
            : value && typeof value === "object"
              ? Object.values(value).flatMap(strings)
              : [];
        const context = strings(body.input).find((text) =>
          text.includes("Current authoritative goal: "),
        );
        const goal = context ? JSON.parse(context.split("Current authoritative goal: ")[1]) : null;
        assert.ok(Number.isSafeInteger(goal?.revision), "real Task authoritative Goal context");
        const events = generated
          ? [{ type: "response.output_text.delta", delta: "Original Task image ready" }]
          : [
              {
                type: "response.output_item.done",
                item: { type: "image_generation_call", result: png.toString("base64") },
              },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  id: randomUUID(),
                  call_id: randomUUID(),
                  name: "goal_update",
                  arguments: JSON.stringify({
                    expectedRevision: goal.revision,
                    status: "complete",
                    summary: "Original image generated",
                    evidence: ["native AgentMedia image output"],
                    remaining: [],
                  }),
                },
              },
            ];
        generated = true;
        events.push({
          type: "response.completed",
          response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2 } },
        });
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      });
      await new Promise((done) => model.listen(0, "127.0.0.1", done));
      t.after(async () => {
        model.closeAllConnections();
        await new Promise((done) => model.close(done));
      });
      await project.core.call("areal/provider/upsert", {
        provider: {
          id: "fixture-artifact",
          revision: 0,
          endpoint: `http://127.0.0.1:${model.address().port}/v1/responses`,
          protocol: "responses",
          models: ["fixture"],
          parameters: {},
        },
        expectedRevision: 0,
      });
      await f.remote.control({
        operation: "enable",
        relay: relay.origin,
        code: relay.enrollment(),
        confirmed: true,
      });
      await until(async () => (await f.remote.refresh()).connected, "native Relay ready");
      const device = await phone(t, f.remote, project.alias, undefined, true);
      const rpc = async (method, params = {}, commandId) => {
        const context = {
          projectId: project.alias,
          ...(method === "session.create"
            ? {
                gatewayGeneration: device.active.gatewayGeneration,
                grantRevision: device.active.grantRevision,
                serviceGeneration: project.service.generation,
              }
            : {}),
        };
        const result = await device.rpc(method, params, commandId, context);
        proof.responses.push({ method, result });
        return result;
      };
      assert.ok((await device.rpc("host.describe")).result.methods.includes("artifact.read"));
      const created = await rpc("session.create", {}, randomUUID());
      assert.equal(created.result?.admissionState, "accepted", JSON.stringify(created));
      const threadId = created.result.threadId;
      const task = await project.core.call("areal/goal/create", {
        requestId: randomUUID(),
        threadId,
        expectedRevision: 0,
        objective: "Generate one original image and complete the Task.",
        maxTurns: 3,
        modelOverride: {
          model: { providerId: "fixture-artifact", modelId: "fixture" },
          parameters: {},
        },
      });
      proof.task = task;
      assert.ok(task.taskId && task.runId, "a real foreground Task owns the image Turn");
      let nativeTask;
      await until(async () => {
        nativeTask = await project.core.call("areal/task/read", { taskId: task.taskId });
        return nativeTask.runs.find((run) => run.id === task.runId)?.status === "completed";
      }, "original image Task completes");
      const native = await project.core.call("thread/read", { threadId, includeTurns: true });
      const turn = native.thread.turns.find((turn) =>
        turn.items.some((item) => item.type === "agentMedia"),
      );
      assert.ok(turn, "native persisted AgentMedia belongs to the original Task Thread");
      const item = turn.items.find((item) => item.type === "agentMedia");
      assert.equal(
        item.media.uri,
        `areal://blob/${createHash("sha256").update(png).digest("hex")}`,
      );
      const review = await rpc("review.read", { threadId, turnId: turn.id, itemId: item.id });
      assert.equal(review.result.artifacts.length, 1, JSON.stringify(review));
      const artifact = review.result.artifacts[0];
      assert.equal(artifact.itemId, item.id);
      assert.ok(artifact.artifactRef.length <= 2048);
      const bytes = [];
      for (let offset = 0; offset !== null;) {
        const chunk = await rpc("artifact.read", {
          artifactRef: artifact.artifactRef,
          offset,
          length: 17,
        });
        assert.ok(chunk.result, JSON.stringify(chunk));
        assert.equal(chunk.result.threadId, threadId);
        assert.equal(chunk.result.turnId, turn.id);
        assert.equal(chunk.result.itemId, item.id);
        assert.equal(chunk.result.serviceGeneration, project.service.generation);
        assert.equal(chunk.result.offset, offset);
        assert.equal(chunk.result.totalBytes, png.length);
        assert.deepEqual(chunk.result.raster, { mime: "image/png", width: 1, height: 1 });
        bytes.push(Buffer.from(chunk.result.base64, "base64"));
        offset = chunk.result.nextOffset;
      }
      assert.deepEqual(Buffer.concat(bytes), png);
      assert.equal(nativeTask.runs.find((run) => run.id === task.runId).threadId, threadId);
      assert.equal(turn.id, task.turnId);
      proof.nativeTask = nativeTask;
      proof.original = {
        threadId,
        turnId: turn.id,
        itemId: item.id,
        sha256: createHash("sha256").update(Buffer.concat(bytes)).digest("hex"),
      };
    },
  );
}
