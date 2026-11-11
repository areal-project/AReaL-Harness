// Failure contracts fixed before implementation: existing trust never admits read-only
// hooks; separate consent enables only commands in ordinary children; Runtime must deny
// workspace/host/sibling-data writes and network, exclude secrets, permit private scratch
// and package data, reject stale/revoked trust, and preserve Profile/Side exclusions.
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  access,
  rename,
  symlink,
  unlink,
} from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { CoreClient } from "../clients/gui/packages/runtime-client/core.js";
const require = createRequire(new URL("../clients/gui/app/package.json", import.meta.url)),
  WebSocket = require("ws"),
  exec = promisify(execFile);
const bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal"),
  coreSha256 = createHash("sha256")
    .update(await readFile(bin))
    .digest("hex");
const sourceHead = (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  sourceFiles = {};
for (const path of new Set(
  (await exec("git", ["ls-files", "-m", "-o", "--exclude-standard"])).stdout
    .trim()
    .split("\n")
    .filter(Boolean),
))
  sourceFiles[path] = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const scratch = await realpath(await trackedMkdtemp("/private/tmp/areal-readonly-hooks-")),
  workspace = join(scratch, "workspace"),
  home = join(scratch, "home"),
  privateScratch = join(scratch, "command-scratch"),
  hostFile = join(scratch, "host-marker");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(AREAL_|OPENAI_|ANTHROPIC_|GITHUB_|GH_TOKEN$|OTEL_)/.test(k),
    ),
  ),
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  OPENAI_API_KEY: "owned-readonly-secret-sentinel",
  OTEL_SDK_DISABLED: "true",
};
const checks = [],
  holds = new Map(),
  id = "readonly@local";
let client,
  service,
  failure,
  passed = false;
const pause = () => new Promise((r) => setTimeout(r, 30));
const network = createServer((q, r) => r.end("network probe"));
await new Promise((r) => network.listen(0, "127.0.0.1", r));
const model = createServer(async (req, res) => {
  let body = "";
  for await (const part of req) body += part;
  const q = JSON.parse(body);
  const text =
    q.messages
      .filter((m) => m.role === "user")
      .map((m) => String(m.content))
      .at(-1) ?? "";
  if (text.includes("ROOT_WAIT")) await new Promise((r) => holds.set(text, r));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        choices: [{ index: 0, delta: { content: "READONLY_FIXTURE_OK" }, finish_reason: null }],
      }) +
      "\n\ndata: " +
      JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
