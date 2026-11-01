import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const selected = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7) ?? "all";
assert.ok(
  ["create", "receipt", "read", "journal", "domain", "all"].includes(selected),
  "use --case=create|receipt|read|journal|domain|all",
);
const gui = process.env.AREAL_RECOVERY_GUI_ROOT
  ? resolve(process.env.AREAL_RECOVERY_GUI_ROOT, "clients/gui")
  : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require(join(gui, "app/src/core/backend.cjs"));
const scratch = await makeTempDir("areal-recovery-contract-");
const workspace = join(scratch, "workspace");
await mkdir(workspace);
await mkdir(join(scratch, "user", ".areal"), { recursive: true });
const modelCalls = [];
const model = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const title =
    body.messages?.[0]?.content?.startsWith("Generate a concise semantic session title") === true;
  modelCalls.push({ title, at: Date.now() });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  chunk({ content: title ? "Recovery fixture" : "RECOVERY_HISTORY_SENTINEL" });
  chunk({}, "stop");
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  join(scratch, "user", ".areal", "config.toml"),
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\n`,
);
const deployment = join(scratch, "desktop.json");
await writeFile(
  deployment,
  JSON.stringify({
    profiles: [
      { id: "fixture", revision: "v1", displayName: "Fixture", instructions: "Complete the task" },
    ],
  }),
);
let watch;
const backend = new CoreBackend({
  binary: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
  home: join(scratch, "desktop"),
  hostHome: join(scratch, "host-home"),
  guiProfile: join(scratch, "profile"),
  sourceSingletonHeld: true,
  encryption: {
    isEncryptionAvailable() {
      throw new Error("fixture must not access Keychain");
    },
    encryptString() {
      throw new Error("fixture must not encrypt credentials");
    },
    decryptString() {
      throw new Error("fixture must not decrypt credentials");
    },
  },
  harnessHome: join(scratch, "registry"),
  userHome: join(scratch, "user"),
  desktopConfig: deployment,
  defaultProfile: { id: "fixture", revision: "v1" },
  onChange: () => {
    if (!watch) return;
    const view = backend.snapshot().projects.find((value) => value.id === watch.projectId);
    watch.published.push({
      pending: view?.pending.map((value) => value.params.requestId),
      outcome: view?.outcomes[watch.requestId] ?? null,
    });
  },
});
const results = [];
const workRequests = () => modelCalls.filter((call) => !call.title).length;
const copy = (value) => JSON.parse(JSON.stringify(value));
async function until(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timeout: ${label}`);
}
async function completed(project, threadId) {
  await until(
    () => {
      const turn = project.model.state.threads[threadId]?.turns.at(-1);
      if (turn?.status === "failed")
        throw new Error(`Fixture turn failed: ${JSON.stringify(turn.error)}`);
      return turn?.status === "completed";
    },
    "fixture turn completed",
    30000,
  );
}
function sameConnection(project, original) {
  assert.equal(project.client, original.client, "recovery uses the original healthy client");
  assert.equal(project.client.ready, true);
  assert.equal(project.connectionGeneration, original.connection);
  assert.equal(project.service.generation, original.service);
}
const connection = (project) => ({
  client: project.client,
  connection: project.connectionGeneration,
  service: project.service.generation,
});
async function createCase(project, evidence) {
  await backend.command("list", { projectId: project.id });
  const before = new Set(project.summaries.map((thread) => thread.id));
  const requestId = randomUUID();
  const request = project.client.request.bind(project.client);
  const open = backend.openThread;
  let reply,
    result,
    failure,
    injected = 0;
  evidence.requestId = requestId;
  evidence.submissions = [];
  project.client.request = async (method, params, options) => {
    const value = await request(method, params, options);
    if (method === "areal/thread/start") {
      evidence.submissions.push(params.requestId);
      reply = value;
    }
    return value;
  };
  backend.openThread = async function (target, threadId, ...rest) {
    if (target === project && threadId === reply?.thread?.id && injected++ === 0)
      throw Object.assign(new Error("INJECTED_DESKTOP_CREATE_REFRESH"), {
        code: "TIMEOUT",
        method: "areal/thread/observe",
        submissionUnknown: false,
      });
    return open.call(this, target, threadId, ...rest);
  };
  try {
    try {
      result = await backend.command("create", { projectId: project.id, requestId });
    } catch (error) {
      failure = {
        message: error.message,
        requestId: error.requestId,
        submissionUnknown: error.submissionUnknown,
      };
    }
  } finally {
    project.client.request = request;
    backend.openThread = open;
  }
  await backend.command("list", { projectId: project.id });
  evidence.result = result ?? null;
  evidence.error = failure ?? null;
  evidence.injected = injected;
  evidence.created = project.summaries
    .filter((thread) => !before.has(thread.id))
    .map((thread) => thread.id);
  assert.deepEqual(
    evidence.created,
    [reply?.thread?.id],
    "Core creates exactly the original Thread",
  );
  assert.deepEqual(
    evidence.submissions,
    [requestId],
    "create preserves caller identity and submits once",
  );
  assert.equal(injected, 1, "post-admission Desktop refresh failed once");
  assert.equal(failure, undefined, "a confirmed create survives Desktop refresh failure");
  assert.deepEqual(
    { threadId: result.threadId, requestId: result.requestId },
    { threadId: reply.thread.id, requestId },
  );
}
async function receiptCase(project, evidence) {
  const { threadId } = await backend.command("create", {
    projectId: project.id,
    requestId: randomUUID(),
  });
  const requestId = randomUUID();
  const original = connection(project),
    request = project.client.request.bind(project.client);
  const count = workRequests();
  Object.assign(evidence, { threadId, requestId, submissions: [], queries: [], published: [] });
  watch = { projectId: project.id, requestId, published: evidence.published };
  let hidden = 0,
    injected = 0;
  project.client.request = async (method, params, options) => {
    if (method === "areal/turn/submit") evidence.submissions.push(params.requestId);
    const value = await request(method, params, options);
    if (method === "areal/turn/submit" && params.requestId === requestId && injected++ === 0)
      throw Object.assign(new Error("INJECTED_ACCEPTED_RESPONSE_LOSS"), {
        method,
        code: "RESPONSE_UNKNOWN",
        requestId,
        submissionUnknown: true,
      });
    if (method === "areal/request/read" && params.requestId === requestId) {
      const matching = value.data.filter(
        (receipt) => receipt.method === "areal/turn/submit" && receipt.requestId === requestId,
      );
      const hide = matching.length > 0 && hidden < 2;
      if (hide) hidden++;
      evidence.queries.push({
        requestId: params.requestId,
        threadId: params.threadId,
        matching: matching.length,
        hidden: hide,
      });
      if (hide)
        return { ...value, data: value.data.filter((receipt) => !matching.includes(receipt)) };
    }
    return value;
  };
  try {
    try {
      evidence.result = await backend.command("send", {
        projectId: project.id,
        threadId,
        requestId,
        text: "Recover the original accepted receipt",
      });
    } catch (error) {
      evidence.error = {
        message: error.message,
        requestId: error.requestId,
        submissionUnknown: error.submissionUnknown,
      };
      assert.equal(error.submissionUnknown, true);
      assert.equal(
        error.requestId,
        requestId,
        "unknown response retains the original caller identity",
      );
    }
    await until(
      () =>
        project.outcomes[requestId]?.accepted === true &&
        !project.pending.some((entry) => entry.params.requestId === requestId),
      "automatic receipt reconciliation on healthy connection",
    );
    await completed(project, threadId);
    evidence.outcome = copy(project.outcomes[requestId]);
    evidence.hidden = hidden;
    evidence.injected = injected;
    evidence.modelRequests = workRequests() - count;
    assert.deepEqual(
      evidence.submissions,
      [requestId],
      "receipt recovery never replays the mutation",
    );
    assert.equal(hidden, 2, "two reads hide a real matching Core receipt");
    assert.ok(evidence.queries.length >= 3, "Desktop polls beyond the hidden receipt reads");
    assert.equal(evidence.outcome.threadId, threadId);
    assert.equal(evidence.modelRequests, 1, "one accepted send causes one non-title model request");
    assert.equal(project.model.state.threads[threadId].turns.length, 1);
    assert.ok(
      evidence.published.some((value) => value.pending.includes(requestId)),
      "Desktop publishes the original pending request",
    );
    assert.ok(
      evidence.published.some(
        (value) => value.outcome?.accepted === true && !value.pending.includes(requestId),
      ),
      "Desktop publishes the settled outcome and clears pending",
    );
    sameConnection(project, original);
  } finally {
    project.client.request = request;
    watch = undefined;
    evidence.hidden = hidden;
    evidence.injected = injected;
  }
}
async function readCase(project, evidence) {
  const { threadId } = await backend.command("create", {
    projectId: project.id,
    requestId: randomUUID(),
  });
  await backend.command("send", {
    projectId: project.id,
    threadId,
    requestId: randomUUID(),
    text: "Keep this original history",
  });
  await completed(project, threadId);
  // 完成通知可能已有共享观察请求；先等其退出，再注入下一次独立读取。
  await backend.openThread(project, threadId);
  const history = copy(project.model.state.threads[threadId].turns);
  assert.match(JSON.stringify(history), /RECOVERY_HISTORY_SENTINEL/);
  const original = connection(project),
    request = project.client.request.bind(project.client),
    count = workRequests();
  Object.assign(evidence, { threadId, observeCalls: 0, injected: 0, originalHistory: history });
  project.client.request = async (method, params, options) => {
    if (method === "areal/thread/observe" && params.threadId === threadId) {
      evidence.observeCalls++;
      if (evidence.injected === 0) {
        evidence.injected++;
        assert.equal(project.client.ready, true, "read timeout does not close the client");
        throw Object.assign(new Error("INJECTED_HEALTHY_OBSERVE_TIMEOUT"), {
          method,
          code: "TIMEOUT",
          submissionUnknown: false,
        });
      }
    }
    return request(method, params, options);
  };
  try {
    await backend.openThread(project, threadId);
    assert.equal(evidence.injected, 1, "exactly one observation read fails");
    assert.ok(evidence.observeCalls >= 2, "openThread retries its failed pure read");
    assert.deepEqual(
      copy(project.model.state.threads[threadId].turns),
      history,
      "retry restores the exact original history",
    );
    sameConnection(project, original);
    evidence.modelRequests = workRequests() - count;
    assert.equal(evidence.modelRequests, 0, "history recovery starts no model work");
  } finally {
    project.client.request = request;
  }
}
async function journalCase(project, evidence) {
  const { threadId } = await backend.command("create", {
    projectId: project.id,
    requestId: randomUUID(),
  });
  const requestId = randomUUID(),
    count = workRequests();
  const journal = backend.host.journal(project.id);
  const change = journal.change.bind(journal);
  let blockOutcome = true;
  journal.change = (mutate) =>
    change((snapshot) => {
      const next = mutate(snapshot);
      if (blockOutcome && next.outcomes[requestId])
        throw new Error("fixture blocks Host journal outcome staging");
      return next;
    });
  const request = project.client.request.bind(project.client);
  let writes = 0;
  project.client.request = (method, params, options) => {
    if (method === "areal/turn/submit") writes++;
    return request(method, params, options);
  };
  try {
    const result = await backend.command("send", {
      projectId: project.id,
      threadId,
      requestId,
      text: "Keep admission through local disk failure",
    });
    assert.ok(result.turn?.id, "known Core acceptance survives Host journal staging failure");
    assert.equal(
      project.pending.find((value) => value.params.requestId === requestId)?.operation.requestId,
      requestId,
    );
    assert.equal(project.refreshErrors[requestId].refreshPending, true);
    evidence.acceptedTurnId = result.turn.id;
    evidence.retainedRequestId = requestId;
    blockOutcome = false;
    await until(
      () =>
        project.outcomes[requestId]?.accepted === true &&
        !project.pending.some((value) => value.params.requestId === requestId),
      "receipt settles after Host journal staging recovers",
    );
    await completed(project, threadId);
    assert.equal(project.model.state.threads[threadId].turns.length, 1);
    assert.equal(writes, 1);
    assert.equal(workRequests() - count, 1);
    evidence.submissions = writes;
    evidence.modelRequests = workRequests() - count;
  } finally {
    project.client.request = request;
    journal.change = change;
  }
}

