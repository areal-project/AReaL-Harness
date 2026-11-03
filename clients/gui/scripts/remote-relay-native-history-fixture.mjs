import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { nativeCoreProject } from "./remote-native-host-fixture.mjs";
import { until } from "./remote-native-push-fixture.mjs";
import { respondToSessionName } from "../../../scripts/model-fixture.mjs";

export async function nativeHistory(t, fixture) {
  const native = await nativeCoreProject(t, fixture);
  const answers = new Map();
  const requests = [];
  const model = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (respondToSessionName(body, response)) return;
    const content = body.messages.findLast((message) => message.role === "user")?.content;
    const text =
      typeof content === "string"
        ? content
        : (content ?? []).map((part) => part.text ?? "").join("");
    const entry = [...answers].find(([input]) => text.includes(input));
    if (!entry) {
      response.writeHead(400);
      response.end("Unknown history fixture input");
      return;
    }
    requests.push(entry[0]);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: entry[1] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  });
  await native.core.call("areal/provider/upsert", {
    provider: {
      id: "relay-history",
      revision: 0,
      endpoint: `http://127.0.0.1:${model.address().port}/v1/chat/completions`,
      protocol: "chatCompletions",
      models: ["fixture"],
      parameters: {},
    },
    expectedRevision: 0,
  });
  const created = await native.core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: native.workspace,
    model: { providerId: "relay-history", modelId: "fixture" },
    options: { automaticSessionName: false },
  });
  const threadId = created.thread.id;
  const readThread = async () =>
    (await native.core.call("thread/read", { threadId, includeTurns: true })).thread;
  const readThreadIds = async () =>
    (await native.core.call("thread/list", { limit: 100 })).data.map((thread) => thread.id).sort();
  const turnIds = [];
  for (let index = 0; index < 50; index++) {
    const input = `History input ${index} ${randomUUID()} `.padEnd(1024, "u");
    const answer = `History answer ${index} `.padEnd(1024, "a");
    answers.set(input, answer);
    const started = await native.core.call("areal/turn/start", {
      requestId: randomUUID(),
      threadId,
      input: [{ type: "text", text: input }],
      expectedConfigRevision: 1,
    });
    turnIds.push(started.turn.id);
    await until(async () => {
      const turn = (await readThread()).turns.find((turn) => turn.id === started.turn.id);
      if (!turn || turn.status === "inProgress") return false;
      assert.equal(turn.status, "completed", JSON.stringify(turn));
      const user = turn.items.filter((item) => item.type === "userMessage");
      const assistant = turn.items.filter((item) => item.type === "agentMessage");
      assert.equal(user.length, 1);
      assert.equal(assistant.length, 1);
      assert.equal(user[0].content.map((part) => part.text ?? "").join(""), input);
      assert.equal(assistant[0].text, answer);
      return true;
    }, `original history turn ${index} completes`);
  }
  const thread = await readThread();
  assert.deepEqual(
    thread.turns.map((turn) => turn.id),
    turnIds,
  );
  assert.equal(thread.turns.flatMap((turn) => turn.items).length, 100);
  assert.deepEqual(requests, [...answers.keys()]);
  fixture.evidence.nativeHistory = {
    projectId: native.projectId,
    threadId,
    turnIds,
    itemIds: thread.turns.flatMap((turn) => turn.items.map((item) => item.id)),
    completedTurns: thread.turns.length,
    modelRequests: requests.length,
    textBytes: [...answers].reduce(
      (total, [input, answer]) => total + Buffer.byteLength(input) + Buffer.byteLength(answer),
      0,
    ),
  };
  return { ...native, threadId, thread, readThread, readThreadIds };
}
