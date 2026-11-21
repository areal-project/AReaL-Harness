import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectId = "reading-project";
const threadId = "reading-thread";
const generation = "reading-core";
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: gui, encoding: "utf8" }).trim();
const paragraph = (n) =>
  Array.from(
    { length: 30 },
    (_, i) => `History ${n} paragraph ${i}. Reading continuity keeps this sentence visible.`,
  ).join("\n\n");
const turn = (n) => ({
  id: `old-${n}`,
  status: "completed",
  durationMs: 2000,
  items: [
    { id: `user-${n}`, type: "userMessage", content: [{ type: "text", text: `Question ${n}` }] },
    {
      id: `commentary-${n}`,
      type: "agentMessage",
      phase: "commentary",
      text: `Investigating ${n}.`,
    },
    { id: `reasoning-${n}`, type: "reasoning", summary: [`Reasoning ${n}.`] },
    {
      id: `tool-${n}`,
      type: "dynamicToolCall",
      tool: "fs_read",
      arguments: { path: `file-${n}.txt` },
      status: "completed",
      success: true,
      contentItems: [{ type: "inputText", text: `Result ${n}` }],
    },
    {
      id: `tool-second-${n}`,
      type: "dynamicToolCall",
      tool: "fs_read",
      arguments: { path: `second-${n}.txt` },
      status: "completed",
      success: true,
      contentItems: [{ type: "inputText", text: `Second result ${n}` }],
    },
    {
      id: `command-${n}`,
      type: "dynamicToolCall",
      tool: "shell",
      arguments: { command: "pwd" },
      status: "completed",
      success: true,
      contentItems: [{ type: "inputText", text: "/isolated/reading" }],
    },
    { id: `answer-${n}`, type: "agentMessage", phase: "final_answer", text: paragraph(n) },
  ],
});
const baseline = () => ({
  thread: {
    id: "reading-thread",
    status: "active",
    turns: [
      turn("base"),
      {
        id: "live",
        status: "inProgress",
        items: [
          {
            id: "live-user",
            type: "userMessage",
            content: [{ type: "text", text: "Keep reading while output grows." }],
          },
          { id: "live-answer", type: "agentMessage", phase: "final_answer", text: "Live output." },
        ],
      },
    ],
  },
  history: { snapshotId: "reading-snapshot", nextCursor: "page:0", complete: false },
});

