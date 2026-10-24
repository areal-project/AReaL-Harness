// Pinned Codex management contract checks against actual authenticated Core.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, access } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { CoreClient } from "../clients/gui/packages/runtime-client/core.js";
const require = createRequire(new URL("../clients/gui/app/package.json", import.meta.url)),
  WebSocket = require("ws"),
  exec = promisify(execFile);
const scratch = await mkdtemp("/private/tmp/areal-plugin-wire-"),
  workspace = join(scratch, "workspace"),
  bin = resolve(process.env.AREAL_TEST_BIN_DIR ?? "target/debug", "areal");
const env = {
  ...process.env,
  AREAL_HARNESS_HOME: join(scratch, "home"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  OTEL_SDK_DISABLED: "true",
};
let service,
  passed = false,
  failure;
const clients = [],
  checks = [];
async function cli(args) {
  return JSON.parse((await exec(bin, args, { env, timeout: 60000 })).stdout);
}
async function connect(experimental) {
  const auth = JSON.parse(await readFile(service.authFile, "utf8"));
  const c = new CoreClient({
    createSocket: () =>
      new WebSocket(service.endpoint, {
        headers: { Authorization: "Bearer " + auth.principals[0].token },
      }),
  });
  // Keep production initialization and add only the pinned experimental capability.
  const request = c.request.bind(c);
  c.request = (method, params, options) =>
    request(
      method,
      method === "initialize"
        ? { ...params, capabilities: { ...params.capabilities, experimentalApi: experimental } }
        : params,
      options,
    );
  await c.connect();
  clients.push(c);
  return c;
}
try {
  await mkdir(join(workspace, ".agents/plugins"), { recursive: true });
  await mkdir(join(workspace, "pkg/skills/example"), { recursive: true });
  await writeFile(
    join(workspace, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: "wire",
      plugins: [{ name: "sample", source: "./pkg", policy: { authentication: "ON_USE" } }],
    }),
  );
  await writeFile(join(workspace, "pkg/.placeholder"), "");
  await writeFile(
    join(workspace, "pkg/plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "sample",
      version: "1.0.0",
      description: "wire fixture",
      extensions: {
        "com.openai": {
          commands: { review: { command: "PRIVATE_COMMAND_VALUE" } },
          agents: { reviewer: { prompt: "PRIVATE_AGENT_VALUE" } },
          ui: { surfaces: { panel: { token: "PRIVATE_UI_VALUE" } } },
        },
      },
    }),
  );
  await writeFile(
    join(workspace, "pkg/skills/example/SKILL.md"),
    "---\nname: example\ndescription: Example skill\n---\nbody",
  );
  await mkdir(join(workspace, "pkg/hooks"), { recursive: true });
  const sentinel = join(scratch, "package-executed");
  await writeFile(
    join(workspace, "pkg/mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        sentinel: { type: "stdio", command: "sh", args: ["-c", `touch '${sentinel}'`] },
      },
    }),
  );
  await writeFile(
    join(workspace, "pkg/hooks/hooks.json"),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: `touch '${sentinel}'` }] }] },
    }),
  );
  service = await cli(["service", "ensure", "--json", "--workspace", workspace]);
  const c = await connect(false);
  const list = await c.request("plugin/list", { cwds: [workspace] });
  assert.equal(list.marketplaces[0].name, "wire");
  assert.equal(list.marketplaces[0].plugins[0].source.type, "local");
  const detail = await c.request("plugin/read", {
    marketplacePath: list.marketplaces[0].path,
    pluginName: "sample",
  });
  assert.equal(detail.plugin.summary.id, "sample@wire");
  assert.equal(detail.plugin.skills[0].name, "example");
  checks.push("pinned list/read response shapes");
  await assert.rejects(
    c.request("plugin/search", { searchTerm: "sample" }),
    (e) => e.code === -32600,
  );
  const experimental = await connect(true);
  const search = await experimental.request("plugin/search", {
    searchTerm: "sample",
    cwds: [workspace],
    limit: 1,
  });
  assert.equal(search.data[0].plugin.id, "sample@wire");
  checks.push("only search requires experimental opt-in");
  const installed = await c.request("plugin/install", {
    marketplacePath: list.marketplaces[0].path,
    pluginName: "sample",
    installAttemptId: randomUUID(),
  });
  assert.equal(installed.authPolicy, "ON_USE");
  assert.deepEqual(installed.appsNeedingAuth, []);
  assert(
    (await c.request("plugin/installed", { cwds: [workspace] })).marketplaces[0].plugins[0]
      .installed,
  );
  checks.push("wire install shares Core state");
  const report = await c.request("areal/plugin/read", { id: "sample@wire" });
  assert.equal(report.componentSupport.digest, report.admissionDigest ?? report.sourceDigest);
  assert.equal(report.installedComponentSupport.digest, report.installedDigest);
  assert.deepEqual(
    (await cli(["plugin", "--workspace", workspace, "read", "sample@wire"]))
      .installedComponentSupport,
    report.installedComponentSupport,
  );
  assert.deepEqual(
    report.installedComponentSupport.components
      .filter((row) => ["commands", "agents", "uiSurfaces"].includes(row.kind))
      .map((row) => [row.kind, row.status]),
    [
      ["commands", "unsupported"],
      ["agents", "unsupported"],
      ["uiSurfaces", "unsupported"],
    ],
  );
  for (const value of ["PRIVATE_COMMAND_VALUE", "PRIVATE_AGENT_VALUE", "PRIVATE_UI_VALUE"])
    assert(!JSON.stringify(report.installedComponentSupport).includes(value));
  const mcp = await c.request("areal/plugin/mcp/list", {}),
    hooks = await c.request("areal/plugin/hooks/list", {});
  assert.equal(mcp.data[0].installedDigest, report.installedDigest);
  assert.equal(mcp.data[0].trusted, false);
  assert.equal(hooks.data[0].installedDigest, report.installedDigest);
  assert.equal(hooks.data[0].definitions[0].trusted, false);
  await assert.rejects(access(sentinel), (error) => error.code === "ENOENT");
  const disabled = await c.request("areal/plugin/configure", {
    id: "sample@wire",
    scope: "project",
    enabled: false,
    expectedRevision: report.revision,
    requestId: randomUUID(),
  });
  assert.equal((await c.request("areal/plugin/read", { id: "sample@wire" })).enabled, false);
  await assert.rejects(access(sentinel), (error) => error.code === "ENOENT");
  await c.request("areal/plugin/configure", {
    id: "sample@wire",
    scope: "project",
    enabled: true,
    expectedRevision: disabled.revision,
    requestId: randomUUID(),
  });
  assert.equal(
    (
      await c.request("plugin/read", {
        marketplacePath: list.marketplaces[0].path,
        pluginName: "sample",
      })
    ).componentSupport,
    undefined,
  );
  checks.push(
    "AReaL exact reports match CLI; reading untrusted MCP/hooks and disabled reports causes zero package execution; pinned wire stays unchanged",
  );
  const first = await c.request("plugin/reconcile", {});
  assert(first.changedPlugins.some((x) => x.id === "sample@wire" && x.hasSkills));
  assert.deepEqual((await c.request("plugin/reconcile", {})).changedPlugins, []);
  checks.push("reconcile is per-pass package diff");
  await c.request("plugin/uninstall", { pluginId: "sample@wire" });
  assert(
    (await c.request("plugin/reconcile", {})).changedPlugins.some(
      (x) => x.id === "sample@wire" && x.hasSkills,
    ),
  );
  checks.push("wire uninstall and removal flags");
  // Actual published sparsePaths wire exercises the Store boundary, not a DTO-only substitute.
  const gitRoot = join(scratch, "sparse-source");
  await mkdir(join(gitRoot, ".agents/plugins"), { recursive: true });
  await mkdir(join(gitRoot, "packages/sample"), { recursive: true });
  await mkdir(join(gitRoot, "excluded"), { recursive: true });
  await writeFile(
    join(gitRoot, ".agents/plugins/marketplace.json"),
    JSON.stringify({
      name: "sparse-wire",
      plugins: [{ name: "sample", source: "./packages/sample" }],
    }),
  );
  await writeFile(
    join(gitRoot, "packages/sample/plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "sample",
      version: "1.0.0",
    }),
  );
  await writeFile(join(gitRoot, "excluded/private.txt"), "UNSELECTED_CONTENT");
  await exec("git", ["init", "-b", "main", gitRoot]);
  await exec("git", ["-C", gitRoot, "add", "."]);
  await exec("git", [
    "-C",
    gitRoot,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  await exec("git", ["-C", gitRoot, "config", "uploadpack.allowFilter", "true"]);
  const sparse = await c.request("marketplace/add", {
    source: pathToFileURL(gitRoot).href,
    sparsePaths: [".agents/plugins", "packages/sample"],
  });
  assert.equal(sparse.marketplaceName, "sparse-wire");
  assert(
    (await readFile(join(sparse.installedRoot, "packages/sample/plugin.json"), "utf8")).includes(
      "sample",
    ),
  );
  await assert.rejects(
    readFile(join(sparse.installedRoot, "excluded/private.txt")),
    (e) => e.code === "ENOENT",
  );
  await assert.rejects(
    c.request("marketplace/add", { source: workspace, sparsePaths: ["pkg"] }),
    (e) => e.code === -32602,
  );
  await assert.rejects(
    c.request("marketplace/add", { source: pathToFileURL(gitRoot).href, sparsePaths: [7] }),
    (e) => e.code === -32602,
  );
  checks.push(
    "actual top-level sparsePaths wire produces selected immutable Git snapshot and rejects invalid/local sparse requests",
  );
  await assert.rejects(
    c.request("plugin/share/list", {}),
    (e) => e.data?.capability === "codexRemotePluginService",
  );
  checks.push("unavailable hosted service remains explicit error");
  passed = true;
} catch (e) {
  failure = { message: e.message, stack: e.stack };
  process.exitCode = 1;
} finally {
  for (const c of clients) c.close();
  if (service)
    await cli(["service", "stop", "--json", "--instance", service.serviceId]).catch(() => {});
  const manifest = {
    passed,
    scratch,
    checks,
    failure,
    scope: "actual Core pinned plugin management wire; no private catalog/sharing substitute",
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
