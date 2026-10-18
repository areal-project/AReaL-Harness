// 固定协议响应只用于编排验收，不代表真实模型质量。
import assert from "node:assert/strict";
import { createServer } from "node:http";

export async function rsiModel() {
  const groups = new Map();
  const failures = [];
  let calls = 0;
  const send = (response, name, args, text = "artifact delivered") => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = name
      ? {
          tool_calls: [
            {
              index: 0,
              id: `call_${++calls}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        }
      : { content: text };
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } })}\n\ndata: [DONE]\n\n`,
    );
  };
  const server = createServer(async (request, response) => {
    try {
      let bytes = "";
      for await (const chunk of request) bytes += chunk;
      const body = JSON.parse(bytes);
      const text = body.messages
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .join("\n");
      const match = text.match(/rsi-artifacts\/([a-zA-Z0-9-]+)\/(candidate-[0-9]+)\/artifact\.md/);
      if (!match) {
        if (text.includes("Current authoritative goal:")) {
          const current = body.messages
            .map((m) => m.content)
            .filter((m) => typeof m === "string")
            .flatMap((m) => m.split("Current authoritative goal: ").slice(1))
            .map((m) => {
              try {
                return JSON.parse(m);
              } catch {
                return null;
              }
            })
            .find(Boolean);
          const reported = body.messages.some((m) => m.role === "tool");
          if (current && !reported)
            return send(response, "goal_update", {
              expectedRevision: current.revision,
              status: "complete",
              summary: "ordinary goal complete",
              evidence: ["fixture result"],
              remaining: [],
            });
        }
        return send(response, null, null, "ORDINARY_GOAL_OK");
      }
      const [, goal, candidate] = match;
      const results = body.messages.filter((m) => m.role === "tool");
      if (results.length)
        return send(
          response,
          null,
          null,
          candidate === "candidate-2" ? "cannot deliver candidate" : "artifact ready",
        );
      let group = groups.get(goal);
      if (!group) {
        group = { starts: [], released: false };
        groups.set(goal, group);
      }
      assert(!group.starts.some((s) => s.candidate === candidate), "candidate was replayed");
      group.starts.push({
        candidate,
        at: Date.now(),
        send: () => {
          // 故意跨候选写入，必须由真实 Runtime 拒绝；其他候选应独立完成。
          const path = `rsi-artifacts/${goal}/${candidate === "candidate-2" ? "candidate-1/forbidden.md" : `${candidate}/artifact.md`}`;
          send(response, "fs_create", {
            path,
            text: `# ${candidate}\n\nRSI_NATIVE_ARTIFACT_OK\n\n${"中文对比内容。".repeat(800)}\nEND_${candidate}\n`,
          });
        },
      });
      if (group.starts.length > 3) {
        const start = group.starts.at(-1);
        setTimeout(() => start.send(), 600);
      } else if (group.starts.length === 3) {
        group.released = true;
        setTimeout(() => group.starts.forEach((start) => start.send()), 600);
      }
    } catch (error) {
      failures.push(error.stack);
      response.writeHead(500);
      response.end(error.message);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    groups,
    failures,
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
  };
}
