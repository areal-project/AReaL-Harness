import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { waitFor } from "./remote-relay-fixture.mjs";
import { nativeHostFixture, nativeCoreProject } from "./remote-native-host-fixture.mjs";

export async function mobileCoreFixture(t, { commands = false } = {}) {
  const host = await nativeHostFixture(t, { tlsHome: process.env.AREAL_IOS_TLS_HOME });
  const project = await nativeCoreProject(t, host);
  let requests = 0;
  const held = new Set();
  const heldMarkers = new Set();
  const model = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ object: "list", data: [{ id: "fixture" }, { id: "fixture-alt" }] }),
      );
      return;
    }
    requests++;
    const input = JSON.parse(body);
    const content = input.messages?.filter((value) => value.role === "user").at(-1)?.content;
    const latest =
      typeof content === "string"
        ? content
        : (content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `MOBILE_REPLY_${requests}` }, finish_reason: null }] })}\n\n`,
    );
    const marker = ["MOBILE_HOLD_QUEUE", "MOBILE_HOLD_STOP"].find(
      (value) => typeof latest === "string" && latest === value,
    );
    const hold = commands && marker && !heldMarkers.has(marker);
    console.log(
      JSON.stringify({
        modelRequest: requests,
        model: input.model,
        hold: !!hold,
        queued: String(JSON.stringify(latest)).includes("MOBILE_QUEUED_AFTER_CURRENT"),
      }),
    );
    const finish = () =>
      response.end(
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    if (hold) {
      heldMarkers.add(marker);
      held.add(finish);
      response.on("close", () => held.delete(finish));
    } else finish();
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  });
  await project.core.call("areal/provider/upsert", {
    provider: {
      id: "mobile-fixture",
      revision: 0,
      endpoint: `http://127.0.0.1:${model.address().port}/v1/chat/completions`,
      protocol: "chatCompletions",
      models: ["fixture-alt"],
      modelCapabilities: {
        "fixture-alt": {
          tools: true,
          vision: false,
          reasoning: true,
          reasoningEffortOptions: ["low", "high"],
        },
      },
      parameters: {},
    },
    expectedRevision: 0,
  });
  const secondProjectId = randomUUID();
  const secondWorkspace = join(host.evidence.root, "Second project");
  await mkdir(secondWorkspace);
  await host.client.registerProject(randomUUID(), {
    projectId: secondProjectId,
    workspace: secondWorkspace,
    dataDir: join(host.evidence.root, "second-state"),
    source: { kind: "cli" },
    defaultBinding: false,
  });
  const projectIds = [
    project.alias,
    createHash("sha256").update(`host:${secondProjectId}`).digest("hex").slice(0, 24),
  ];
  const { thread } = await project.core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: project.workspace,
    agentProfile: { id: "fixture", revision: "v1" },
  });
  const threadId = thread.id;
  await project.core.call("areal/thread/configure", {
    threadId,
    expectedRevision: 1,
    model: { providerId: "mobile-fixture", modelId: "fixture-alt" },
  });
  const send = async (text) => {
    const current = await project.core.call("thread/read", { threadId, includeTurns: true });
    const admitted = await project.core.call("areal/turn/start", {
      requestId: randomUUID(),
      threadId,
      input: [{ type: "text", text }],
      expectedConfigRevision: current.thread.desktop.configuration.revision,
    });
    await waitFor(async () => {
      const value = await project.core.call("thread/read", { threadId, includeTurns: true });
      return (
        value.thread.turns.find((turn) => turn.id === admitted.turn.id)?.status === "completed"
      );
    }, 20000);
  };
  for (let turn = 1; turn <= (commands ? 0 : 52); turn++)
    await send(`MOBILE_HISTORY_${String(turn).padStart(3, "0")}`);
  return {
    ...host,
    project,
    projectIds,
    threadId,
    send,
    modelRequests: () => requests,
    release: () => {
      for (const finish of held) finish();
      held.clear();
    },
  };
}
