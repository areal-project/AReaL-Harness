// 真实 Core + CLI 验收：阻止隐式远程解析/连接，绑定安装摘要，并取证收据去重和丢包恢复。
// 从仓库根运行；AREAL_TEST_BIN_DIR 指向同次构建。仅使用本地 Git 和无凭据 fixture。
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath, access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CoreClient } from "../clients/gui/packages/runtime-client/core.js";
const require = createRequire(new URL("../clients/gui/app/package.json", import.meta.url));
const WebSocket = require("ws"),
  exec = promisify(execFile);
const scratch = await realpath(await mkdtemp("/private/tmp/areal-plugin-cli-p1-"));
const workspace = join(scratch, "workspace"),
  packageRepo = join(scratch, "package-repo");
const marketplaceRepo = join(scratch, "marketplace-repo"),
  signal = join(scratch, "PACKAGE_EXECUTED");
const config = join(scratch, "config.toml"),
  bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(AREAL_|OTEL_|OPENAI_|ANTHROPIC_|GITHUB_|GH_TOKEN$)/.test(key),
    ),
  ),
  AREAL_HARNESS_HOME: join(scratch, "config-home"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
const checks = [],
  id = "sample@cli-p1";
let service,
  client,
  passed = false,
  failure;
const evidence = {
  binary: bin,
  binarySha256: createHash("sha256")
    .update(await readFile(bin))
    .digest("hex"),
  sourceHead: (await exec("git", ["rev-parse", "HEAD"])).stdout.trim(),
  sourceFiles: Object.fromEntries(
    await Promise.all(
      ["clients/cli/src/plugins.rs", "scripts/plugin-cli-p1-smoke.mjs"].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  ),
};
async function cli(args) {
  return JSON.parse(
    (await exec(bin, args, { env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024 })).stdout,
  );
}
const plugin = (...args) => cli(["plugin", "--workspace", workspace, "--json", ...args]);
async function failed(args, pattern) {
  return exec(bin, ["plugin", "--workspace", workspace, ...args], { env, timeout: 30_000 }).then(
    () => assert.fail(`unexpected CLI success: ${args[0]}`),
    (error) => {
      assert.match(error.stderr || error.message, pattern);
      return error;
    },
  );
}
async function git(repo, ...args) {
  return (
    await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=CLI Fixture",
        "-c",
        "user.email=fixture@invalid",
        ...args,
      ],
      {
        cwd: repo,
        env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        timeout: 30_000,
      },
    )
  ).stdout.trim();
}
async function commit(repo, message) {
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}
async function noExecution() {
  await assert.rejects(access(signal), (error) => error.code === "ENOENT");
}
async function catalog(pin) {
  await writeFile(
    join(marketplaceRepo, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: "cli-p1",
      plugins: [
        {
          name: "sample",
          source: { source: "git-subdir", url: packageRepo, path: "pkg", sha: pin },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        },
      ],
    }),
  );
}
async function connectCore() {
  const auth = JSON.parse(await readFile(service.authFile, "utf8"));
  let ignoredReplyId;
  const c = new CoreClient({
    createSocket: () => {
      const socket = new WebSocket(service.endpoint, {
        headers: { Authorization: "Bearer " + auth.principals[0].token },
      });
      const add = socket.addEventListener.bind(socket);
      socket.addEventListener = (name, listener, options) =>
        add(
          name,
          name === "message"
            ? (event) => {
                const reply = JSON.parse(event.data.toString());
                if (reply.id === ignoredReplyId) {
                  ignoredReplyId = undefined;
                  return;
                }
                listener(event);
              }
            : listener,
          options,
        );
      return socket;
    },
    timeoutMs: 30_000,
  });
  c.dropNextReply = () => {
    ignoredReplyId = c.nextId + 1;
  };
  await c.connect();
  return c;
}
try {
  await mkdir(workspace, { recursive: true });
  await mkdir(join(packageRepo, "pkg"), { recursive: true });
  await mkdir(join(marketplaceRepo, ".agents/plugins"), { recursive: true });
  await writeFile(
    config,
    'schema_version=1\n[model]\nname="unused-fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1"\n',
  );
  await writeFile(
    join(packageRepo, "pkg/plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "sample",
      version: "1.0.0",
    }),
  );
  await writeFile(
    join(packageRepo, "pkg/mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        fixture: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/server.mjs"] },
      },
    }),
  );
  await writeFile(
    join(packageRepo, "pkg/server.mjs"),
    `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(signal)},'unexpected package execution');process.exit(91);`,
  );
  await writeFile(
    join(packageRepo, "pkg/.app.json"),
    JSON.stringify({ apps: [{ id: "cli-fixture-connector" }] }),
  );
  await git(packageRepo, "init", "-q");
  const pinA = await commit(packageRepo, "package A");
  await catalog(pinA);
  await git(marketplaceRepo, "init", "-q");
  const marketA = await commit(marketplaceRepo, "marketplace A");
  const branch = await git(marketplaceRepo, "branch", "--show-current");
  service = await cli([
    "service",
    "ensure",
    "--json",
    "--workspace",
    workspace,
    "--config",
    config,
  ]);
  const added = await plugin("marketplace-add-git", marketplaceRepo, "--ref-name", branch);
  assert.equal(added.marketplaces[0].resolvedCommit, marketA);
  assert.equal(added.data[0].sourceDigest, "");
  await failed(["install", id], /source is unresolved.*resolve.*read.*install/s);
  assert.equal((await plugin("list")).revision, added.revision);
  await noExecution();
  checks.push(
    "Git marketplace CLI pins the selected commit; unresolved install fails without resolution or package execution",
  );

  const resolved = await plugin("resolve", id);
  assert.equal(resolved.resolvedCommit, pinA);
  assert.match(resolved.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal((await plugin("read", id)).sourceDigest, resolved.sourceDigest);
  const installed = await plugin("install", id);
  assert.equal(installed.installedDigest, resolved.admissionDigest ?? resolved.sourceDigest);
  assert.equal(installed.installedSourceDigest, resolved.sourceDigest);
  let runtime = (await plugin("mcp-list")).data.find((row) => row.pluginId === id);
  assert.equal(runtime.installedDigest, installed.installedDigest);
  assert.equal(runtime.servers.length, 1);
  assert.equal(runtime.connectors[0].id, "cli-fixture-connector");
  await noExecution();
  checks.push(
    "resolve/read/install/MCP-list share pinned Core state without launching MCP or install hooks",
  );

  await failed(["connect", id], /--expected-digest/);
  const rejected = await failed(
    ["connect", id, "--expected-digest", "0".repeat(64)],
    /plugin request [a-f0-9-]+/,
  );
  const rejectedId = rejected.stderr.match(/plugin request ([a-f0-9-]{36})/)[1];
  const rejectionReceipt = await plugin("submission", rejectedId);
  assert(
    rejectionReceipt.data.some(
      (row) =>
        row.method === "areal/plugin/connection" && row.state === "completed" && row.response.error,
    ),
  );
  await noExecution();
  checks.push(
    "connect requires explicit reviewed digest; rejected mutation reports a recoverable receipt and launches nothing",
  );

  const server = runtime.servers[0].serverId;
  await plugin("auth", id, server, "status");
  await plugin("auth", id, server, "cancel");
  const authFailure = await failed(
    ["auth", id, server, "start"],
    /plugin authentication operation failed/,
  );
  assert.doesNotMatch(authFailure.stderr, /plugin request [a-f0-9-]{36}/);
  await failed(["auth", id, server, "invalid"], /invalid value/);
  checks.push("auth uses direct status/start/cancel and does not invent a durable request receipt");

  await writeFile(join(packageRepo, "pkg/version-b.txt"), "B");
  const pinB = await commit(packageRepo, "package B");
  await catalog(pinB);
  await commit(marketplaceRepo, "marketplace B");
  const refreshed = await plugin("marketplace-update");
  assert.equal(refreshed.marketplaces.length, 1);
  assert.equal(refreshed.data[0].sourceDigest, "");
  assert.equal(refreshed.data[0].installedDigest, installed.installedDigest);
  await plugin("disconnect", id);
  const mapping = await plugin(
    "connector-configure",
    id,
    "cli-fixture-connector",
    "--provider",
    "github",
    "--credential-ref",
    "CLI_FIXTURE_UNSET",
  );
  assert.equal(mapping.state, "mapped");
  await noExecution();
  checks.push(
    "marketplace update retains installed A; disconnect and connector mapping bind installedDigest even while candidate B is unresolved",
  );

  client = await connectCore();
  let revision = (await plugin("list")).revision;
  const update = { expectedRevision: revision, requestId: randomUUID() };
  const once = await client.request("areal/marketplace/update", update);
  assert.deepEqual(await client.request("areal/marketplace/update", update), once);
  assert.equal((await plugin("list")).revision, revision + 1);
  assert(
    (await plugin("submission", update.requestId)).data.some(
      (row) => row.method === "areal/marketplace/update" && row.state === "completed",
    ),
  );
  checks.push(
    "new marketplace mutation deduplicates identical requestId without advancing revision twice",
  );

  revision = (await plugin("list")).revision;
  const lost = { id, expectedRevision: revision, requestId: randomUUID() };
  client.dropNextReply();
  await assert.rejects(
    client.request("areal/plugin/resolve", lost, { timeoutMs: 250 }),
    (error) => error.submissionUnknown === true,
  );
  let recovered;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    recovered = (await plugin("submission", lost.requestId)).data.find(
      (row) => row.method === "areal/plugin/resolve" && row.state === "completed",
    );
    if (recovered) break;
    await delay(50);
  }
  assert(recovered);
  assert.equal(recovered.response.result.resolvedCommit, pinB);
  const afterLoss = await plugin("list");
  assert.equal(afterLoss.revision, revision + 1);
  await plugin("submission", lost.requestId);
  assert.equal((await plugin("list")).revision, afterLoss.revision);
  checks.push(
    "dropped resolve response recovers through CLI submission lookup without replaying resolution",
  );

  const removed = await plugin("marketplace-remove", afterLoss.marketplaces[0].root);
  assert.equal(removed.marketplaces.length, 0);
  assert.equal(
    removed.data.find((row) => row.id === id).installedDigest,
    installed.installedDigest,
  );
  await noExecution();
  checks.push("marketplace removal preserves the installed package and never runs package code");
  evidence.packageCommitA = pinA;
  evidence.packageCommitB = pinB;

  const largeRoot = join(scratch, "large-marketplace"),
    largeId = "large@receipt-large";
  const description = "d".repeat(300 * 1024);
  const largeCatalog = JSON.stringify({
    name: "receipt-large",
    plugins: [
      {
        name: "large",
        description,
        source: { source: "git-subdir", url: packageRepo, path: "pkg", sha: pinB },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        interface: { displayName: "Large receipt fixture", category: "Testing" },
      },
    ],
  });
  assert(Buffer.byteLength(largeCatalog) < 1024 * 1024);
  await mkdir(join(largeRoot, ".agents/plugins"), { recursive: true });
  await writeFile(join(largeRoot, ".agents/plugins/marketplace.json"), largeCatalog);
  const original = { root: largeRoot, expectedRevision: removed.revision, requestId: randomUUID() };
  let largeReply, largeError;
  try {
    largeReply = await client.request("areal/marketplace/add", original);
  } catch (error) {
    largeError = error;
  }
  const largeList = await plugin("list");
  const largeReceipt = (await plugin("submission", original.requestId)).data;
  const largeDetail = largeList.data.find((row) => row.id === largeId);
  evidence.largeCatalog = {
    request: original,
    catalogBytes: Buffer.byteLength(largeCatalog),
    listBytes: Buffer.byteLength(JSON.stringify({ result: largeList })),
    revision: largeList.revision,
    descriptionBytes: Buffer.byteLength(largeDetail?.description ?? ""),
    descriptionSha256: createHash("sha256")
      .update(largeDetail?.description ?? "")
      .digest("hex"),
    rpcError: largeError && { code: largeError.code, message: largeError.message },
    receipt: largeReceipt,
  };
  assert.equal(largeList.revision, removed.revision + 1);
  assert.deepEqual(largeList.data.map((row) => row.id).sort(), [largeId, id].sort());
  assert.equal(largeDetail.description, description);
  assert.equal(largeDetail.sourceDigest, "");
  assert.deepEqual(largeDetail.policy, { installation: "AVAILABLE", authentication: "ON_USE" });
  assert.deepEqual(largeDetail.catalogSource, {
    type: "git",
    url: packageRepo,
    path: "pkg",
    refName: null,
    sha: pinB,
  });
  assert.equal(largeDetail.interface.displayName, "Large receipt fixture");
  assert.equal(largeDetail.interface.category, "Testing");
  assert(Buffer.byteLength(JSON.stringify({ result: largeList })) > 256 * 1024);
  await noExecution();
  if (largeError) throw largeError;
  const compact = { revision: removed.revision + 1, catalogRefreshRequired: true };
  assert.deepEqual(largeReply, compact);
  assert.equal(largeReceipt.length, 1);
  assert.equal(largeReceipt[0].state, "completed");
  assert.deepEqual(largeReceipt[0].response, { result: compact });
  assert.deepEqual(await client.request("areal/marketplace/add", original), compact);
  assert.equal((await plugin("list")).revision, compact.revision);
  checks.push(
    "oversized successful catalog mutation returns one compact durable receipt and preserves full authoritative metadata",
  );

  const lostCatalog = { expectedRevision: compact.revision, requestId: randomUUID() };
  client.dropNextReply();
  await assert.rejects(
    client.request("areal/marketplace/update", lostCatalog, { timeoutMs: 250 }),
    (error) => error.submissionUnknown === true,
  );
  let recoveredCatalog;
  const catalogDeadline = Date.now() + 30_000;
  while (Date.now() < catalogDeadline) {
    recoveredCatalog = (await plugin("submission", lostCatalog.requestId)).data.find(
      (row) => row.method === "areal/marketplace/update" && row.state === "completed",
    );
    if (recoveredCatalog) break;
    await delay(50);
  }
  assert(recoveredCatalog);
  assert.deepEqual(recoveredCatalog.response, { result: compact });
  assert.equal((await plugin("list")).revision, compact.revision);
  assert.deepEqual(await client.request("areal/marketplace/add", original), compact);
  assert.equal((await plugin("list")).revision, compact.revision);
  const staleCatalog = { expectedRevision: compact.revision - 1, requestId: randomUUID() };
  await assert.rejects(
    client.request("areal/marketplace/update", staleCatalog),
    (error) => error.code === -32009,
  );
  const staleReceipt = (await plugin("submission", staleCatalog.requestId)).data;
  assert.equal(staleReceipt.length, 1);
  assert.equal(staleReceipt[0].response.error.code, -32009);
  assert.equal((await plugin("list")).revision, compact.revision);
  checks.push(
    "lost oversized no-op update reply recovers by receipt lookup without replay; local-only catalog revision stays stable and rejected CAS stays an error",
  );

  let currentRevision = compact.revision;
  for (const args of [
    ["marketplace-add", marketplaceRepo],
    ["marketplace-update"],
    ["marketplace-remove", marketplaceRepo],
  ]) {
    const output = await exec(bin, ["plugin", "--workspace", workspace, "--json", ...args], {
      env,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const current = JSON.parse(output.stdout);
    if (args[0] !== "marketplace-update") currentRevision += 1;
    assert.equal(current.revision, currentRevision);
    assert.equal(current.data.find((row) => row.id === largeId).description, description);
    assert.equal(
      current.data.find((row) => row.id === id).installedDigest,
      installed.installedDigest,
    );
    assert.equal(
      current.marketplaces.some((row) => row.root === marketplaceRepo),
      args[0] !== "marketplace-remove",
    );
    assert.match(output.stderr, /current catalog/i);
    assert.match(output.stderr, new RegExp(`receipt revision ${currentRevision}\\b`, "i"));
    const requestId = output.stderr.match(/plugin request ([a-f0-9-]{36})/i)?.[1];
    assert.match(requestId ?? "", /^[a-f0-9-]{36}$/);
    const historic = (await plugin("submission", requestId)).data;
    assert.equal(historic.length, 1);
    assert.deepEqual(historic[0].response, {
      result: { revision: currentRevision, catalogRefreshRequired: true },
    });
    assert.equal((await plugin("list")).revision, currentRevision);
  }
  assert.deepEqual(await client.request("areal/marketplace/add", original), compact);
  assert.deepEqual((await plugin("submission", original.requestId)).data[0].response, {
    result: compact,
  });
  checks.push(
    "oversized CLI add/update/remove print the full current catalog, label its receipt revision, and leave submission output historical",
  );

  const uninstall = { id, expectedRevision: currentRevision, requestId: randomUUID() };
  const uninstallReply = { revision: currentRevision + 1, catalogRefreshRequired: true };
  assert.deepEqual(await client.request("areal/plugin/uninstall", uninstall), uninstallReply);
  assert.deepEqual(await client.request("areal/plugin/uninstall", uninstall), uninstallReply);
  assert.deepEqual((await plugin("submission", uninstall.requestId)).data[0].response, {
    result: uninstallReply,
  });
  const uninstalled = await plugin("list");
  assert.equal(uninstalled.revision, currentRevision + 1);
  assert.deepEqual(
    uninstalled.data.map((row) => row.id),
    [largeId],
  );
  assert.equal(uninstalled.data[0].description, description);
  await noExecution();
  checks.push(
    "uninstall uses the same bounded catalog receipt and removes the installed sample exactly once without package execution",
  );
  passed = true;
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  client?.close();
  if (service) {
    try {
      await cli(["service", "stop", "--json", "--instance", service.serviceId]);
    } catch (error) {
      passed = false;
      process.exitCode = 1;
      failure ??= { message: `Core cleanup failed: ${error.message}` };
    }
  }
  const manifest = {
    passed,
    scratch,
    checks,
    failure,
    evidence,
    scope:
      "actual local Core/CLI management, local Git, no real vendor credentials or live SSH; no successful MCP connection",
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
