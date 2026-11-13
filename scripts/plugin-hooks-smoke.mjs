// Actual Core/Runtime and original Codex-format package acceptance.
// Failure contract defined before runner integration: installation is inert, stale trust
// cannot execute; deny/exit2 prevents effects; validated rewrites execute; Post feedback
// retains writes; repeated Stop stays in one Turn without prompt recursion; async output
// reaches only safe points/next user Turn. Local model is the only simulated boundary.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, access, realpath } from "node:fs/promises";
import { trackedMkdtemp } from "../clients/gui/scripts/support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { CoreClient } from "../clients/gui/packages/runtime-client/core.js";
const require = createRequire(new URL("../clients/gui/app/package.json", import.meta.url)),
  WebSocket = require("ws"),
  exec = promisify(execFile);
const acceptedFlags = new Set([
  "--defer-concurrency",
  "--defer-readonly-child",
  "--writable-child",
]);
assert(
  process.argv.slice(2).every((flag) => acceptedFlags.has(flag)),
  "unsupported acceptance selector",
);
const deferred = process.argv.slice(2);
const sourceRoot = process.cwd();
const sourceHead = (await exec("git", ["rev-parse", "HEAD"], { cwd: sourceRoot })).stdout.trim();
const sourceDiffSha256 = createHash("sha256")
  .update(
    (
      await exec("git", ["diff", "--binary", "HEAD"], {
        cwd: sourceRoot,
        maxBuffer: 32 * 1024 * 1024,
      })
    ).stdout,
  )
  .digest("hex");
const sourceFiles = {};
for (const path of (
  await exec("git", ["ls-files", "-m", "-o", "--exclude-standard"], { cwd: sourceRoot })
).stdout
  .trim()
  .split("\n")
  .filter(Boolean)) {
  if (/^(core\/|runtime\/|clients\/|scripts\/|schemas\/|Cargo\.|Makefile)/.test(path))
    sourceFiles[path] = createHash("sha256")
      .update(await readFile(join(sourceRoot, path)))
      .digest("hex");
}
const scratch = await realpath(await trackedMkdtemp("/private/tmp/areal-plugin-hooks-"));
const workspace = join(scratch, "workspace"),
  home = join(scratch, "home"),
  config = join(home, "config.toml");
const bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal"),
  id = "hooks@local";
const coreSha256 = createHash("sha256")
  .update(await readFile(bin))
  .digest("hex");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/^(AREAL_|OPENAI_|ANTHROPIC_|GITHUB_|GH_TOKEN$|OTEL_)/.test(k),
    ),
  ),
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
};
const requests = [],
  checks = [],
  counts = new Map(),
  holds = new Map();
let service,
  peerService,
  client,
  failure,
  passed = false;
