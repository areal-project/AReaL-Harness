import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir, platform, arch } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { connect } from "./client.mjs";
import { fixture, png } from "./fixture.mjs";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const available = [
  "desktop-minimal",
  "game-lite-profile",
  "native-tool-host",
  "mcp-management",
  "adaptive-agents",
  "browser-vision",
  "ask-user",
  "desktop-launcher",
  "model-switch",
  "queue-and-reconnect",
  "approval-gate",
  "shared-terminal",
  "agent-inspector",
  "pgc-workflow",
  "adaptive-workgroup",
];
const selection = (process.argv[2] ?? "all").replace(/^--all$/, "all");
if (selection === "--list") {
  console.log(available.join("\n"));
  process.exit(0);
}
if (selection !== "all" && !available.includes(selection))
  throw Error("unknown example; use --list");
const directory = await mkdtemp(join(tmpdir(), "areal-desktop-"));
const workspace = join(directory, "workspace"),
  data = join(directory, "data"),
  ready = join(directory, "ready"),
  metadata = join(directory, "ready.json");
const model = await fixture();
let child;
const clients = [];
let log = "";
const results = [];
const exampleIds = {
  "desktop-minimal": "EX-01",
  "game-lite-profile": "EX-02",
  "native-tool-host": "EX-03",
  "mcp-management": "EX-14",
  "adaptive-agents": "EX-12",
  "browser-vision": "EX-04",
  "ask-user": "EX-05",
  "desktop-launcher": "EX-06",
  "model-switch": "EX-07",
  "queue-and-reconnect": "EX-09",
  "approval-gate": "EX-10",
  "shared-terminal": "EX-11",
  "agent-inspector": "EX-15",
  "pgc-workflow": "EX-13",
  "adaptive-workgroup": "EX-13",
};
async function startThread(client, prompt, extra = {}) {
  const created = await client.call("areal/thread/start", {
    requestId: crypto.randomUUID(),
    cwd: workspace,
    ...extra,
  });
  const threadId = created.thread.id;
  if (prompt) {
    const { turn } = await client.call("areal/turn/start", {
      requestId: crypto.randomUUID(),
      threadId,
      input: [{ type: "text", text: prompt }],
    });
    return { threadId, turnId: turn.id };
  }
  return { threadId };
}
async function done(client, target) {
  const event = await client.waitEvent(
    "turn/completed",
    (p) => p.threadId === target.threadId && p.turn.id === target.turnId,
  );
  assert.equal(event.turn.status, "completed", JSON.stringify(event.turn));
  return event.turn;
}
let endpoint, authFile;
async function client(tool) {
  const value = await connect(endpoint, authFile, tool);
  clients.push(value);
  return value;
}
try {
  await mkdir(workspace);
  const principals = [
    {
      id: "desktop",
      token: crypto.randomUUID(),
      permissions: ["observe", "interact", "manage", "tools"],
    },
    { id: "observer", token: crypto.randomUUID(), permissions: ["observe"] },
    {
      id: "scoped",
      token: crypto.randomUUID(),
      permissions: ["observe", "interact", "manage", "tools"],
      threadIds: [],
    },
  ];
  await writeFile(join(directory, "auth.json"), JSON.stringify({ version: 1, principals }), {
    mode: 0o600,
  });
  for (const principal of principals.slice(1))
    await writeFile(
      join(directory, `${principal.id}-auth.json`),
      JSON.stringify({ version: 1, principals: [principal] }),
      { mode: 0o600 },
    );
  await mkdir(join(directory, "skill"));
  await writeFile(
    join(directory, "skill/SKILL.md"),
    "# Game fixture\nCreate a minimal click counter and verify its HTML.\n",
  );
  const profiles = [
    {
      id: "game-lite",
      revision: "v1",
      displayName: "Game Lite fixture",
      instructions: "DESKTOP_PROFILE_FIXTURE",
      skills: [{ id: "game", revision: "v1" }],
    },
    {
      id: "approval",
      revision: "v1",
      displayName: "Approval",
      instructions: "Ask approval for writes",
      approvalTools: ["fs_create"],
    },
    {
      id: "verifier",
      revision: "v1",
      displayName: "Readonly verifier",
      instructions: "Verify without changing files",
      readOnly: true,
    },
    {
      id: "terminal",
      revision: "v1",
      displayName: "Terminal",
      instructions: "Use managed terminal",
      allowThreadProcesses: true,
    },
  ];
  const plan = {
    objective: "Verified minimal click counter",
    tasks: [
      {
        id: "design",
        instruction: "PGC_STAGE:design",
        writes: ["game/PRD.md"],
        configuration: { agentProfile: { id: "game-lite", revision: "v1" } },
      },
      {
        id: "implement",
        instruction: "PGC_STAGE:implement",
        depends: ["design"],
        writes: ["game/index.html"],
        configuration: { agentProfile: { id: "game-lite", revision: "v1" } },
      },
      {
        id: "verify",
        instruction: "PGC_STAGE:verify",
        depends: ["implement"],
        writes: [],
        checks: [["/bin/sh", "-c", "test -s game/index.html && test ! -e game/forbidden.txt"]],
        configuration: { agentProfile: { id: "verifier", revision: "v1" }, readOnly: true },
      },
    ],
  };
  await writeFile(
    join(directory, "policy.json"),
    JSON.stringify({
      allowedDirectories: ["game"],
      checks: [
        [
          "/bin/sh",
          "-c",
          "test -s game/PRD.md && test -s game/index.html && test ! -e game/forbidden.txt",
        ],
      ],
      workers: 2,
      verifiers: 1,
      activeGroups: 2,
      timeoutSeconds: 30,
      commandTimeoutMs: 5000,
      maxModelRequests: 32,
    }),
  );
  await writeFile(
    join(directory, "deployment.json"),
    JSON.stringify({
      profiles,
      workflows: [{ id: "pgc", revision: "v1", displayName: "PGC fixture", plan }],
      skills: [{ id: "game", revision: "v1", root: "skill" }],
    }),
  );
  await writeFile(
    join(directory, "tools.json"),
    JSON.stringify({
      plugins: {
        native: {
          trusted: true,
          allowProcess: true,
          argv: [process.execPath, join(repo, "examples/desktop-api/native-host.mjs")],
          readRoots: ["workspace://repo"],
          writeRoots: ["workspace://repo"],
          timeoutMs: 10000,
        },
      },
    }),
  );
  await writeFile(
    join(directory, "config.toml"),
    'schema_version = 1\n[tools]\nextensions_file = "tools.json"\n',
  );
  child = spawn(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      join(repo, "scripts/launch.py"),
      "--bin-dir",
      join(repo, "target/debug"),
      "--desktop",
      "--auth-file",
      join(directory, "auth.json"),
      "--config",
      join(directory, "config.toml"),
      "--workspace",
      workspace,
      "--data-dir",
      data,
      "--ready-file",
      ready,
      "--ready-metadata-file",
      metadata,
      "--model-endpoint",
      model.endpoint,
      "--model",
      "fixture",
      "--allow-write",
      "--allow-network",
      "--workgroup-policy",
      join(directory, "policy.json"),
      "--allow-concurrent-writes",
      "--desktop-config",
      join(directory, "deployment.json"),
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: join(directory, "user"),
        AREAL_HARNESS_HOME: join(directory, "home"),
        AREAL_API_KEY: "fixture",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        OTEL_SDK_DISABLED: "true",
      },
    },
  );
  child.stderr.on("data", (b) => {
    log = (log + b).slice(-32768);
  });
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const m = JSON.parse(await readFile(metadata, "utf8"));
      endpoint = m.endpoint;
      authFile = m.authFile;
      break;
    } catch {
      if (child.exitCode !== null || Date.now() > deadline) throw Error(`startup failed: ${log}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  for (const name of selection === "all" ? available : [selection]) {
    const c = await client();
    if (name === "desktop-minimal" || name === "desktop-launcher") {
      const cap = await c.call("areal/capabilities", { apiVersion: "areal.core.v1" });
      assert(cap.methods.includes("areal/subscription/remove"));
      await assert.rejects(c.call("areal/capabilities", { apiVersion: "unsupported" }));
      const target = await startThread(c, "hello");
      await done(c, target);
      const resume = await c.call("thread/resume", { threadId: target.threadId });
      assert.equal(resume.thread.turns.length, 1);
      const observer = await connect(endpoint, join(directory, "observer-auth.json"));
      const scoped = await connect(endpoint, join(directory, "scoped-auth.json"));
      clients.push(observer, scoped);
      assert.equal(
        (await observer.call("thread/read", { threadId: target.threadId })).thread.id,
        target.threadId,
      );
      await assert.rejects(
        observer.call("areal/thread/start", { requestId: crypto.randomUUID() }),
        (e) => e.code === -32003,
      );
      await assert.rejects(observer.call("areal/provider/list"), (e) => e.code === -32003);
      await assert.rejects(
        scoped.call("thread/read", { threadId: target.threadId }),
        (e) => e.code === -32003,
      );
      await observer.close();
      await scoped.close();
      await c.call("areal/subscription/remove", { threadIds: [target.threadId] });
      assert.equal(
        (await fetch(new URL("/areal/blobs/" + "0".repeat(64), endpoint.replace("ws:", "http:"))))
          .status,
        401,
      );
    } else if (name === "game-lite-profile") {
      const target = await startThread(c, "profile", {
        agentProfile: { id: "game-lite", revision: "v1" },
      });
      await done(c, target);
      assert.equal(
        (await c.call("areal/plan/read", { threadId: target.threadId })).steps[0].status,
        "completed",
      );
      assert.match(await readFile(join(workspace, "index.html"), "utf8"), /button/);
    } else if (name === "native-tool-host") {
      const target = await startThread(c, "native");
      await done(c, target);
      assert.equal(await readFile(join(workspace, "native.txt"), "utf8"), "native broker\n");
      const { thread } = await c.call("thread/read", {
        threadId: target.threadId,
        includeTurns: true,
      });
      const tool = thread.turns[0].items.find((i) => i.type === "dynamicToolCall");
      assert.equal(tool.success, true);
      assert(
        tool.execution.plugin.operations.some(
          (o) => o.kind === "process.start" && o.outcome === "succeeded",
        ),
      );
    } else if (name === "mcp-management") {
      await c.call("areal/mcp/configure", {
        id: "fixture",
        expectedRevision: 0,
        config: {
          transport: {
            type: "stdio",
            command: "/usr/bin/python3",
            args: [
              join(repo, "tests/fixtures/mcp-server.py"),
              join(directory, "mcp.jsonl"),
              "normal",
            ],
          },
          startupTimeoutMs: 5000,
          callTimeoutMs: 5000,
        },
      });
      const view = await c.call("areal/mcp/connect", { id: "fixture", expectedRevision: 1 });
      assert.equal(view.data[0].state, "connected");
      assert.equal(view.data[0].tools.length, 2);
      const target = await startThread(c, "mcp");
      await done(c, target);
      await c.call("areal/mcp/disconnect", { id: "fixture", expectedRevision: 1 });
      assert.equal((await c.call("areal/mcp/read", { id: "fixture" })).state, "disconnected");
    } else if (name === "adaptive-agents") {
      const target = await startThread(c, "agents");
      await done(c, target);
      const children = await c.call("areal/agent/list", { parentThreadId: target.threadId });
      assert.equal(children.data.length, 2);
      for (const thread of children.data) assert.equal(thread.desktop.configuration.readOnly, true);
    } else if (name === "browser-vision") {
      const host = await client(async (params, context) => {
        const url = new URL("/areal/blobs", context.endpoint.replace("ws:", "http:"));
        url.search = new URLSearchParams({
          threadId: params.threadId,
          callId: params.callId,
          hostGeneration: params.hostGeneration,
        });
        const uploaded = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${context.token}`, "Content-Type": "image/png" },
          body: png,
        });
        assert.equal(uploaded.status, 201, await uploaded.clone().text());
        const media = await uploaded.json();
        return {
          success: true,
          contentItems: [
            { type: "inputText", text: "截图前" },
            { type: "arealMedia", modality: "image", media },
            { type: "inputText", text: "截图后" },
          ],
        };
      });
      const target = await startThread(host, "vision", {
        dynamicTools: [
          {
            name: "screenshot",
            description: "Capture fixture image",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      });
      await done(host, target);
    } else if (name === "ask-user") {
      const target = await startThread(c, "question");
      const event = await c.waitEvent(
        "areal/interaction/requested",
        (p) => p.interaction.threadId === target.threadId,
      );
      const request = event.interaction;
      assert.equal(
        (await c.call("areal/interaction/list", { threadId: target.threadId })).data.length,
        1,
      );
      await c.call("areal/interaction/respond", {
        requestId: request.requestId,
        ...target,
        answers: { platform: "桌面" },
      });
      await done(c, target);
      await assert.rejects(
        c.call("areal/interaction/respond", {
          requestId: request.requestId,
          ...target,
          answers: { platform: "桌面" },
        }),
      );
    } else if (name === "model-switch") {
      await c.call("areal/provider/upsert", {
        expectedRevision: 0,
        provider: {
          id: "second",
          revision: 0,
          endpoint: model.endpoint,
          protocol: "chatCompletions",
          models: ["alternate"],
          parameters: { temperature: 0.25, maxOutputTokens: 321 },
        },
      });
      const target = await startThread(c, "hello", {
        model: { providerId: "second", modelId: "alternate" },
      });
      await done(c, target);
      assert(
        model.requests.some(
          (r) =>
            r.model === "alternate" && r.temperature === 0.25 && r.max_completion_tokens === 321,
        ),
      );
      await assert.rejects(
        c.call("areal/thread/configure", {
          threadId: target.threadId,
          expectedRevision: 0,
          model: { providerId: "second", modelId: "alternate" },
        }),
      );
      const { thread: before } = await c.call("thread/read", {
        threadId: target.threadId,
        includeTurns: true,
      });
      const revision = before.desktop.configuration.revision;
      await assert.rejects(
        c.call("areal/thread/configure", {
          threadId: target.threadId,
          expectedRevision: revision,
          resetModel: true,
          model: { providerId: "second", modelId: "alternate" },
        }),
      );
      const reset = await c.call("areal/thread/configure", {
        threadId: target.threadId,
        expectedRevision: revision,
        resetModel: true,
        parameters: {},
      });
      assert.equal(reset.model, null);
      assert.equal(reset.revision, revision + 1);
      const { turn: defaultTurn } = await c.call("turn/start", {
        threadId: target.threadId,
        input: [{ type: "text", text: "after model reset" }],
      });
      await done(c, { threadId: target.threadId, turnId: defaultTurn.id });
      assert.notEqual(model.requests.at(-1).model, "alternate");
      const switched = await c.call("areal/thread/configure", {
        threadId: target.threadId,
        expectedRevision: reset.revision,
        model: { providerId: "second", modelId: "alternate" },
        parameters: {},
      });
      assert.equal(switched.model.modelId, "alternate");
      const running = await startThread(c, "hang", { model: switched.model });
      await c.waitEvent("item/agentMessage/delta", (p) => p.turnId === running.turnId);
      await assert.rejects(
        c.call("areal/thread/configure", {
          threadId: running.threadId,
          expectedRevision: 1,
          resetModel: true,
        }),
      );
      await c.call("turn/interrupt", running);
      await c.waitEvent("turn/completed", (p) => p.turn.id === running.turnId);
    } else if (name === "queue-and-reconnect") {
      const target = await startThread(c, "hang");
      await c.waitEvent("item/agentMessage/delta", (p) => p.threadId === target.threadId);
      const request = {
        requestId: crypto.randomUUID(),
        threadId: target.threadId,
        input: [{ type: "text", text: "queued" }],
      };
      const accepted = await c.call("areal/turn/enqueue", request);
      assert.deepEqual(await c.call("areal/turn/enqueue", request), accepted);
      await c.call("turn/interrupt", target);
      await c.waitEvent(
        "turn/completed",
        (p) => p.threadId === target.threadId && p.turn.id === target.turnId,
      );
      await c.close();
      const reconnected = await client();
      await reconnected.call("thread/resume", { threadId: target.threadId });
      assert.deepEqual(await reconnected.call("areal/turn/enqueue", request), accepted);
      const queue = await reconnected.call("areal/queue/list", { threadId: target.threadId });
      assert.equal(queue.paused, true);
      assert.equal(queue.items[0].status, "pending");
      await reconnected.call("areal/queue/resume", {
        threadId: target.threadId,
        expectedRevision: queue.revision,
      });
      await reconnected.waitEvent(
        "turn/completed",
        (p) => p.threadId === target.threadId && p.turn.id !== target.turnId,
      );
      assert.equal(
        (await reconnected.call("areal/queue/list", { threadId: target.threadId })).items[0].status,
        "completed",
      );
    } else if (name === "approval-gate") {
      const target = await startThread(c, "approval", {
        agentProfile: { id: "approval", revision: "v1" },
      });
      const event = await c.waitEvent(
        "areal/interaction/requested",
        (p) => p.interaction.threadId === target.threadId,
      );
      const request = event.interaction;
      await assert.rejects(stat(join(workspace, "approved.txt")));
      await c.call("areal/interaction/respond", {
        requestId: request.requestId,
        ...target,
        decision: "allowOnce",
        argumentsDigest: request.argumentsDigest,
      });
      await done(c, target);
      assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "approved once");
    } else if (name === "shared-terminal") {
      const { threadId } = await startThread(c, null, {
        agentProfile: { id: "terminal", revision: "v1" },
      });
      const { id } = await c.call("areal/process/start", {
        requestId: crypto.randomUUID(),
        threadId,
        lifetime: "thread",
        argv: ["/bin/cat"],
        cwd: ".",
        tty: false,
      });
      await c.call("areal/process/write", {
        threadId,
        id,
        requestId: crypto.randomUUID(),
        dataBase64: Buffer.from("terminal中文\n").toString("base64"),
      });
      await c.call("areal/process/closeStdin", { threadId, id, requestId: crypto.randomUUID() });
      const waited = await c.call("areal/process/wait", { threadId, id, timeoutMs: 5000 });
      assert.equal(waited.runtime.exitCode, 0);
      const page = await c.call("areal/process/read", { threadId, id });
      assert.match(
        Buffer.concat(page.chunks.map((c) => Buffer.from(c.dataBase64, "base64"))).toString(),
        /terminal中文/,
      );
      assert.equal(
        (await c.call("areal/thread/closeResources", { threadId })).cleanupConfirmed,
        true,
      );
      const pty = await c.call("areal/process/start", {
        threadId,
        requestId: crypto.randomUUID(),
        lifetime: "thread",
        argv: ["/bin/sh", "-c", "sleep .2; stty size; cat"],
        tty: true,
        cols: 80,
        rows: 24,
      });
      await c.call("areal/process/resize", {
        threadId,
        id: pty.id,
        requestId: crypto.randomUUID(),
        cols: 100,
        rows: 40,
      });
      await c.call("areal/process/write", {
        threadId,
        id: pty.id,
        requestId: crypto.randomUUID(),
        dataBase64: Buffer.from("pty中文\n").toString("base64"),
      });
      await c.call("areal/process/closeStdin", {
        threadId,
        id: pty.id,
        requestId: crypto.randomUUID(),
      });
      assert.equal(
        (await c.call("areal/process/wait", { threadId, id: pty.id, timeoutMs: 5000 })).runtime
          .exitCode,
        0,
      );
      const ptyPage = await c.call("areal/process/read", { threadId, id: pty.id });
      const ptyOutput = Buffer.concat(
        ptyPage.chunks.map((p) => Buffer.from(p.dataBase64, "base64")),
      ).toString();
      assert.match(ptyOutput, /40 100/);
      assert.match(ptyOutput, /pty中文/);
      await c.call("areal/thread/closeResources", { threadId });
      const service = await c.call("areal/process/start", {
        threadId,
        requestId: crypto.randomUUID(),
        lifetime: "thread",
        tty: false,
        argv: [
          "/usr/bin/perl",
          "-MIO::Socket::INET",
          "-e",
          'my $s=IO::Socket::INET->new(LocalAddr=>"127.0.0.1",LocalPort=>0,Listen=>4,ReuseAddr=>1) or die $!; $|=1; print "PORT=".$s->sockport."\\n"; while(my $c=$s->accept){ my $line=<$c>; print $c "HTTP/1.1 200 OK\\r\\nContent-Length: 7\\r\\nConnection: close\\r\\n\\r\\npreview"; close $c; }',
        ],
        timeoutMs: 15000,
      });
      const servicePage = await c.call("areal/process/read", {
        threadId,
        id: service.id,
        waitMs: 1000,
      });
      const port = Buffer.concat(servicePage.chunks.map((p) => Buffer.from(p.dataBase64, "base64")))
        .toString()
        .match(/PORT=(\d+)/)?.[1];
      assert(port, JSON.stringify(servicePage));
      const preview = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(await preview.text(), "preview");
      assert.equal(
        (await c.call("areal/thread/closeResources", { threadId })).cleanupConfirmed,
        true,
      );
      await assert.rejects(
        fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }),
      );
    } else if (name === "pgc-workflow" || name === "adaptive-workgroup") {
      const start = await c.call("areal/workflow/start", {
        workflow: { id: "pgc", revision: "v1" },
        requestId: crypto.randomUUID(),
        admission: name === "adaptive-workgroup" ? "adaptive" : "fixed",
        workers: 2,
      });
      let state = start;
      const timeout = Date.now() + 30000;
      while (state.record.status === "running" && Date.now() < timeout)
        state = await c.call("areal/workgroup/wait", {
          id: start.id,
          afterRevision: state.record.revision,
          timeoutMs: 1000,
        });
      assert.equal(state.record.status, "completed", JSON.stringify(state));
      assert.equal(state.record.tasks.length, 3);
      assert.equal(state.record.cleanupConfirmed, true);
      assert.equal((await c.call("areal/server/status")).restartSafe, true);
      const artifact = await c.call("areal/workgroup/artifact", {
        id: start.id,
        path: "game/index.html",
      });
      assert.match(JSON.stringify(artifact), /content|dataBase64/);
      await assert.rejects(
        c.call("areal/workgroup/start", {
          requestId: crypto.randomUUID(),
          plan: {
            objective: "escape",
            tasks: [{ id: "escape", instruction: "hello", writes: ["outside.txt"] }],
          },
        }),
      );
      if (name === "pgc-workflow") {
        let failure = await c.call("areal/workgroup/start", {
          requestId: crypto.randomUUID(),
          plan: {
            objective: "Stage failure must block dependent acceptance",
            tasks: [
              {
                id: "fail",
                instruction: "PGC_STAGE:fail",
                writes: ["game/failed.txt"],
                checks: [["/bin/sh", "-c", "exit 7"]],
              },
              {
                id: "blocked",
                instruction: "blocked-stage-must-not-run",
                writes: ["game/blocked.txt"],
                depends: ["fail"],
              },
            ],
          },
        });
        const limit = Date.now() + 30000;
        while (failure.record.status === "running" && Date.now() < limit)
          failure = await c.call("areal/workgroup/wait", {
            id: failure.id,
            afterRevision: failure.record.revision,
            timeoutMs: 1000,
          });
        assert.equal(failure.record.status, "failed", JSON.stringify(failure));
        assert.equal(failure.record.cleanupConfirmed, true);
        assert.notEqual(failure.record.tasks[1].status, "completed");
        assert(
          !model.requests.some((r) =>
            r.messages.some(
              (m) =>
                m.role === "user" &&
                typeof m.content === "string" &&
                m.content.startsWith("blocked-stage-must-not-run"),
            ),
          ),
        );
      }
    } else if (name === "agent-inspector") {
      const target = await startThread(c, "hello");
      await done(c, target);
      const inspector = await client();
      const a = await c.call("areal/thread/inspect", { threadId: target.threadId });
      const b = await inspector.call("areal/thread/inspect", { threadId: target.threadId });
      assert.deepEqual(a, b);
      assert.equal(a.usageKnown, true);
    }
    await c.close();
    assert.deepEqual(model.failures, []);
    results.push({ exampleId: exampleIds[name], name, status: "passed" });
    console.log(JSON.stringify(results.at(-1)));
  }
} finally {
  for (const c of clients) await c.close().catch(() => {});
  if (child && child.exitCode === null) {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
    const [code] = await exit;
    clearTimeout(timeout);
    if (code !== 0) {
      console.error(log);
      process.exitCode = 1;
    }
  }
  await model.close();
  await rm(directory, { recursive: true, force: true });
  console.log(
    JSON.stringify({
      sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
      workingTree: true,
      apiVersion: "areal.core.v1",
      platform: `${platform()}/${arch()}`,
      model: "local-fixture",
      results,
      cleanupConfirmed: process.exitCode !== 1,
    }),
  );
}