export async function createReadingFixture({ deferredTools = false, pageCount = 12 } = {}) {
  const detailItems = new Map();
  const defer = (turn, item, { oversized = false } = {}) => {
    const { items: _items, ...turnHead } = turn;
    const entry = {
      sourceThreadId: threadId,
      sourceTurnId: turn.id,
      sourceTurnStatus: turn.status,
      sourceItemId: item.id,
      turn: turnHead,
      item,
    };
    const cursor = `detail:${item.id}`;
    const raw = JSON.stringify(entry);
    if (!oversized) detailItems.set(cursor, { entry, raw });
    return {
      id: item.id,
      type: "historyDeferred",
      originalType: item.type,
      cursor,
      version: "fixture-v1",
      totalBytes: oversized ? 70 * 1024 * 1024 : Buffer.byteLength(raw),
    };
  };
  const initial = baseline();
  if (deferredTools) {
    const sourceTurn = initial.thread.turns[0];
    sourceTurn.items = sourceTurn.items.map((item) => {
      if (item.type !== "dynamicToolCall") return item;
      return {
        ...defer(sourceTurn, item),
        preview: { ...item, contentItems: [] },
      };
    });
  }
  const calls = [];
  const clients = new Map();
  let observation = structuredClone(initial);
  let concisePages = false;
  let observationRevision = 0;
  let failNext = false;
  let failures = 0;
  let hold = false;
  const held = [];
  const snapshot = () => ({
    calls: calls.length,
    cursors: calls.map(({ params }) => params.cursor),
    detailCalls: calls.filter(({ params }) => detailItems.has(params.cursor)),
    failures,
    pending: held.length,
    held: held.map(({ cursor }) => ({ cursor })),
    revision,
    scope: "production Messages and Host read services; deterministic Host RPC fixture",
  });
  const publish = () => {
    for (const { response } of clients.values())
      response.write(`event: fixture\ndata: ${JSON.stringify(snapshot())}\n\n`);
  };
  const publishObservation = () => {
    const { turns, ...thread } = observation.thread;
    const patch = {
      head: { ...observation, thread },
      order: turns.map(({ id }) => id),
      turns: turns.map(({ id, items, ...head }) => ({
        id,
        head: { ...head, id },
        order: items.map(({ id }) => id),
        items: items.map((value) => ({ id: value.id, value })),
      })),
    };
    for (const client of clients.values()) {
      if (!client.session) continue;
      client.sequence++;
      client.response.write(
        `data: ${JSON.stringify({
          ...client.session,
          sequence: client.sequence,
          event: "session.updated",
          patch,
        })}\n\n`,
      );
    }
  };
  const history = async (params) => {
    calls.push({ method: "session.history", params });
    const { snapshotId } = observation.history;
    if (failNext) {
      failNext = false;
      failures++;
      publish();
      throw Error("Injected history unavailability");
    }
    if (hold) {
      hold = false;
      await new Promise((resolve) => {
        held.push({ resolve, cursor: params.cursor });
        publish();
      });
    }
    publish();
    const detail = detailItems.get(params.cursor);
    if (detail)
      return {
        snapshotId,
        complete: true,
        nextCursor: null,
        data: [
          {
            ...detail.entry,
            item: undefined,
            fragment: {
              offsetUtf8: 0,
              nextOffsetUtf8: Buffer.byteLength(detail.raw),
              totalBytes: Buffer.byteLength(detail.raw),
              text: detail.raw,
              version: "fixture-v1",
            },
          },
        ],
      };
    const n = Number(params.cursor.split(":")[1]);
    const value = concisePages
      ? {
          id: `short-${n}`,
          status: "completed",
          items: [
            { id: `short-answer-${n}`, type: "agentMessage", text: `Short older reply ${n}.` },
          ],
        }
      : turn(n);
    return {
      snapshotId,
      data: value.items.map((item) => ({
        sourceThreadId: threadId,
        sourceTurnId: value.id,
        sourceItemId: item.id,
        sourceTurnStatus: value.status,
        turn: { id: value.id, status: value.status, durationMs: value.durationMs },
        item,
      })),
      nextCursor: n < pageCount - 1 ? `page:${n + 1}` : null,
      complete: n === pageCount - 1,
    };
  };
  const rpc = async (client, { method, params }) => {
    if (method === "shell.subscribe")
      return {
        ...client.identity,
        sequence: 0,
        subscriptionId: "reading-shell",
        snapshot: {
          projects: [
            {
              projectId,
              projectless: false,
              workspace: "/isolated/reading",
              state: "ready",
              serviceGeneration: generation,
              summaries: {
                state: "fresh",
                items: [{ id: threadId, name: "Reading fixture", desktop: { archived: false } }],
              },
              attention: { state: "unknown" },
            },
          ],
          navigation: [],
        },
      };
    if (method === "session.open" && params.threadId === threadId) {
      client.session = {
        ...client.identity,
        projectId,
        serviceGeneration: generation,
        subscriptionId: crypto.randomUUID(),
        threadId,
        view: "conversation",
      };
      client.sequence = 0;
      return { ...client.session, sequence: client.sequence, snapshot: observation };
    }
    if (
      method === "session.history" &&
      client.session?.subscriptionId === params.subscriptionId &&
      params.threadId === threadId &&
      params.view === "own"
    ) {
      const owner = { ...client.session, sequence: client.sequence };
      return { ...owner, page: await history(params) };
    }
    if (
      method === "subscription.close" &&
      client.session?.subscriptionId === params.subscriptionId
    ) {
      client.session = undefined;
      return { closed: true };
    }
    throw Error(`Unexpected fixture request ${method}`);
  };
  const vite = await createServer({
    root: join(gui, "renderer"),
    configFile: join(gui, "renderer/vite.config.ts"),
    mode: "design-system",
    optimizeDeps: {
      entries: ["test-fixtures/conversation-reading.tsx"],
      include: ["@areal/workbench/history-projection"],
    },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [
      {
        name: "conversation-reading-fixture",
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            const path = new URL(request.url, "http://fixture").pathname;
            if (path === "/__reading.html") {
              response.setHeader("Content-Type", "text/html");
              response.end(
                await server.transformIndexHtml(
                  path,
                  '<!doctype html><html><body style="margin:0"><div id="root"></div><script type="module" src="/test-fixtures/conversation-reading.tsx"></script></body></html>',
                ),
              );
              return;
            }
            if (path === "/__reading/events") {
              const clientId = new URL(request.url, "http://localhost").searchParams.get(
                "clientId",
              );
              if (!clientId || clients.has(clientId)) {
                response.writeHead(400);
                response.end();
                return;
              }
              response.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
              });
              clients.set(clientId, {
                response,
                identity: { connectionId: clientId, gatewayGeneration: "reading-gateway" },
              });
              publish();
              request.on("close", () => clients.delete(clientId));
              return;
            }
            if (!path.startsWith("/__reading/")) return next();
            response.setHeader("Content-Type", "application/json");
            try {
              if (path === "/__reading/state") {
                response.end(JSON.stringify(snapshot()));
                return;
              }
              let body = "";
              for await (const chunk of request) body += chunk;
              const input = JSON.parse(body || "{}");
              if (path === "/__reading/host") {
                const client = clients.get(request.headers["x-reading-client"]);
                if (!client) throw Error("Reading client is disconnected");
                response.end(JSON.stringify(await rpc(client, input)));
                return;
              }
              if (input.operation === "reobserve") {
                const next = structuredClone(initial.history);
                next.snapshotId = `reading-snapshot-${++observationRevision}`;
                observation = { ...observation, history: next };
                publishObservation();
              } else if (input.operation === "delta") {
                observation.thread.turns.at(-1).items.at(-1).text += " More live output.";
                publishObservation();
              } else if (input.operation === "hold") hold = true;
              else if (input.operation === "release") {
                hold = false;
                for (const entry of held.splice(0)) entry.resolve();
              } else if (input.operation === "failNext") failNext = true;
              else throw Error("Unknown fixture operation");
              response.end(JSON.stringify(snapshot()));
            } catch (error) {
              response.statusCode = 400;
              response.end(JSON.stringify({ error: error.message }));
            }
          });
        },
      },
    ],
  });
  await vite.listen();
  return {
    url: `http://127.0.0.1:${vite.httpServer.address().port}/__reading.html`,
    close: async () => {
      for (const entry of held.splice(0)) entry.resolve();
      for (const { response } of clients.values()) response.end();
      await vite.close();
    },
    snapshot,
    replaceObservation(next, { concise = false } = {}) {
      concisePages = concise;
      observation = structuredClone(next);
      publishObservation();
    },
    defer,
  };
}
if (process.argv.includes("--serve")) {
  const fixture = await createReadingFixture();
  console.log(
    JSON.stringify({ url: fixture.url, revision, scope: "isolated conversation reading fixture" }),
  );
  const close = () => void fixture.close().then(() => process.exit(0));
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}
