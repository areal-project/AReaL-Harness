import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import { CoreTaskModel } from "../packages/workbench/client/core-model.js";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { DesktopService } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const {
  validateCommand,
  validateCommandResponse,
} = require("../packages/workbench/client/desktop-contract.cjs");
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

export async function createReadingFixture({ deferredTools = false } = {}) {
  const detailItems = new Map();
  const initial = baseline();
  if (deferredTools) {
    const sourceTurn = initial.thread.turns[0];
    sourceTurn.items = sourceTurn.items.map((item) => {
      if (item.type !== "dynamicToolCall") return item;
      const entry = {
        sourceThreadId: "reading-thread",
        sourceTurnId: sourceTurn.id,
        sourceItemId: item.id,
        sourceTurnStatus: sourceTurn.status,
        turn: { id: sourceTurn.id, status: sourceTurn.status, durationMs: sourceTurn.durationMs },
        item,
      };
      const raw = JSON.stringify(entry);
      detailItems.set(`detail:${item.id}`, { entry, raw });
      return {
        id: item.id,
        type: "historyDeferred",
        originalType: item.type,
        cursor: `detail:${item.id}`,
        version: "fixture-v1",
        totalBytes: Buffer.byteLength(raw),
        preview: { ...item, contentItems: [] },
      };
    });
  }
  const model = new CoreTaskModel();
  const project = { id: "reading-project", model, connectionGeneration: 1 };
  const backend = Object.assign(Object.create(CoreBackend.prototype), {
    projects: new Map([[project.id, project]]),
    providers: { redact: (value) => value },
    library: { recordThreadActivity: async () => {} },
    onChange() {},
  });
  const calls = [];
  const clients = new Map();
  const historyService = {
    backend: { command: (_name, request) => backend.historyCommand(project, request) },
  };
  let failNext = false;
  let pending = 0;
  let hold = false;
  const held = [];
  project.client = {
    ready: true,
    closed: false,
    capabilities: { features: { boundedObservation: true, boundedHistory: true } },
    request: async (method, params) => {
      calls.push({ method, params });
      if (method !== "areal/conversation/history") throw Error(`Unexpected RPC ${method}`);
      if (failNext) {
        failNext = false;
        throw Error("Injected history unavailability");
      }
      if (hold) {
        hold = false;
        pending++;
        await new Promise((resolve) => held.push({ resolve, cursor: params.cursor }));
        pending--;
      }
      const detail = detailItems.get(params.cursor);
      if (detail)
        return {
          snapshotId: "reading-snapshot",
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
      const value = turn(n);
      return {
        snapshotId: "reading-snapshot",
        data: value.items.map((item) => ({
          sourceThreadId: "reading-thread",
          sourceTurnId: value.id,
          sourceItemId: item.id,
          sourceTurnStatus: value.status,
          turn: { id: value.id, status: value.status, durationMs: value.durationMs },
          item,
        })),
        nextCursor: n < 11 ? `page:${n + 1}` : null,
        complete: n === 11,
      };
    },
  };
  backend.installObservation(project, initial);
  model.connection(true);
  const snapshot = () => ({
    thread: model.state.threads["reading-thread"],
    calls: calls.length,
    detailCalls: calls.filter(({ params }) => detailItems.has(params.cursor)),
    pending,
    held: held.map(({ cursor }) => ({ cursor })),
    views: [...(backend.historyWindow(project, "reading-thread")?.views ?? [])],
    revision,
    scope: "production Messages and Desktop history; deterministic Core RPC fixture",
  });
  const unsubscribe = model.subscribe(() => {
    for (const { response } of clients.values())
      response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  });
  const workbench = JSON.parse(
    await readFile(join(gui, "packages/workbench/package.json"), "utf8"),
  );
  const vite = await createServer({
    root: join(gui, "renderer"),
    configFile: join(gui, "renderer/vite.config.ts"),
    mode: "design-system",
    optimizeDeps: {
      include: Object.keys(workbench.exports).map((path) => `@areal/workbench${path.slice(1)}`),
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
              const socket = { readyState: 1, historyViews: new Map() };
              clients.set(clientId, { response, socket });
              response.write(`data: ${JSON.stringify(snapshot())}\n\n`);
              request.on("close", () => {
                socket.readyState = 3;
                clients.delete(clientId);
                DesktopService.prototype.releaseHistoryViews.call(historyService, socket);
              });
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
              if (path === "/__reading/history") {
                validateCommand("history", { ...input, projectId: project.id });
                const client = clients.get(request.headers["x-reading-client"]);
                if (!client) throw Error("Reading client is disconnected");
                const result = await DesktopService.prototype.historyCommand.call(
                  historyService,
                  client.socket,
                  input,
                );
                validateCommandResponse("history", input, result);
                response.end(JSON.stringify(result));
                return;
              }
              if (input.operation === "reobserve") backend.installObservation(project, initial);
              else if (input.operation === "delta")
                model.event("item/agentMessage/delta", {
                  threadId: "reading-thread",
                  turnId: "live",
                  itemId: "live-answer",
                  delta: " More live output.",
                });
              else if (input.operation === "hold") hold = true;
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
      unsubscribe();
      for (const { response } of clients.values()) response.end();
      await vite.close();
    },
    snapshot,
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
