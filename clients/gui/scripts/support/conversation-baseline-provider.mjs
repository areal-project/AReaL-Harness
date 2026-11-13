import { randomUUID } from "node:crypto";
import { appendFile, access } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { baselineContent } from "./conversation-baseline.mjs";

const scenarios = ["short", "stream", "rich"];

export function createBaselineProvider({ logPath, gatePath } = {}) {
  const log = (record) =>
    logPath
      ? appendFile(logPath, JSON.stringify({ at: Date.now(), ...record }) + "\n")
      : Promise.resolve();
  const waitForGate = async (signal) => {
    if (!gatePath) return;
    const deadline = Date.now() + 120_000;
    while (!signal.aborted) {
      if (
        await access(gatePath).then(
          () => true,
          () => false,
        )
      )
        return;
      if (Date.now() >= deadline) throw new Error("Baseline release gate timed out");
      await delay(25, undefined, { signal });
    }
  };
  const play = async ({ id, scenario, signal, emit }) => {
    const chunk = async (text, index) => {
      if (signal.aborted) return;
      await emit(text);
      await log({ kind: "chunk", id, index, text });
    };
    if (scenario === "short") {
      await chunk("BASELINE_SHORT_COMPLETE", 0);
      return;
    }
    await chunk(
      scenario === "rich" ? baselineContent.richResponse : baselineContent.initialResponse,
      0,
    );
    await log({ kind: "gate", id, scenario, gated: Boolean(gatePath) });
    await waitForGate(signal);
    if (scenario === "stream") {
      for (const [index, text] of baselineContent.stream.entries()) {
        await delay(baselineContent.intervalMs, undefined, { signal });
        await chunk(text, index + 1);
      }
    }
    await log({ kind: "complete", id, scenario });
  };
  return { log, play };
}

// 仅用于隔离验收；记录的是合成测试上下文，不用于真实用户会话。
export function createBaselineServer(options = {}) {
  const { log, play } = createBaselineProvider(options);
  return createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: scenarios.map((id) => ({ id, object: "model" })) }));
      return;
    }
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      let raw = "";
      for await (const data of req) raw += data;
      const body = JSON.parse(raw);
      const id = randomUUID();
      const auxiliary =
        /^(Generate a concise semantic session title|Predict the next user prompt)/.test(
          String(body.messages?.[0]?.content),
        );
      const text = auxiliary
        ? ""
        : JSON.stringify(
            body.messages?.findLast(
              (item) =>
                item.role === "user" &&
                !String(item.content).startsWith("AReaL runtime context (not a user request):"),
            )?.content ?? "",
          );
      const scenario = text.includes("BASELINE:RICH")
        ? "rich"
        : text.includes("BASELINE:STREAM")
          ? "stream"
          : "short";
      await log({ kind: "request", protocol: "sse", id, scenario, body });
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      await play({
        id,
        scenario,
        signal: controller.signal,
        emit: (content) =>
          res.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            })}\n\n`,
          ),
      });
      res.end(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      await log({ kind: "error", message: error.message });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

export function runBaselineAcp(options = {}) {
  const { log, play } = createBaselineProvider(options);
  const sessions = new Map();
  const send = (message) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  const handle = async ({ method, params = {} }) => {
    if (method === "initialize")
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, embeddedContext: true },
        },
        authMethods: [],
        agentInfo: { name: "conversation-baseline", version: "1" },
      };
    if (method === "session/new" || method === "session/load") {
      const sessionId = method === "session/load" ? String(params.sessionId) : randomUUID();
      sessions.set(sessionId, { model: "short" });
      return {
        ...(method === "session/new" ? { sessionId } : {}),
        models: {
          currentModelId: "short",
          availableModels: scenarios.map((modelId) => ({ modelId, name: `Baseline ${modelId}` })),
        },
      };
    }
    if (method === "authenticate" || method === "session/set_mode") return {};
    const session = sessions.get(params.sessionId);
    if (!session) throw new Error(`Unknown baseline session: ${params.sessionId}`);
    if (method === "session/set_model") {
      if (!scenarios.includes(params.modelId)) throw new Error("Unknown baseline model");
      session.model = params.modelId;
      return {};
    }
    if (method === "session/close") {
      session.controller?.abort();
      sessions.delete(params.sessionId);
      return {};
    }
    if (method !== "session/prompt") throw new Error(`Unsupported baseline method: ${method}`);
    if (session.controller) throw new Error("Baseline session already running");
    const id = randomUUID();
    const text = JSON.stringify(params.prompt);
    const scenario = text.includes("BASELINE:RICH")
      ? "rich"
      : text.includes("BASELINE:STREAM")
        ? "stream"
        : session.model;
    const controller = new AbortController();
    session.controller = controller;
    await log({ kind: "request", protocol: "acp", id, scenario, body: params });
    try {
      await play({
        id,
        scenario,
        signal: controller.signal,
        emit: (text) =>
          send({
            method: "session/update",
            params: {
              sessionId: params.sessionId,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
            },
          }),
      });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      session.controller = undefined;
    }
    return { stopReason: controller.signal.aborted ? "cancelled" : "end_turn" };
  };
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === "session/cancel") {
      sessions.get(message.params?.sessionId)?.controller?.abort();
      return;
    }
    if (message.id === undefined) return;
    handle(message).then(
      (result) => send({ id: message.id, result }),
      (error) => send({ id: message.id, error: { code: -32603, message: error.message } }),
    );
  });
  input.on("close", () => {
    for (const session of sessions.values()) session.controller?.abort();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {
    logPath: process.env.BASELINE_LOG,
    gatePath: process.env.BASELINE_GATE,
  };
  if (process.argv[2] === "acp") runBaselineAcp(options);
  else if (process.argv[2] === "sse") {
    const server = createBaselineServer(options);
    server.listen(Number(process.env.BASELINE_PORT ?? 0), "127.0.0.1", () =>
      console.log(JSON.stringify({ port: server.address().port })),
    );
  } else throw new Error("Usage: conversation-baseline-provider.mjs acp|sse");
}