async function cli(args) {
  return JSON.parse(
    (await exec(bin, args, { env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  );
}
async function mutate(method, params) {
  try {
    return await client.request(method, { requestId: randomUUID(), ...params });
  } catch (e) {
    e.message = method + ": " + e.message;
    throw e;
  }
}
async function connect() {
  service = await cli([
    "service",
    "ensure",
    "--json",
    "--workspace",
    workspace,
    "--config",
    join(home, "config.toml"),
    "--desktop-config",
    join(home, "desktop.json"),
    "--scratch",
    privateScratch,
    "--allow-write",
    "--allow-network",
  ]);
  const auth = JSON.parse(await readFile(service.authFile, "utf8"));
  client = new CoreClient({
    createSocket: () =>
      new WebSocket(service.endpoint, {
        headers: { Authorization: "Bearer " + auth.principals[0].token },
      }),
    timeoutMs: 30000,
  });
  await client.connect();
}
async function settle(threadId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const { thread } = await client.request("thread/read", { threadId, includeTurns: true });
    if (thread.turns.at(-1)?.status !== "inProgress") return thread;
    await pause();
  }
  throw Error("fixture Turn did not settle");
}
async function parent(profile) {
  const { thread } = await client.request("thread/start", { cwd: workspace });
  if (profile)
    await mutate("areal/thread/configure", {
      threadId: thread.id,
      expectedRevision: 1,
      agentProfile: { id: "excluded", revision: "v1" },
    });
  const text = "ROOT_WAIT " + randomUUID();
  await mutate("areal/turn/start", { threadId: thread.id, input: [{ type: "text", text }] });
  const deadline = Date.now() + 10000;
  while (!holds.has(text) && Date.now() < deadline) await pause();
  assert(holds.has(text));
  return { thread, text };
}
async function child(p) {
  const { thread } = await client.request("areal/agent/spawn", {
    parentThreadId: p.thread.id,
    input: [{ type: "text", text: "child probe" }],
  });
  const state = await settle(thread.id);
  assert.equal(state.turns.at(-1).status, "completed", JSON.stringify(state.turns.at(-1).error));
  assert.equal(state.turns.at(-1).configuration.readOnly, true);
  return state;
}
async function release(p) {
  holds.get(p.text)?.();
  holds.delete(p.text);
  await settle(p.thread.id);
}
async function log() {
  try {
    return (await readFile(join(home, "plugins/data/readonly@local/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
try {
  await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
  await mkdir(join(workspace, "pkg/.codex-plugin"), { recursive: true });
  await mkdir(join(workspace, "pkg/hooks"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(privateScratch, { recursive: true });
  await mkdir(join(workspace, "redirected-data"), { recursive: true });
  await mkdir(join(home, "plugins/data/sibling"), { recursive: true });
  await writeFile(join(home, "plugins/data/sibling/marker"), "SIBLING_UNCHANGED");
  await writeFile(hostFile, "HOST_UNCHANGED");
  await writeFile(join(workspace, "protected.txt"), "WORKSPACE_UNCHANGED");
  await writeFile(
    join(home, "config.toml"),
    `schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}"\n`,
  );
  await writeFile(
    join(home, "desktop.json"),
    JSON.stringify({
      profiles: [
        { id: "excluded", revision: "v1", displayName: "Excluded profile", instructions: "" },
      ],
    }),
  );
  await writeFile(
    join(workspace, ".agents/plugins/marketplace.json"),
    JSON.stringify({ name: "local", plugins: [{ name: "readonly", source: "./pkg" }] }),
  );
  await writeFile(
    join(workspace, "pkg/.codex-plugin/plugin.json"),
    JSON.stringify({ name: "readonly" }),
  );
  const python = `import json,os,sys,socket\nv=json.load(sys.stdin)\np=os.environ['PLUGIN_DATA']\nif v['hook_event_name']=='SubagentStart':\n for target in [v['cwd']+'/redirected-data/unauthorized',${JSON.stringify(join(home, "plugins/data/sibling/unauthorized"))}]:\n  try:\n   with open(target,'w') as f:f.write('UNAUTHORIZED_WRITE')\n  except OSError:pass\nos.makedirs(p,exist_ok=True)\nchecks={}\nif v['hook_event_name']=='SubagentStart':\n checks['workspaceRead']=open(v['cwd']+'/protected.txt').read()=='WORKSPACE_UNCHANGED'\n checks['packageRead']=os.path.isfile(os.environ['PLUGIN_ROOT']+'/hooks/hook.py')\n for name,path in [('workspace',v['cwd']+'/protected.txt'),('host',${JSON.stringify(hostFile)}),('sibling',${JSON.stringify(join(home, "plugins/data/sibling/marker"))})]:\n  try:\n   with open(path,'w') as f:f.write('UNAUTHORIZED_WRITE')\n   checks[name]=False\n  except OSError:checks[name]=True\n try:\n  open(${JSON.stringify(hostFile)}).read();checks['hostRead']=False\n except OSError:checks['hostRead']=True\n try:\n  s=socket.create_connection(('127.0.0.1',${network.address().port}),.3);s.close();checks['network']=False\n except OSError:checks['network']=True\n checks['secretAbsent']='OPENAI_API_KEY' not in os.environ\n with open(${JSON.stringify(privateScratch)}+'/agent-'+v['agent_id']+'/private-marker','w') as f:f.write('PRIVATE_ALLOWED')\n checks['scratchWrite']=True\nwith open(p+'/events.jsonl','a') as f:f.write(json.dumps({'input':v,'checks':checks})+'\\n')\nprint('{}')\n`;
  await writeFile(join(workspace, "pkg/hooks/hook.py"), python);
  const command = 'python3 "${PLUGIN_ROOT}/hooks/hook.py"';
  await writeFile(
    join(workspace, "pkg/hooks/hooks.json"),
    JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
        SessionStart: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
        UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
        SubagentStart: [
          {
            hooks: [
              { type: "command", command, timeout: 5 },
              {
                type: "mcp_tool",
                server: "fixture",
                tool: "hook",
                input: { event: "SubagentStart" },
                timeout: 2,
              },
            ],
          },
        ],
        SubagentStop: [{ hooks: [{ type: "command", command, timeout: 5 }] }],
      },
    }),
  );
  await writeFile(
    join(workspace, "pkg/server.py"),
    `import json,sys,os\nfor line in sys.stdin:\n v=json.loads(line);m=v.get('method');r={}\n if m=='initialize':r={'protocolVersion':v['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'readonly-fixture','version':'1'}}\n elif m=='tools/list':r={'tools':[{'name':'hook','description':'Readonly MCP exclusion probe','inputSchema':{'type':'object'}}]}\n elif m=='tools/call':\n  with open(${JSON.stringify(join(scratch, "mcp-called"))},'w') as f:f.write('MCP_EXECUTED')\n  r={'content':[{'type':'text','text':'{}'}]}\n if m=='server/discover':\n  print(json.dumps({'jsonrpc':'2.0','id':v['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True);continue\n if 'id' in v:print(json.dumps({'jsonrpc':'2.0','id':v['id'],'result':r}),flush=True)\n`,
  );
  await writeFile(
    join(workspace, "pkg/.mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: "python3", args: ["server.py"] } } }),
  );
  await connect();
  const catalog = await client.request("areal/plugin/list", {});
  const selected = catalog.data.find((p) => p.id === id);
  assert(selected);
  await mutate("areal/plugin/install", {
    id,
    scope: "user",
    expectedRevision: catalog.revision,
    source: selected.source,
    expectedDigest: selected.sourceDigest,
  });
  let row = (await client.request("areal/plugin/hooks/list", {})).data.find(
    (r) => r.pluginId === id,
  );
  const params = {
    id,
    expectedDigest: row.installedDigest,
    definitionDigest: row.definitionDigest,
    enabled: true,
    trusted: true,
  };
  await mutate("areal/plugin/hooks/configure", params);
  await mutate("areal/plugin/connection", {
    id,
    expectedDigest: row.installedDigest,
    connect: true,
  });
  let p = await parent(),
    c = await child(p);
  assert(!(await log()).some((r) => r.input.agent_id === c.id));
  await release(p);
  checks.push("existing writable trust does not authorize ordinary read-only child hooks");
  await assert.rejects(
    mutate("areal/plugin/hooks/configure", {
      ...params,
      definitionDigest: "0".repeat(64),
      allowReadOnlyCommands: true,
    }),
  );
  await mutate("areal/plugin/hooks/configure", { ...params, allowReadOnlyCommands: true });
  row = (await client.request("areal/plugin/hooks/list", {})).data.find((r) => r.pluginId === id);
  assert(
    row.definitions
      .filter((r) => r.definition.handler.type === "command")
      .every((r) => r.readOnlyCommandTrusted),
  );
  assert(
    row.definitions
      .filter((r) => r.definition.handler.type === "mcp_tool")
      .every((r) => !r.readOnlyCommandTrusted),
  );
  checks.push("separate current-digest consent admits only command handlers, never MCP");
  p = await parent();
  c = await child(p);
  const entries = (await log()).filter((r) => r.input.agent_id === c.id);
  assert.equal(entries.filter((r) => r.input.hook_event_name === "SubagentStart").length, 1);
  assert.equal(entries.filter((r) => r.input.hook_event_name === "SubagentStop").length, 1);
  assert(entries.every((r) => r.input.session_id === p.thread.sessionId));
  const probes = entries.find((r) => r.input.hook_event_name === "SubagentStart").checks;
  assert(
    Object.values(probes).every((v) => v === true),
    JSON.stringify(probes),
  );
  assert.equal(Object.keys(probes).length, 9);
  assert.equal(await readFile(join(workspace, "protected.txt"), "utf8"), "WORKSPACE_UNCHANGED");
  assert.equal(await readFile(hostFile, "utf8"), "HOST_UNCHANGED");
  assert.equal(
    await readFile(join(home, "plugins/data/sibling/marker"), "utf8"),
    "SIBLING_UNCHANGED",
  );
  await assert.rejects(access(join(scratch, "mcp-called")));
  await release(p);
  checks.push(
    "actual read-only child Start/Stop identities and native filesystem/network/secret/private-write boundaries pass",
  );
  await mutate("areal/thread/configure", {
    threadId: p.thread.id,
    expectedRevision: 1,
    selectedSkills: [],
    agentProfile: { id: "excluded", revision: "v1" },
  });
  const beforeIdleArchive = (await log()).length;
  await mutate("areal/thread/archive", { threadId: p.thread.id });
  const archivedParent = (
    await client.request("thread/read", { threadId: p.thread.id, includeTurns: true })
  ).thread;
  assert(!archivedParent.desktop.hookRuns.some((r) => r.event === "SessionEnd"));
  assert.equal((await log()).length, beforeIdleArchive);
  checks.push(
    "idle root Profile restriction suppresses SessionEnd using current configuration rather than the completed Turn",
  );
  p = await parent(true);
  c = await child(p);
  assert.equal(c.turns.at(-1).configuration.allowPluginSkills, false);
  assert(!(await log()).some((r) => r.input.agent_id === c.id));
  await release(p);
  checks.push("explicit Profile disabling plugin Skills remains excluded despite consent");
  p = await parent();
  await release(p);
  const beforeSide = (await log()).length;
  const side = await mutate("areal/side/start", {
    sourceThreadId: p.thread.id,
    workspaceAccess: "none",
    input: [{ type: "text", text: "side probe" }],
  });
  const sideId = side.thread?.id ?? side.threadId;
  assert(sideId);
  const sideState = await settle(sideId);
  assert.equal(sideState.desktop.hookRuns.length, 0);
  assert.equal((await log()).length, beforeSide);
  checks.push(
    "Side conversation with otherwise eligible source has no hook receipts or executions despite consent",
  );
  const dataDir = join(home, "plugins/data/readonly@local");
  for (const target of [join(workspace, "redirected-data"), join(home, "plugins/data/sibling")]) {
    await mkdir(target, { recursive: true });
    p = await parent();
    await rename(dataDir, dataDir + ".retained");
    await symlink(target, dataDir);
    try {
      c = await child(p);
      await assert.rejects(access(join(target, "unauthorized")));
      await assert.rejects(access(join(target, "events.jsonl")));
      assert(
        c.desktop.hookRuns
          .filter((r) => r.event === "SubagentStart" || r.event === "SubagentStop")
          .every((r) => r.outcome === "failed"),
      );
    } finally {
      await unlink(dataDir);
      await rename(dataDir + ".retained", dataDir);
      await release(p);
    }
  }
  const dataParent = join(home, "plugins/data"),
    redirectedLeaf = join(workspace, "readonly@local");
  p = await parent();
  await rename(dataParent, dataParent + ".retained");
  await symlink(workspace, dataParent);
  try {
    c = await child(p);
    await assert.rejects(access(redirectedLeaf));
    assert(
      c.desktop.hookRuns
        .filter((r) => r.event === "SubagentStart" || r.event === "SubagentStop")
        .every((r) => r.outcome === "failed"),
    );
  } finally {
    await unlink(dataParent);
    await rename(dataParent + ".retained", dataParent);
    await release(p);
  }
  checks.push(
    "redirected package data cannot grant writes or pre-create directories in workspace or sibling data",
  );
  await mutate("areal/plugin/hooks/configure", params);
  p = await parent();
  c = await child(p);
  assert(!(await log()).some((r) => r.input.agent_id === c.id));
  await release(p);
  checks.push(
    "omitted read-only consent removes capability without granting it through existing writable trust",
  );
  await mutate("areal/plugin/hooks/configure", { ...params, allowReadOnlyCommands: true });
  client.close();
  const stopped = await cli(["service", "stop", "--json", "--workspace", workspace, "--cancel"]);
  assert.equal(stopped.state, "stopped");
  service = null;
  await connect();
  p = await parent();
  c = await child(p);
  assert((await log()).some((r) => r.input.agent_id === c.id));
  await release(p);
  checks.push("independent consent survives confirmed service restart without hook replay");
  await mutate("areal/plugin/hooks/configure", {
    ...params,
    enabled: false,
    trusted: false,
    allowReadOnlyCommands: true,
  });
  p = await parent();
  c = await child(p);
  assert(!(await log()).some((r) => r.input.agent_id === c.id));
  await release(p);
  checks.push("revoked definitions cannot execute in read-only children");
  passed = true;
} catch (error) {
  failure = error.stack;
} finally {
  for (const r of holds.values()) r();
  holds.clear();
  client?.close();
  if (service)
    try {
      const s = await cli(["service", "stop", "--json", "--workspace", workspace, "--cancel"]);
      assert.equal(s.state, "stopped");
    } catch (error) {
      passed = false;
      failure ??= error.stack;
    }
  model.closeAllConnections();
  network.closeAllConnections();
  await Promise.all([new Promise((r) => model.close(r)), new Promise((r) => network.close(r))]);
}
const manifest = {
  passed,
  checks,
  failure,
  scratch,
  core: bin,
  coreSha256,
  coreUnchanged:
    createHash("sha256")
      .update(await readFile(bin))
      .digest("hex") === coreSha256,
  sourceHead,
  sourceFiles,
  scope:
    "actual Core/Runtime ordinary read-only child command-hook policy; loopback model; no platform/package/provider compatibility claim",
};
await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
if (!passed) process.exitCode = 1;