const pause = () => new Promise((r) => setTimeout(r, 30));
const model = createServer(async (req, res) => {
  try {
    let body = "";
    for await (const part of req) body += part;
    const q = JSON.parse(body);
    requests.push(q);
    const text =
      q.messages
        .filter((m) => m.role === "user")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
        .reverse()
        .find((x) => x.includes("HOOK_CASE=")) ?? "";
    const name = /HOOK_CASE=([a-z]+)/.exec(text)?.[1] ?? "none",
      key = /RUN=([a-f0-9-]+)/.exec(text)?.[1] ?? name;
    const count = counts.get(key) ?? 0;
    counts.set(key, count + 1);
    if (name === "hold" && count === 0) await new Promise((r) => holds.set(key, r));
    let delta = { content: name === "stop" ? "STOP_CASE answer" : "fixture complete" };
    if (
      ![
        "none",
        "stop",
        "blocked",
        "async",
        "cancel",
        "archive",
        "mcp",
        "spill",
        "form",
        "hold",
        "steerdeny",
        "steerok",
      ].includes(name) &&
      count === 0
    )
      delta = {
        tool_calls: [
          {
            index: 0,
            id: "fixture-" + key,
            type: "function",
            function: {
              name: "run_command",
              arguments: JSON.stringify({
                command:
                  name === "release"
                    ? "printf release > release-async"
                    : `printf ${name} > sentinel-${name}`,
                yieldMs: 1000,
              }),
            },
          },
        ],
      };
    if (
      q.messages.some(
        (m) => m.role === "system" && String(m.content).startsWith("Summarize this session prefix"),
      )
    )
      delta = {
        content:
          "Checkpoint: hooks fixture retains completed writes, blocked operations and current reviewed definitions. Next action: continue acceptance.",
      };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      "data: " +
        JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) +
        "\n\ndata: " +
        JSON.stringify({
          choices: [
            { index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  } catch (error) {
    res.writeHead(500);
    res.end(error.message);
  }
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
async function cli(args) {
  return JSON.parse(
    (await exec(bin, args, { env, timeout: 90000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  );
}
async function mutate(method, params) {
  return client.request(method, { requestId: randomUUID(), ...params });
}
async function descendant(turnId) {
  const path = join(home, "plugins/data/hooks@local/descendant-" + turnId + ".pid");
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      return Number(await readFile(path, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await pause();
  }
  throw Error("async descendant was not admitted");
}
async function assertExited(pid) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await pause();
  }
  throw Error("descendant still alive after confirmed owner cleanup: " + pid);
}
async function events() {
  try {
    return (await readFile(join(home, "plugins/data/hooks@local/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function turn(name, thread) {
  const key = randomUUID();
  const before = requests.length;
  const started = await client.request("areal/turn/start", {
    requestId: randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: `HOOK_CASE=${name} RUN=${key}` }],
  });
  const tid = started.turn.id;
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    const { thread: state } = await client.request("thread/read", {
      threadId: thread.id,
      includeTurns: true,
    });
    const t = state.turns.find((t) => t.id === tid);
    if (t && t.status !== "inProgress")
      return { thread: state, turn: t, requests: requests.slice(before), key };
    await pause();
  }
  throw Error("Turn did not settle");
}
const hookScript = `import json,os,sys,time,subprocess
v=json.load(sys.stdin)
p=os.environ['PLUGIN_DATA']
os.makedirs(p,exist_ok=True)
if len(sys.argv)>1 and sys.argv[1]=='async':
 prompt=v.get('prompt','')
 if any('HOOK_CASE='+case in prompt for case in ['async','cancel','archive']):
  with open(p+'/async-start.jsonl','a') as f:f.write(json.dumps(v)+'\\n')
  if 'HOOK_CASE=async' in prompt:
   while not os.path.exists(v['cwd']+'/release-async'):time.sleep(.03)
   print(json.dumps({'continue':False,'hookSpecificOutput':{'hookEventName':'UserPromptSubmit','additionalContext':'ASYNC_CONTEXT'}}));sys.exit(0)
  child=subprocess.Popen(['python3','-c','import time;time.sleep(30)'])
  with open(p+'/descendant-'+v['turn_id']+'.pid','w') as f:f.write(str(child.pid))
  time.sleep(30)
 print('{}');sys.exit(0)
with open(p+'/events.jsonl','a') as f:f.write(json.dumps(v)+'\\n')
e=v['hook_event_name']
out={}
if e=='SessionStart':out={'hookSpecificOutput':{'hookEventName':e,'additionalContext':'STARTUP_CONTEXT'}}
if e=='UserPromptSubmit':
 if 'HOOK_CASE=steerdeny' in v['prompt']:
  while not os.path.exists(v['cwd']+'/release-steer'):time.sleep(.03)
  out={'decision':'block','reason':'STEER_DENIED'}
 if 'HOOK_CASE=blocked' in v['prompt']:out={'decision':'block','reason':'PROMPT_BLOCKED'}
 if 'HOOK_CASE=spill' in v['prompt']:out={'hookSpecificOutput':{'hookEventName':e,'additionalContext':'HEAD_'+('中a'*300)+'_TAIL'}}
if e=='PermissionRequest':
 out={'hookSpecificOutput':{'hookEventName':e,'decision':{'behavior':'deny','message':'PERMISSION_DENIED'} if 'sentinel-permission' in v['tool_input'].get('command','') else {'behavior':'allow'}}}
if e=='PreToolUse':
 c=v['tool_input'].get('command','')
 if 'sentinel-deny' in c:out={'hookSpecificOutput':{'hookEventName':e,'permissionDecision':'deny','permissionDecisionReason':'PRE_DENIED'}}
 if 'sentinel-exit' in c:sys.stderr.write('EXIT_TWO_DENIED');sys.exit(2)
 if 'sentinel-rewrite' in c:out={'hookSpecificOutput':{'hookEventName':e,'permissionDecision':'allow','updatedInput':{'command':'printf rewritten > sentinel-updated'}}}
if e=='PostToolUse' and 'sentinel-post' in v['tool_input'].get('command',''):out={'decision':'block','reason':'POST_FEEDBACK'}
if e=='Stop' and str(v.get('last_assistant_message','')).startswith('STOP_CASE'):
 file=p+'/stop-count';count=int(open(file).read()) if os.path.exists(file) else 0
 open(file,'w').write(str(count+1))
 if count<2:out={'decision':'block','reason':'CONTINUE_STOP_'+str(count)}
print(json.dumps(out))
`;
try {
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
  await mkdir(join(workspace, "pkg/hooks"), { recursive: true });
  const configHook = join(workspace, "config-hook.py"),
    configLog = join(workspace, "config-events.jsonl");
  await writeFile(
    configHook,
    `import json,sys,os\nv=json.load(sys.stdin)\nassert 'PLUGIN_ROOT' not in os.environ and 'PLUGIN_DATA' not in os.environ\nwith open(${JSON.stringify(join(workspace, "config-events.jsonl"))},'a') as f:f.write(json.dumps(v)+'\\n')\nprint('{}')\n`,
  );
  const sourceCommand = 'python3 "' + configHook + '"';
  const configText = `schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}"\n[permissions]\nmode="ASK_PERMISSIONS"\n[features]\nhooks=true\n[[hooks.UserPromptSubmit]]\nhooks=[{type="command",command=${JSON.stringify(sourceCommand)}}]\n`;
  await writeFile(config, configText);
  await mkdir(join(workspace, ".codex"), { recursive: true });
  await writeFile(
    join(workspace, ".codex/hooks.json"),
    JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: sourceCommand }] }] },
    }),
  );
  await writeFile(
    join(workspace, ".agents/plugins/marketplace.json"),
    JSON.stringify({ name: "local", plugins: [{ name: "hooks", source: "./pkg" }] }),
  );
  await mkdir(join(workspace, "pkg/.codex-plugin"), { recursive: true });
  await writeFile(
    join(workspace, "pkg/.codex-plugin/plugin.json"),
    JSON.stringify({ name: "hooks" }),
  );
  await writeFile(join(workspace, "pkg/hooks/hook.py"), hookScript);
  const command = 'python3 "${PLUGIN_ROOT}/hooks/hook.py"';
  const hookFile = {
    hooks: Object.fromEntries(
      [
        "SessionStart",
        "UserPromptSubmit",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "Stop",
        "Interrupt",
        "SessionEnd",
        "SubagentStart",
        "SubagentStop",
      ].map((event) => [
        event,
        [
          {
            ...(event === "PreToolUse" || event === "PostToolUse" ? { matcher: "Bash" } : {}),
            hooks: [{ type: "command", command, additionalContextLimit: 128, timeout: 10 }],
          },
        ],
      ]),
    ),
  };
  hookFile.hooks.UserPromptSubmit[0].hooks.push({
    type: "command",
    command: command + " async",
    async: true,
    timeout: 30,
  });
  hookFile.hooks.UserPromptSubmit[0].hooks.push({
    type: "mcp_tool",
    server: "fixture",
    tool: "hook",
    input: { event: "${hook_event_name}", prompt: "${prompt}" },
    timeout: 1,
  });
  for (const event of ["PreCompact", "PostCompact"])
    hookFile.hooks[event] = [
      {
        hooks: [
          {
            type: "mcp_tool",
            server: "fixture",
            tool: "hook",
            input: { event: "${hook_event_name}" },
            timeout: 1,
          },
        ],
      },
    ];
  hookFile.hooks.SessionStart[0].hooks.push({
    type: "mcp_tool",
    server: "fixture",
    tool: "hook",
    input: { event: "${hook_event_name}", source: "${source}" },
    timeout: 1,
  });
  const mcpScript = `import json,sys,os\np=${JSON.stringify(join(home, "plugins/data/hooks@local/mcp.jsonl"))}\nfor line in sys.stdin:\n v=json.loads(line);method=v.get('method');result={}\n if method=='initialize':result={'protocolVersion':v['params']['protocolVersion'],'capabilities':{'tools':{}},'serverInfo':{'name':'hook-fixture','version':'1'}}\n elif method=='tools/list':result={'tools':[{'name':'hook','description':'Fixture hook','inputSchema':{'type':'object'}}]}\n elif method=='tools/call':\n  args=v['params']['arguments']\n  os.makedirs(os.path.dirname(p),exist_ok=True)\n  with open(p,'a') as f:f.write(json.dumps(args)+'\\n')\n  if any('HOOK_CASE='+case in args.get('prompt','') for case in ['form','upload']):\n   if not v['params'].get('requestState'):\n    schema={'type':'object','properties':{'answer':{'type':'string'}},'required':['answer']}\n    if 'HOOK_CASE=upload' in args.get('prompt',''):schema={'type':'object','properties':{'selected':{'type':'string','format':'uri','x-openai-input':{'type':'resource','options':[],'userOptions':{'kind':'file','accept':['.txt']}}}},'required':['selected']}\n    result={'resultType':'input_required','requestState':'fixture-resume','inputRequests':{'fixture-form':{'method':'elicitation/create','params':{'mode':'form','message':'Hook paused active timeout','requestedSchema':{'type':'object','properties':{}},'_meta':{'openai/elicitation':{'requestedSchema':schema}}}}}}\n    print(json.dumps({'jsonrpc':'2.0','id':v['id'],'result':result}),flush=True);continue\n   with open(p,'a') as f:f.write(json.dumps({'reply':v['params'].get('inputResponses')})+'\\n')\n  out={'decision':'block','reason':'MCP_PROMPT_BLOCKED'} if any('HOOK_CASE='+case in args.get('prompt','') for case in ['mcp','form','upload']) else {}\n  result={'content':[{'type':'text','text':json.dumps(out)}]}\n if method=='server/discover':\n  print(json.dumps({'jsonrpc':'2.0','id':v['id'],'result':{'resultType':'complete','supportedVersions':['2026-07-28'],'capabilities':{'tools':{}},'ttlMs':0,'cacheScope':'private'}}),flush=True);continue\n if 'id' in v:print(json.dumps({'jsonrpc':'2.0','id':v['id'],'result':result}),flush=True)\n`;
  await writeFile(join(workspace, "pkg/server.py"), mcpScript);
  await writeFile(
    join(workspace, "pkg/.mcp.json"),
    JSON.stringify({ mcpServers: { fixture: { command: "python3", args: ["server.py"] } } }),
  );
  await writeFile(join(workspace, "pkg/hooks/hooks.json"), JSON.stringify(hookFile));
  service = await cli([
    "service",
    "ensure",
    "--json",
    "--workspace",
    workspace,
    "--config",
    config,
    "--allow-write",
  ]);
  const auth = JSON.parse(await readFile(service.authFile, "utf8"));
  client = new CoreClient({
    createSocket: () =>
      new WebSocket(service.endpoint, {
        headers: { Authorization: "Bearer " + auth.principals[0].token },
      }),
    timeoutMs: 45000,
  });
  await client.connect();
  await cli(["plugin", "--workspace", workspace, "--json", "install", id]);
  let { thread } = await client.request("thread/start", { cwd: workspace });
  await turn("none", thread);
  assert.equal((await events()).length, 0);
  checks.push("install/enable/start is inert until separate current-definition trust");
  let listing = await client.request("areal/plugin/hooks/list", {}),
    row = listing.data.find((r) => r.pluginId === id);
  assert.equal(row.definitions.length, 15);
  await assert.rejects(
    mutate("areal/plugin/hooks/configure", {
      id,
      expectedDigest: row.installedDigest,
      definitionDigest: "0".repeat(64),
      enabled: true,
      trusted: true,
    }),
  );
  const params = {
    id,
    expectedDigest: row.installedDigest,
    definitionDigest: row.definitionDigest,
    enabled: true,
    trusted: true,
    allowReadOnlyCommands: true,
  };
  await mutate("areal/plugin/hooks/configure", params);
  checks.push("stale definition digest rejected; current package+definition review accepted");
  for (const source of listing.data.filter((r) => r.sourceKind)) {
    assert.equal(source.definitions.length, 1);
    await mutate("areal/plugin/hooks/configure", {
      id: source.pluginId,
      expectedDigest: source.installedDigest,
      definitionDigest: source.definitionDigest,
      enabled: true,
      trusted: true,
    });
  }
  await assert.rejects(access(configLog));
  ({ thread } = await client.request("thread/start", { cwd: workspace }));
  for (const name of ["deny", "exit", "rewrite", "post"]) {
    const result = await turn(name, thread);
    assert.equal(result.turn.status, "completed", JSON.stringify(result.turn.error));
    if (["deny", "exit", "rewrite"].includes(name))
      await assert.rejects(access(join(workspace, "sentinel-" + name)));
    if (name === "rewrite")
      assert.equal(await readFile(join(workspace, "sentinel-updated"), "utf8"), "rewritten");
    if (name === "post") {
      assert.equal(await readFile(join(workspace, "sentinel-post"), "utf8"), "post");
      assert(result.requests.some((q) => JSON.stringify(q.messages).includes("POST_FEEDBACK")));
    }
  }
  checks.push(
    "Pre deny and exit2 prevent writes, validated rewrite changes actual command, Post feedback preserves completed side effect",
  );
  const configEvents = (await readFile(configLog, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(configEvents.length, 8);
  checks.push(
    "user inline TOML and project JSON hooks accumulate only after explicit review and receive no plugin environment",
  );
  await writeFile(config, configText.replace("hooks=true", "hooks=false"));
  const pkgCount = (await events()).length,
    sourceCount = configEvents.length;
  await turn("none", thread);
  assert.equal((await events()).length, pkgCount);
  assert.equal((await readFile(configLog, "utf8")).trim().split("\n").length, sourceCount);
  await writeFile(config, configText);
  checks.push("global features.hooks=false gates both reviewed configuration and package hooks");
  const permission = await turn("permission", thread);
  assert.equal(permission.turn.status, "completed");
  await assert.rejects(access(join(workspace, "sentinel-permission")));
  assert(
    (await events())
      .filter((v) => v.hook_event_name === "PermissionRequest")
      .every((v) => !Object.hasOwn(v, "tool_use_id")),
  );
  checks.push(
    "PermissionRequest allow and deny remain separate from PreToolUse and never include tool_use_id",
  );
  const holding = turn("hold", thread).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const holdDeadline = Date.now() + 10000;
  while (!holds.size && Date.now() < holdDeadline) await pause();
  assert(holds.size);
  const parent = (await client.request("thread/read", { threadId: thread.id, includeTurns: true }))
    .thread;
  const parentTurn = parent.turns.at(-1).id;
  if (!deferred.includes("--defer-readonly-child") || deferred.includes("--writable-child")) {
    const child = await client.request("areal/agent/spawn", {
      parentThreadId: thread.id,
      ...(deferred.includes("--writable-child") ? { workspaceMode: "sharedWrite" } : {}),
      input: [{ type: "text", text: "HOOK_CASE=none RUN=" + randomUUID() }],
    });
    const childId = child.thread.id;
    const childDeadline = Date.now() + 10000;
    let childState;
    while (Date.now() < childDeadline) {
      childState = (await client.request("thread/read", { threadId: childId, includeTurns: true }))
        .thread;
      if (childState.turns.at(-1).status !== "inProgress") break;
      await pause();
    }
    assert.equal(childState.turns.at(-1).status, "completed");
    const childEvents = (await events()).filter((v) => v.agent_id === childId);
    assert.equal(childEvents.filter((v) => v.hook_event_name === "SubagentStart").length, 1);
    assert.equal(childEvents.filter((v) => v.hook_event_name === "SubagentStop").length, 1);
    assert(
      childEvents.every((v) => v.session_id === thread.sessionId && v.agent_type === "default"),
    );
    checks.push(
      (deferred.includes("--writable-child") ? "explicit sharedWrite child" : "ordinary child") +
        " inherits parent admitted definitions and emits exact SubagentStart/SubagentStop identity without synthetic UserPromptSubmit",
    );
  }
  const queued = await client.request("areal/turn/enqueue", {
    requestId: randomUUID(),
    threadId: thread.id,
    input: [{ type: "text", text: "HOOK_CASE=steerdeny" }],
  });
  const steerParams = {
    requestId: randomUUID(),
    threadId: thread.id,
    expectedRevision: queued.queueRevision,
    queueItemId: queued.queueItemId,
    expectedTurnId: parentTurn,
  };
  const first = client.request("areal/queue/steer", steerParams).then(
    () => null,
    (e) => e,
  );
  const steerDeadline = Date.now() + 5000;
  while (
    !(await events()).some((v) => v.prompt?.includes("HOOK_CASE=steerdeny")) &&
    Date.now() < steerDeadline
  )
    await pause();
  const duplicate = client.request("areal/queue/steer", steerParams).then(
    () => null,
    (e) => e,
  );
  await writeFile(join(workspace, "release-steer"), "release");
  assert(await first);
  assert(await duplicate);
  await assert.rejects(client.request("areal/queue/steer", steerParams));
  assert.equal(
    (await events()).filter(
      (v) => v.hook_event_name === "UserPromptSubmit" && v.prompt.includes("HOOK_CASE=steerdeny"),
    ).length,
    1,
  );
  await mutate("areal/queue/remove", {
    threadId: thread.id,
    expectedRevision: queued.queueRevision,
    queueItemId: queued.queueItemId,
  });
  const directParams = {
    requestId: randomUUID(),
    threadId: thread.id,
    expectedTurnId: parentTurn,
    input: [{ type: "text", text: "HOOK_CASE=steerok" }],
  };
  await Promise.all([
    client.request("turn/steer", directParams),
    client.request("turn/steer", directParams),
  ]);
  assert.equal(
    (await events()).filter(
      (v) => v.hook_event_name === "UserPromptSubmit" && v.prompt.includes("HOOK_CASE=steerok"),
    ).length,
    1,
  );
  for (const release of holds.values()) release();
  holds.clear();
  assert(!(await holding).error);
  checks.push(
    "concurrent duplicate queue and direct steer requests execute hooks once; rejected same-ID retry never replays",
  );
  const stopped = await turn("stop", thread);
  assert.equal(stopped.turn.status, "completed");
  assert.equal(stopped.requests.length, 3);
  const stops = (await events()).filter(
    (v) => v.hook_event_name === "Stop" && v.last_assistant_message?.startsWith("STOP_CASE"),
  );
  assert.deepEqual(
    stops.map((v) => v.stop_hook_active),
    [false, true, true],
  );
  assert.equal(
    (await events()).filter(
      (v) => v.hook_event_name === "UserPromptSubmit" && v.prompt.includes("HOOK_CASE=stop"),
    ).length,
    1,
  );
  checks.push(
    "Stop may continue twice in the same Turn without synthetic UserPromptSubmit recursion",
  );
  const blocked = await turn("blocked", thread);
  assert.equal(blocked.requests.length, 0);
  assert.equal(blocked.turn.status, "failed");
  checks.push("valid UserPromptSubmit block prevents model sampling");
  const spilled = await turn("spill", thread);
  const context = spilled.requests
    .map((q) => JSON.stringify(q.messages))
    .find((s) => s.includes("Full hook output saved to:"));
  assert(context?.includes("HEAD_") && context.includes("_TAIL"));
  const spillRun = spilled.thread.desktop.hookRuns.find(
    (r) =>
      r.event === "UserPromptSubmit" &&
      r.turnId === spilled.turn.id &&
      !r.asynchronous &&
      r.output.context,
  );
  const path = spillRun.output.context.split("Full hook output saved to: ")[1];
  assert((await readFile(path, "utf8")).endsWith("_TAIL"));
  checks.push("UTF-8 approximate-token spill preserves both ends and recoverable full context");
  if (!deferred.includes("--defer-concurrency")) {
    const background = await turn("async", thread);
    assert.equal(background.turn.status, "completed");
    assert(!background.requests.some((q) => JSON.stringify(q.messages).includes("ASYNC_CONTEXT")));
    const releasing = await turn("release", thread);
    assert.equal(releasing.turn.status, "completed");
    assert.equal(await readFile(join(workspace, "release-async"), "utf8"), "release");
    checks.push(
      "ordinary Core run_command releases a waiting same-session async hook through the bounded Runtime write group",
    );
    const deadline = Date.now() + 5000;
    let completed = false;
    while (Date.now() < deadline) {
      const state = (
        await client.request("thread/read", { threadId: thread.id, includeTurns: true })
      ).thread;
      if (
        state.desktop.hookRuns.some(
          (r) => r.turnId === background.turn.id && r.asynchronous && r.outcome === "succeeded",
        )
      ) {
        completed = true;
        break;
      }
      await pause();
    }
    assert(completed);
    const after = await turn("none", thread);
    assert(after.requests.some((q) => JSON.stringify(q.messages).includes("ASYNC_CONTEXT")));
    checks.push("async control is ignored; idle result injects only into next user Turn");
  }
  await mutate("areal/plugin/connection", {
    id,
    expectedDigest: row.installedDigest,
    connect: true,
  });
  const directory = await client.request("areal/plugin/mcp/list", {});
  await writeFile(join(scratch, "mcp-directory.json"), JSON.stringify(directory, null, 2));
  const mcp = await turn("mcp", thread);
  assert.equal(mcp.turn.status, "failed", JSON.stringify(directory));
  assert.equal(mcp.requests.length, 0);
  checks.push("real stdio MCP hook blocks user sampling without recursive tool invocation");
  const formTurn = turn("form", thread).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const untilForm = Date.now() + 5000;
  let form;
  while (Date.now() < untilForm) {
    form = (await client.request("areal/mcp/forms/list", { threadId: thread.id })).data[0];
    if (form) break;
    await pause();
  }
  assert(form);
  await new Promise((r) => setTimeout(r, 1400));
  await client.request("areal/mcp/form/respond", {
    threadId: thread.id,
    requestId: form.requestId,
    response: { action: "accept", content: { answer: "fixture" } },
  });
  const formResult = await formTurn;
  assert(!formResult.error, String(formResult.error));
  const replied = formResult.value;
  assert.equal(replied.turn.status, "failed");
  assert.equal(replied.requests.length, 0);
  checks.push(
    "MCP hook timeout counts active execution and pauses for real owner-bound elicitation longer than its one-second budget",
  );
  // Model readiness follows several native command hooks; it is not a five-second latency contract.
  const uploadHolding = turn("hold", thread).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const uploadHoldDeadline = Date.now() + 15000;
  while (!holds.size && Date.now() < uploadHoldDeadline) await pause();
  assert(holds.size);
  const uploadParent = (
    await client.request("thread/read", { threadId: thread.id, includeTurns: true })
  ).thread.turns.at(-1).id;
  const picked = join(scratch, "picked.txt");
  await writeFile(picked, "hook-upload-snapshot");
  for (const method of ["turn/steer", "areal/queue/steer"]) {
    const text = "HOOK_CASE=upload RUN=" + randomUUID();
    let parameters = {
      requestId: randomUUID(),
      threadId: thread.id,
      expectedTurnId: uploadParent,
      input: [{ type: "text", text }],
    };
    let queued;
    if (method === "areal/queue/steer") {
      queued = await client.request("areal/turn/enqueue", {
        requestId: randomUUID(),
        threadId: thread.id,
        input: parameters.input,
      });
      parameters = {
        requestId: parameters.requestId,
        threadId: thread.id,
        expectedTurnId: uploadParent,
        expectedRevision: queued.queueRevision,
        queueItemId: queued.queueItemId,
      };
    }
    const first = client.request(method, parameters).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const duplicate = client.request(method, parameters).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const deadline = Date.now() + 5000;
    let uploadForm;
    while (Date.now() < deadline) {
      uploadForm = (await client.request("areal/mcp/forms/list", { threadId: thread.id })).data[0];
      if (uploadForm) break;
      await pause();
    }
    assert(uploadForm, "steer upload form");
    const prepared = await client.request("areal/mcp/form/resource/prepare", {
      threadId: thread.id,
      requestId: uploadForm.requestId,
      fieldName: "selected",
    });
    const staged = await mutate("areal/mcp/form/resource/stage", {
      selectionToken: prepared.selectionToken,
      paths: [picked],
    });
    assert.equal(staged.summary.fileCount, 1);
    await client.request("areal/mcp/form/respond", {
      threadId: thread.id,
      requestId: uploadForm.requestId,
      response: { action: "accept", content: { selected: staged.resources[0].uri } },
    });
    assert((await first).error);
    assert((await duplicate).error);
    await assert.rejects(client.request(method, parameters));
    assert.equal(
      (await events()).filter((v) => v.hook_event_name === "UserPromptSubmit" && v.prompt === text)
        .length,
      1,
    );
    if (queued)
      await mutate("areal/queue/remove", {
        threadId: thread.id,
        expectedRevision: queued.queueRevision,
        queueItemId: queued.queueItemId,
      });
  }
  for (const release of holds.values()) release();
  holds.clear();
  assert(!(await uploadHolding).error);
  checks.push(
    "actual direct/queue steer MCP upload can stage while original submission waits; concurrent duplicates and rejected retry execute one hook",
  );
  await client.request("areal/context/compact", { threadId: thread.id });
  const calls = (await readFile(join(home, "plugins/data/hooks@local/mcp.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  for (const event of ["PreCompact", "PostCompact"])
    assert.equal(calls.filter((v) => v.event === event).length, 1);
  assert.equal(calls.filter((v) => v.event === "SessionStart" && v.source === "compact").length, 1);
  checks.push(
    "manual compaction executes Pre/Post/SessionStart MCP hooks under real compaction owner",
  );
  const observedHooks = (
    await client.request("thread/read", { threadId: thread.id, includeTurns: true })
  ).thread.desktop.hookRuns;
  assert(
    !observedHooks.some((r) => r.operationId && r.outcome === "timedOut"),
    "normal command hook exceeded its fixture budget",
  );
  const before = await events();
  assert(before.some((v) => v.hook_event_name === "SessionStart"));
  assert(
    before.filter((v) => v.hook_event_name === "PreToolUse").every((v) => v.tool_name === "Bash"),
  );
  assert(before.every((v) => v.cwd === workspace));
  checks.push(
    "real Runtime stdin EOF, plugin environment/data paths, canonical Bash payload and session cwd",
  );
  // Two real Core processes share the package home but have independent workspace state.
  if (!deferred.includes("--defer-concurrency")) {
    const peerWorkspace = join(scratch, "peer-workspace");
    await mkdir(peerWorkspace, { recursive: true });
    peerService = await cli([
      "service",
      "ensure",
      "--json",
      "--workspace",
      peerWorkspace,
      "--config",
      config,
      "--allow-write",
    ]);
    assert.notEqual(peerService.endpoint, service.endpoint);
    ({ thread } = await client.request("thread/start", { cwd: workspace }));
    const background = await turn("cancel", thread),
      pid = await descendant(background.turn.id);
    const holding = turn("hold", thread).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const until = Date.now() + 10000;
    while (!holds.size && Date.now() < until) await pause();
    assert(holds.size);
    await cli(["plugin", "--workspace", peerWorkspace, "--json", "disable", id]);
    // No list/configure/refresh request to the original Core before checking exit.
    await assertExited(pid);
    const eventCount = (await events()).length;
    for (const release of holds.values()) release();
    holds.clear();
    const settled = await holding;
    assert(!settled.error, settled.error?.stack);
    assert.equal(settled.value.turn.status, "completed");
    assert.equal(
      (await events()).length,
      eventCount,
      "frozen Stop hook executed after peer disable",
    );
    assert(
      settled.value.thread.desktop.hookRuns.some(
        (r) => r.turnId === background.turn.id && r.asynchronous && r.outcome === "cancelled",
      ),
    );
    await cli(["plugin", "--workspace", peerWorkspace, "--json", "enable", id]);
    const stopped = await cli([
      "service",
      "stop",
      "--json",
      "--workspace",
      peerWorkspace,
      "--cancel",
    ]);
    assert.equal(stopped.state, "stopped");
    peerService = null;
    checks.push(
      "peer Core user disable cancels idle native descendants without refresh and rejects frozen Stop hooks in an active Turn",
    );
  }
  await mutate("areal/plugin/hooks/configure", { ...params, enabled: false, trusted: false });
  const count = (await events()).length;
  await turn("none", thread);
  assert.equal((await events()).length, count);
  checks.push("explicit revocation prevents new events without replay");
  if (!deferred.includes("--defer-concurrency")) {
    await mutate("areal/plugin/hooks/configure", params);
    ({ thread } = await client.request("thread/start", { cwd: workspace }));
    const archived = await turn("archive", thread);
    const archivedPid = await descendant(archived.turn.id);
    const archiveResult = await mutate("areal/thread/archive", { threadId: thread.id });
    assert.equal(archiveResult.archived, true);
    await assertExited(archivedPid);
    const retained = (
      await client.request("thread/read", { threadId: thread.id, includeTurns: true })
    ).thread;
    assert(retained.turns.some((t) => t.id === archived.turn.id));
    await assert.rejects(
      client.request("turn/start", {
        threadId: thread.id,
        input: [{ type: "text", text: "must not resume" }],
      }),
    );
    checks.push(
      "archive cancels async descendants, executes End once, preserves cold history and rejects new Turns",
    );
    ({ thread } = await client.request("thread/start", { cwd: workspace }));
    const cancelling = await turn("cancel", thread);
    const cancelledPid = await descendant(cancelling.turn.id);
    const stop = await cli(["service", "stop", "--json", "--workspace", workspace, "--cancel"]);
    assert.equal(stop.state, "stopped", JSON.stringify(stop));
    await assertExited(cancelledPid);
    service = null;
    const ended = (await events()).filter(
      (v) => v.hook_event_name === "SessionEnd" && v.session_id === thread.sessionId,
    );
    assert.equal(ended.length, 1);
    checks.push(
      "cancel drain actively closes idle async descendants and runs SessionEnd exactly once",
    );
  }
  passed = true;
} catch (error) {
  failure = error;
} finally {
  for (const release of holds.values()) release();
  client?.close();
  if (peerService) {
    try {
      await cli([
        "service",
        "stop",
        "--json",
        "--workspace",
        join(scratch, "peer-workspace"),
        "--cancel",
      ]);
    } catch (error) {
      passed = false;
      failure ??= error;
    }
  }
  if (service) {
    try {
      await cli(["service", "stop", "--json", "--workspace", workspace, "--cancel"]);
    } catch (error) {
      passed = false;
      failure ??= error;
    }
  }
  model.closeAllConnections();
  await new Promise((r) => model.close(r));
}
const manifest = {
  passed,
  checks,
  scratch,
  core: bin,
  coreSha256,
  coreUnchanged:
    createHash("sha256")
      .update(await readFile(bin))
      .digest("hex") === coreSha256,
  sourceHead,
  sourceDiffSha256,
  sourceFiles,
  deferred,
  completeMatrix: deferred.length === 0,
  failure: failure?.stack,
  scope: "actual Core/Runtime hooks with original package and deterministic local model",
  gaps: ["real Codex binary/provider/native/package acceptance separate"],
};
await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
if (!passed) process.exitCode = 1;
