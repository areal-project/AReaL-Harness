import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { CoreClient } from "../packages/runtime-client/core.js";

const require = createRequire(import.meta.url);
const { HostClient } = createRequire(new URL("../app/package.json", import.meta.url))(
  "@areal/client/node",
);
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { isAwaitingResponse } = require("@areal/workbench-service/desktop/core/project-state.cjs");
const root = await realpath(await trackedMkdtemp("/tmp/ah-gui-journal-"));
const binary = resolve(process.env.AREAL_CORE_BIN ?? ".local/shared-host-bin/areal");
const home = join(root, "host-home");
const workspace = join(root, "workspace");
const user = join(root, "user");
const configHome = join(root, "config");
for (const path of [home, workspace, user, configHome]) await mkdir(path, { mode: 0o700 });
const config = join(configHome, "config.toml");
await writeFile(
  config,
  'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1/v1/chat/completions"\n',
);
const evidence = {
  root,
  binary,
  binarySha256: createHash("sha256")
    .update(await readFile(binary))
    .digest("hex"),
  scope: "ordinary CoreBackend submission owner, real Host CAS and Core creation receipts",
  excluded: ["Electron renderer", "Keychain", "real provider", "package"],
  checks: [],
};
const host = spawn(binary, ["host", "run"], {
  env: { PATH: process.env.PATH, HOME: user, AREAL_HARNESS_HOME: home, OTEL_SDK_DISABLED: "true" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
host.stdout.on("data", (data) => {
  output += data;
});
host.stderr.on("data", (data) => {
  output += data;
});
const a = new HostClient();
const b = new HostClient();
let core;
const backends = [];
const check = (name) => evidence.checks.push(name);
const deferred = () => Promise.withResolvers();
const requestId = () => randomUUID();
let projectId;
function backend(client) {
  const value = Object.assign(Object.create(CoreBackend.prototype), {
    host: client,
    saved: [{ id: projectId, root: workspace }],
    projects: new Map(),
    awaitingResponses: new Set(),
    onChange() {},
    worktrees: { observeProject: async () => {} },
    providers: { redact: (value) => value, acceptModelSelection: async () => {}, rejectModel() {} },
    lifecycleOperations: { activeTargets: new Set(), blocking: () => false },
    refreshAfterAdmission: async () => {},
    listThreads: async () => {},
  });
  backends.push(value);
  return value;
}
try {
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      await a.connect(home);
      break;
    } catch (error) {
      if (host.exitCode !== null || Date.now() > deadline)
        throw new Error(output, { cause: error });
      await new Promise((done) => setTimeout(done, 30));
    }
  }
  await b.connect(home);
  projectId = requestId();
  const registration = await a.registerProject(requestId(), {
    projectId,
    workspace,
    dataDir: join(root, "data"),
    source: { kind: "cli" },
    defaultBinding: true,
  });
  assert.equal(registration.registration.projectId, projectId);
  const A = backend(a),
    B = backend(b);
  const p = await A.loadProjectJournal(projectId),
    q = await B.loadProjectJournal(projectId);
  assert.deepEqual([p.pending, p.outcomes], [[], {}]);
  check("ordinary published CLI project has empty journal through GUI consumer");
  const ensured = await a.request("project.ensure", {
    requestId: requestId(),
    expectedGeneration: a.generation,
    projectId,
    launchInputs: {
      workspace,
      cwd: workspace,
      configHome,
      homedir: user,
      configPath: config,
      environment: {},
      credentialNames: [],
      options: {
        allow_write: false,
        allow_network: false,
        allow_concurrent_writes: false,
        read_only_path: [],
        task_credential_command: [],
        no_deployment_mcp: false,
      },
    },
  });
  assert(ensured.service, JSON.stringify(ensured));
  const auth = JSON.parse(await readFile(ensured.service.authFile, "utf8"));
  core = new CoreClient({
    createSocket: () =>
      new WebSocket(ensured.service.endpoint, {
        headers: { Authorization: `Bearer ${auth.principals[0].token}` },
      }),
  });
  await core.connect();
  for (const project of [p, q]) {
    project.client = core;
    project.connectionGeneration = 1;
  }
  const baseRequest = core.request.bind(core);
  const sent = deferred(),
    release = deferred();
  let dispatches = 0;
  core.request = async (method, params, options) => {
    if (method === "areal/thread/start") {
      dispatches++;
      const result = await baseRequest(method, params, options);
      sent.resolve(result);
      await release.promise;
      return result;
    }
    return baseRequest(method, params, options);
  };
  const originalId = requestId();
  const submitted = A.submit(p, "areal/thread/start", {}, { requestId: originalId });
  const admitted = await sent.promise;
  const other = {
    method: "areal/task/update",
    params: { requestId: requestId(), taskId: "unknown" },
  };
  await B.changePending(q, (entries) => [...entries, other]);
  await A.loadProjectJournal(projectId);
  await B.loadProjectJournal(projectId);
  assert.deepEqual(
    p.pending.map((entry) => isAwaitingResponse(A.awaitingResponses, p.id, entry)),
    [true, false],
  );
  assert(q.pending.every((entry) => !isAwaitingResponse(B.awaitingResponses, q.id, entry)));
  release.resolve();
  await submitted;
  assert.equal(dispatches, 1);
  assert.deepEqual(p.pending, [other]);
  assert.equal(p.outcomes[originalId].threadId, admitted.thread.id);
  check(
    "two consumers preserve other UNKNOWN and process-local in-flight across actual Core reply barrier",
  );

  let conflict = true;
  const hostRequest = a.request.bind(a);
  const duplicate = requestId();
  const known = { method: "areal/thread/start", accepted: true, threadId: admitted.thread.id };
  a.request = async (method, params) => {
    if (method === "journal.prepare" && conflict) {
      conflict = false;
      await B.changeOutcomes(q, (outcomes) => ({ ...outcomes, [duplicate]: known }));
    }
    return hostRequest(method, params);
  };
  await assert.rejects(
    A.submit(p, "areal/thread/start", {}, { requestId: duplicate }),
    /请求标识已使用/,
  );
  assert.equal(dispatches, 1);
  await A.loadProjectJournal(projectId);
  assert.deepEqual(p.outcomes[duplicate], known);
  assert.deepEqual(p.pending, [other]);
  check("real CAS conflict reruns duplicate check against latest outcomes without dispatch");

  const remote = {
    hostId: "original-noise-host",
    devicePeerId: "device",
    projectId: "legacy-project-id",
    commandId: requestId(),
    method: "interaction.respond",
    capability: "control",
    semanticDigest: "original-digest",
    target: { projectId: "legacy-project-id" },
  };
  const operationId = requestId();
  const remoteOutcome = {
    method: "areal/interaction/respond",
    operationId,
    remote,
    admissionState: "accepted",
    executionState: "completed",
    accepted: true,
  };
  conflict = true;
  a.request = async (method, params) => {
    if (method === "journal.prepare" && conflict) {
      conflict = false;
      await B.changeOutcomes(q, (outcomes) => ({ ...outcomes, [operationId]: remoteOutcome }));
    }
    return hostRequest(method, params);
  };
  let remoteDispatches = 0;
  const remoteResult = await A.submit(
    p,
    "areal/interaction/respond",
    { requestId: "original-interaction" },
    {
      remote,
      dispatch: async () => {
        remoteDispatches++;
        return {};
      },
    },
  );
  assert.deepEqual(remoteResult, remoteOutcome);
  assert.equal(remoteDispatches, 0);
  await assert.rejects(
    A.submit(
      p,
      "areal/interaction/respond",
      { requestId: "original-interaction" },
      {
        remote: { ...remote, semanticDigest: "changed-digest" },
        dispatch: async () => {
          remoteDispatches++;
          return {};
        },
      },
    ),
    (error) => error.code === "COMMAND_CONFLICT",
  );
  assert.equal(remoteDispatches, 0);
  check(
    "Remote CAS retry preserves original association and detects semantic conflict before dispatch",
  );

  const large = {
    method: "areal/thread/start",
    params: {
      requestId: requestId(),
      creationAdmission: { ...core.capabilities.features.threadCreationJournal.binding },
      originalExtension: "x".repeat(1024 * 1024 + 10),
    },
    originalUnknownExtension: { keep: true },
  };
  await B.changePending(q, (entries) => [...entries, large]);
  await A.loadProjectJournal(projectId);
  assert.deepEqual(
    p.pending.find((entry) => entry.params.requestId === large.params.requestId),
    large,
  );
  assert.deepEqual(p.outcomes[operationId], remoteOutcome);
  check("single entry over 1 MiB and original creation binding survive whole-pair GUI projection");
  a.request = hostRequest;

  const lostBusinessId = requestId();
  let lostHostId;
  a.request = async (method, params) => {
    const result = await hostRequest(method, params);
    if (method === "journal.commit" && !lostHostId) {
      lostHostId = params.requestId;
      throw new Error("fixture lost completed Host commit response");
    }
    return result;
  };
  await assert.rejects(
    A.submit(p, "areal/thread/start", {}, { requestId: lostBusinessId }),
    (error) => {
      assert.equal(error.requestId, lostHostId);
      assert.equal(error.operation, "journal.commit");
      return true;
    },
  );
  assert.equal(dispatches, 1);
  assert(!p.pending.some((entry) => entry.params.requestId === lostBusinessId));
  a.request = hostRequest;
  const receipt = await a.request("host.operation", { requestId: lostHostId });
  assert.equal(receipt.operation.state, "completed");
  await A.loadProjectJournal(projectId);
  assert(p.pending.some((entry) => entry.params.requestId === lostBusinessId));
  check(
    "lost Host commit response preserves original Host/business IDs and sends zero Core mutation",
  );

  const lostCoreId = requestId();
  let lostCoreResult;
  let hideReceipt = true;
  core.request = async (method, params, options) => {
    if (method === "areal/request/read" && hideReceipt)
      throw new Error("fixture hides initial original receipt");
    const result = await baseRequest(method, params, options);
    if (method === "areal/thread/start") {
      dispatches++;
      lostCoreResult = result;
      throw Object.assign(new Error("fixture lost completed Core response"), {
        submissionUnknown: true,
      });
    }
    return result;
  };
  await assert.rejects(
    A.submit(p, "areal/thread/start", {}, { requestId: lostCoreId }),
    (error) => error.submissionUnknown === true,
  );
  assert.equal(dispatches, 2);
  hideReceipt = false;
  const C = backend(b),
    reopened = await C.loadProjectJournal(projectId);
  reopened.client = core;
  reopened.connectionGeneration = 1;
  const recovered = await C.readSubmission(reopened, "areal/thread/start", {
    requestId: lostCoreId,
  });
  assert.equal(recovered.confirmed, true);
  assert.equal(recovered.result.threadId ?? recovered.result.thread?.id, lostCoreResult.thread.id);
  assert.equal(dispatches, 2);
  assert(reopened.pending.some((entry) => entry.params.requestId === lostBusinessId));
  assert(reopened.pending.some((entry) => entry.params.requestId === other.params.requestId));
  check(
    "lost Core response dispatches once and reopened GUI only queries exact original Core receipt",
  );
  evidence.passed = true;
} catch (error) {
  evidence.failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  core?.close();
  for (const value of backends) {
    value.closing = true;
    for (const project of value.projects.values()) clearTimeout(project.reconciliation?.timer);
  }
  try {
    if (a.generation) {
      const stopped = await a.request("host.stop", {
        requestId: requestId(),
        expectedGeneration: a.generation,
        strategy: "cancel",
      });
      assert.equal(stopped.state, "completed", "isolated Core/Runtime cleanup completes");
    }
  } catch (error) {
    evidence.cleanupError = error.message;
    process.exitCode = 1;
  }
  a.close();
  b.close();
  host.kill("SIGTERM");
  await writeFile(join(root, "host.log"), output);
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
}
