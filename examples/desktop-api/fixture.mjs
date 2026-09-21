import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
export async function fixture() {
  const requests = [];
  const failures = [];
  const server = createServer(async (req, res) => {
    try {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > 24 * 1024 * 1024) throw Error("fixture request too large");
      }
      const request = JSON.parse(text);
      requests.push(request);
      const lastUser = request.messages.findLastIndex((m) => m.role === "user");
      const first = request.messages[lastUser]?.content ?? "";
      const result = request.messages.slice(lastUser + 1).filter((m) => m.role === "tool");
      let tool;
      let reply = "完成：" + request.model;
      if (first === "skill-discovery") {
        if (result.length === 0) {
          assert(
            JSON.stringify(request.messages.filter((m) => m.role === "system")).includes(
              "Use review for skill discovery validation.",
            ),
          );
          assert(
            !JSON.stringify(request.messages.filter((m) => m.role === "system")).includes(
              "PROJECT_SKILL_BODY",
            ),
          );
          tool = ["skill_list", {}];
        } else {
          const skills = JSON.parse(result[0].content).data;
          assert.deepEqual(
            skills.map((s) => s.id),
            ["global-only", "linked", "review"],
          );
          if (result.length <= skills.length) {
            const { id, revision } = skills[result.length - 1];
            tool = ["skill_read", { skill: { id, revision } }];
          } else {
            const bodies = result
              .slice(1, 4)
              .map((r) => JSON.parse(r.content).text.split("\n---\n\n")[1]);
            assert.deepEqual(bodies, [
              "GLOBAL_SKILL_BODY",
              "LINKED_SKILL_BODY",
              "PROJECT_SKILL_BODY",
            ]);
            if (result.length === 4) {
              const { id, revision } = skills[0];
              tool = ["skill_read", { skill: { id, revision }, resource: "references/check.md" }];
            } else {
              assert.equal(JSON.parse(result[4].content).text, "GLOBAL_REFERENCE");
              reply = "SKILL_DISCOVERY_PASSED";
            }
          }
        }
      }
      if (typeof first === "string" && first.startsWith("credentials ")) {
        const { program, digest } = JSON.parse(first.slice(12));
        if (result.length === 0)
          tool = [
            "run_command",
            {
              argv: ["/bin/sh", "-c", 'test -z "$MULTICA_TOKEN" && printf absent'],
              cwd: ".",
              timeoutMs: 3000,
            },
          ];
        else if (result.length === 1) {
          assert.match(result[0].content, /absent/);
          tool = ["run_command", { argv: [program, digest], cwd: ".", timeoutMs: 3000 }];
        } else assert.match(result[1].content, /credential matched/);
      }
      if (first === "question" && result.length === 0)
        tool = [
          "ask_user_question",
          {
            questions: [
              {
                id: "platform",
                title: "选择平台",
                options: ["桌面", "手机"],
                allowFreeText: false,
              },
            ],
            timeoutSeconds: 5,
          },
        ];
      if (first === "question" && result.length) {
        assert.match(JSON.stringify(result), /桌面/);
      }
      if (first === "native" && result.length === 0) tool = ["native_write", {}];
      if (first === "native" && result.length)
        assert.match(JSON.stringify(result), /native broker/);
      if (first === "mcp" && result.length === 0)
        tool = ["mcp__fixture__echo", { value: "managed" }];
      if (first === "mcp" && result.length) assert.match(JSON.stringify(result), /managed/);
      if (first === "agents") {
        if (result.length < 2)
          tool = [
            "agent_spawn_configured",
            {
              input: [{ type: "text", text: "child-" + result.length }],
              workspaceMode: "sharedReadOnly",
              instructions: "Inspect read-only.",
            },
          ];
        else if (result.length === 2) {
          const ids = result.map((r) => JSON.parse(r.content).threadId);
          tool = ["agent_wait_all", { threadIds: ids, timeoutMs: 5000 }];
        } else assert.match(JSON.stringify(result.at(-1)), /completed/);
      }
      if (first === "vision" && result.length === 0) tool = ["screenshot", {}];
      if (first === "vision" && result.length) {
        const content = result.at(-1).content;
        assert.equal(content[0].text, "截图前");
        assert.equal(content[1].image_url.url, `data:image/png;base64,${png.toString("base64")}`);
        assert.equal(content[2].text, "截图后");
      }
      if (first === "readonly" && result.length === 0)
        tool = [
          "run_command",
          {
            argv: ["/bin/sh", "-c", "printf bad > readonly-denied.txt"],
            cwd: ".",
            timeoutMs: 3000,
          },
        ];
      if (first === "readonly" && result.length)
        assert.match(
          JSON.stringify(result),
          /Operation not permitted|Permission denied|permission denied/,
        );
      if (first === "approval" && result.length === 0)
        tool = ["fs_create", { path: "approved.txt", text: "approved once" }];
      if (first === "profile") {
        assert.match(
          request.messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n"),
          /DESKTOP_PROFILE_FIXTURE/,
        );
        if (result.length === 0) tool = ["skill_read", { skill: { id: "game", revision: "v1" } }];
        else if (result.length === 1)
          tool = [
            "plan_update",
            {
              expectedRevision: 0,
              steps: [{ id: "game", text: "制作并验证小游戏", status: "inProgress" }],
            },
          ];
        else if (result.length === 2)
          tool = [
            "run_command",
            {
              argv: [
                "/bin/sh",
                "-c",
                "printf '<!doctype html><button onclick=\"this.textContent=Number(this.textContent)+1\">0</button>' > index.html; test -s index.html",
              ],
              cwd: ".",
              timeoutMs: 3000,
            },
          ];
        else if (result.length === 3)
          tool = [
            "plan_update",
            {
              expectedRevision: 1,
              steps: [{ id: "game", text: "制作并验证小游戏", status: "completed" }],
            },
          ];
      }
      const stage =
        typeof first === "string"
          ? first.match(/PGC_STAGE:(design|implement|verify|fail)/)?.[1]
          : null;
      if (stage && result.length === 0) {
        const command = {
          design: "mkdir -p game; printf 'Click counter specification' > game/PRD.md",
          implement:
            "test -s game/PRD.md && printf '<!doctype html><button onclick=\"this.textContent=Number(this.textContent)+1\">0</button>' > game/index.html",
          verify: "printf forbidden > game/forbidden.txt",
          fail: "exit 7",
        }[stage];
        tool = ["run_command", { argv: ["/bin/sh", "-c", command], cwd: ".", timeoutMs: 3000 }];
      }
      if (stage === "verify" && result.length) {
        assert.match(
          JSON.stringify(result),
          /Operation not permitted|Permission denied|permission denied/,
        );
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (first === "hang") {
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "waiting" }, finish_reason: null }] })}\n\n`,
        );
        return;
      }
      if (tool) {
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${result.length}`, type: "function", function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        const bytes = Buffer.from(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`,
        );
        for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
        res.end(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 4 } })}\n\ndata: [DONE]\n\n`,
        );
      }
    } catch (error) {
      failures.push(error.message);
      res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    requests,
    failures,
    endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