async function domainCase(project, evidence) {
  const { threadId } = await backend.command("create", {
    projectId: project.id,
    requestId: randomUUID(),
  });
  const original = connection(project),
    count = workRequests();
  evidence.operations = [];
  const sourceProject = project;
  const lose = async (method, name, parameters, project = sourceProject) => {
    const requestId = randomUUID(),
      request = project.client.request.bind(project.client);
    let writes = 0,
      hidden = 0,
      result;
    project.client.request = async (called, params, options) => {
      const value = await request(called, params, options);
      if (called === method && params.requestId === requestId) {
        writes++;
        result = value;
        throw Object.assign(new Error("INJECTED_DOMAIN_RESPONSE_LOSS"), {
          code: "TIMEOUT",
          method,
          submissionUnknown: true,
          requestId,
        });
      }
      if (called === "areal/request/read" && params.requestId === requestId && hidden < 2) {
        hidden++;
        return { ...value, data: [] };
      }
      return value;
    };
    try {
      await assert.rejects(
        backend.command(name, { projectId: project.id, ...parameters, requestId }),
        (error) => error.submissionUnknown === true && error.requestId === requestId,
      );
      await until(
        () =>
          project.outcomes[requestId]?.accepted === true &&
          !project.pending.some((value) => value.params.requestId === requestId),
        `${method} original receipt`,
      );
      const outcome = project.outcomes[requestId];
      assert.equal(outcome.operation.requestId, requestId);
      assert.equal(outcome.operation.method, method);
      assert.equal(writes, 1);
      assert.equal(hidden, 2);
      evidence.operations.push({ method, requestId, writes, hidden, operation: outcome.operation });
      return result;
    } finally {
      project.client.request = request;
    }
  };
  const before = project.configurations[threadId].revision;
  const configuration = await lose("areal/thread/configure", "configure", {
    threadId,
    expectedRevision: before,
    options: { readOnly: true },
  });
  assert.equal(configuration.revision, before + 1);
  assert.equal(
    (await project.client.request("areal/thread/inspect", { threadId })).configuration.revision,
    before + 1,
  );
  const prepared = await backend.command("projectless", {
    operation: "prepare",
    requestId: randomUUID(),
  });
  await backend.command("connect", { projectId: prepared.projectId });
  const taskProject = backend.projects.get(prepared.projectId);
  const taskConnection = connection(taskProject);
  const task = await lose(
    "areal/task/create",
    "manage",
    {
      operation: "taskCreate",
      mode: "scheduled",
      objective: "RECOVERY_FUTURE_TASK",
      interactionMode: "interactive",
      schedule: { at: Math.floor(Date.now() / 1000) + 86400, timeZone: "UTC" },
    },
    taskProject,
  );
  assert.ok(task.id);
  assert.equal(evidence.operations.at(-1).operation.target.taskId, task.id);
  const paused = await lose(
    "areal/task/pause",
    "manage",
    {
      operation: "taskPause",
      taskId: task.id,
      expectedRevision: task.revision,
    },
    taskProject,
  );
  assert.equal(paused.paused, true);
  assert.equal(
    (await taskProject.client.request("areal/task/read", { taskId: task.id })).revision,
    paused.revision,
  );
  assert.equal(
    workRequests() - count,
    0,
    "configuration and future schedule recovery start no model work",
  );
  sameConnection(project, original);
  sameConnection(taskProject, taskConnection);
}

const cases = {
  create: createCase,
  receipt: receiptCase,
  read: readCase,
  journal: journalCase,
  domain: domainCase,
};
let fatal, cleanupError;
try {
  await backend.init();
  const projectId = await backend.addProject(workspace),
    project = backend.projects.get(projectId);
  for (const [name, run] of Object.entries(cases)) {
    if (selected !== "all" && selected !== name) continue;
    const result = {
      case: name,
      passed: false,
      injectionBoundary: {
        create: "Desktop openThread after real create receipt",
        receipt:
          "CoreClient request after real submit; matching receipt hidden on first two real query responses",
        read: "CoreClient request before first observe read, healthy client retained",
        journal: "HostJournal staging adapter rejects outcome change after real Core admission",
        domain: "real configure and Task mutation replies lost; first two receipt reads hidden",
      }[name],
    };
    try {
      await run(project, result);
      result.passed = true;
    } catch (error) {
      result.failure = { message: error.message, stack: error.stack };
    }
    results.push(result);
    await writeFile(join(scratch, `${name}.json`), JSON.stringify(result, null, 2));
  }
} catch (error) {
  fatal = { message: error.message, stack: error.stack };
} finally {
  try {
    if (backend.host.client.generation) {
      const stopped = await backend.host.client.request("host.stop", {
        requestId: randomUUID(),
        expectedGeneration: backend.host.client.generation,
        strategy: "cancel",
      });
      assert.equal(stopped.state, "completed", "isolated Host cleanup completes");
    }
    await backend.shutdown({ cancel: true });
  } catch (error) {
    cleanupError = error.message;
  }
  await backend.disconnect().catch((error) => {
    cleanupError ??= error.message;
  });
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  const passed =
    !fatal && !cleanupError && results.length > 0 && results.every((result) => result.passed);
  const manifest = {
    passed,
    selected,
    gui,
    binary: backend.binary,
    scope:
      "real production CoreBackend and real Core; deterministic local SSE model; isolated Desktop home, user home, workspace and service registry; no Renderer acceptance",
    injections:
      "only labeled request-response and Desktop refresh boundaries; real admission, persistence, receipts and history",
    results,
    modelCalls,
    fatal,
    cleanupError,
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(
    JSON.stringify({
      passed,
      evidence: scratch,
      cases: results.map(({ case: name, passed }) => ({ case: name, passed })),
      fatal,
      cleanupError,
    }),
  );
  if (!passed) process.exitCode = 1;
}
