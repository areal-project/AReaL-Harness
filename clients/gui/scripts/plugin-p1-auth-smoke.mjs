import { makeTempDir } from "./support/temp.mjs";
// Actual Electron/Main/Core API-key acceptance. Run serially against the built candidate.
// Planned failures, recorded before fixture/driver implementation:
// - install/configure/enable unexpectedly starts MCP or inference;
// - GUI save bypasses encrypted Main storage or Core restart/private launch inputs;
// - stale digest or connected configuration edits mutate credentials/configuration;
// - public RPC, snapshots, journals, logs or caches contain the test credential;
// - explicit enable + trust/connect fails to send the declared bearer to the local server.
// No Main/Core/auth mocking, real credentials, external vendor calls or native launch in syntax checks.
import assert from "node:assert/strict";
import { assertApplicationStopped } from "./application-cleanup.mjs";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { captureSmokeFailure, createProjectConversation } from "./smoke-navigation.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const scratch = await makeTempDir("areal-plugin-auth-gui-");
const workspace = join(scratch, "workspace"),
  userHome = join(scratch, "user");
const pluginId = "auth-fixture@gui-auth";
const privacyUrl = "https://example.com/plugin-auth-fixture/privacy";
let serverId;
// Only memory and the transient password input see this value before real Main encryption.
const sentinel = "AREAL_AUTH_FIXTURE_" + randomUUID();
const redacted = (value) => String(value).split(sentinel).join("[TEST_CREDENTIAL_REDACTED]");
const noSecret = (value, label) =>
  assert(!JSON.stringify(value).includes(sentinel), label + " leaked credential");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pause = () => new Promise((r) => setTimeout(r, 100));
const wire = [],
  checks = [],
  errors = [];
let modelRequests = 0,
  app,
  page,
  failure,
  passed = false,
  projectId,
  restart,
  encryption;

await mkdir(join(workspace, ".agents", "plugins"), { recursive: true });
await mkdir(join(userHome, ".areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const fixture = createServer(async (req, res) => {
  try {
    if (req.url !== "/mcp") {
      modelRequests++;
      res.writeHead(404);
      res.end();
      return;
    }
    // Retain only boolean wire evidence, never request headers or secret-bearing bytes.
    const authorized = req.headers.authorization === "Bearer " + sentinel;
    const secretOnlyInAuthorization = !Object.entries(req.headers).some(
      ([key, value]) => key !== "authorization" && String(value).includes(sentinel),
    );
    if (req.method !== "POST") {
      wire.push({ verb: req.method, authorized, secretOnlyInAuthorization });
      res.writeHead(req.method === "DELETE" ? 200 : 405);
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const q = JSON.parse(body);
    wire.push({
      verb: "POST",
      method: q.method,
      authorized,
      secretOnlyInAuthorization,
      secretInBody: body.includes(sentinel),
    });
    if (!authorized) {
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="local-fixture"' });
      res.end();
      return;
    }
    if (q.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result;
    switch (q.method) {
      case "initialize":
        result = {
          protocolVersion: q.params.protocolVersion,
          serverInfo: { name: "api-key-acceptance", version: "1" },
          capabilities: { tools: {} },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = {
          tools: [
            {
              name: "fixture.authenticated",
              description: "Authenticated local fixture",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        };
        break;
      case "resources/list":
        result = { resources: [] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      case "prompts/list":
        result = { prompts: [] };
        break;
      default:
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: q.id,
            error: { code: -32601, message: "Unsupported fixture method" },
          }),
        );
        return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result }));
  } catch {
    errors.push("local HTTP fixture request failed");
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
fixture.unref();
const endpoint = "http://127.0.0.1:" + fixture.address().port;
const source = join(workspace, "packages", "auth-fixture");
await mkdir(join(source, "skills", "review"), { recursive: true });
await writeFile(
  join(source, "skills", "review", "SKILL.md"),
  "---\nname: review\ndescription: Review a local fixture.\n---\nMIXED_PLUGIN_SKILL_BODY\n",
);
await writeFile(
  join(source, "plugin.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "auth-fixture",
    version: "1.0.0",
    description: "Local API-key acceptance fixture",
    extensions: {
      "com.openai": {
        interface: {
          displayName: "API-key acceptance",
          privacyPolicyUrl: privacyUrl,
          termsOfServiceUrl: "https://example.com/plugin-auth-fixture/terms",
        },
      },
    },
  }),
);
await writeFile(
  join(source, "mcp.json"),
  JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      fixture: {
        type: "streamable-http",
        url: endpoint + "/mcp",
        extensions: { "com.openai": { auth: { type: "api_key", headerScheme: "bearer" } } },
      },
    },
  }),
);
await writeFile(
  join(workspace, ".agents", "plugins", "marketplace.json"),
  JSON.stringify({
    name: "gui-auth",
    plugins: [
      {
        name: "auth-fixture",
        source: { source: "local", path: "./packages/auth-fixture" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  }),
);
await writeFile(
  join(userHome, ".areal", "config.toml"),
  'schema_version=1\n[model]\nname="fixture"\n[model.providers.default]\nprotocol="chat-completions"\nendpoint="' +
    endpoint +
    '/model"\n',
);
const env = {
  ...process.env,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: userHome,
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
  AREAL_CORE_BIN: process.env.AREAL_CORE_BIN ?? resolve(gui, "../../target/debug/areal"),
};
for (const key of Object.keys(env)) {
  if (
    /^AREAL_CREDENTIAL_|^AREAL_PLUGIN_CONNECTOR_/.test(key) ||
    [
      "AREAL_CORE_WORKSPACE",
      "AREAL_CORE_CONFIG",
      "AREAL_HARNESS_HOME",
      "AREAL_HARNESS_CONFIG",
      "AREAL_CORE_DESKTOP_CONFIG",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
    ].includes(key)
  )
    delete env[key];
}
const coreBinary = env.AREAL_CORE_BIN,
  coreSha256 = sha256(await readFile(coreBinary));
const sourceFiles = {};
for (const path of new Set(
  execFileSync("git", ["ls-files", "--modified", "--others", "--exclude-standard", "-z"], {
    cwd: sourceRoot,
  })
    .toString()
    .split("\0")
    .filter(Boolean),
)) {
  if (!/^(core\/|clients\/|scripts\/|schemas\/|Cargo\.|upstream\/)/.test(path)) continue;
  try {
    sourceFiles[path] = sha256(await readFile(join(sourceRoot, path)));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    sourceFiles[path] = "deleted";
  }
}
const sourceDiffSha256 = sha256(
  execFileSync("git", ["diff", "--binary", "HEAD"], { cwd: sourceRoot }),
);
async function files(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const result = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result; // Never follow symlinks out of the isolated data roots.
}
async function poll(read, predicate, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await pause();
  }
  throw Error("timeout: " + label);
}
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const button = (name) => page.getByRole("button", { name, exact: true });
async function raw(operation, extra = {}) {
  const result = await page.evaluate((params) => window.arealDesktop.command("manage", params), {
    projectId,
    operation,
    ...extra,
  });
  noSecret(result, "public management response");
  return result;
}
async function call(operation, extra = {}) {
  const result = await raw(operation, extra);
  assert(result.ok, redacted(JSON.stringify(result)));
  return result.value;
}
async function coreIdentity() {
  const found = [];
  for (const path of await files(join(scratch, "registry"))) {
    if (!path.endsWith("/service.json")) continue;
    let value;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (
      value.workspace === workspace &&
      value.dataDir === join(scratch, "core", projectId, "state") &&
      value.state === "ready"
    )
      found.push(value);
  }
  assert.equal(found.length, 1, "one ready isolated Rust Core descriptor");
  const { serviceId, generation, corePid } = found[0];
  assert(serviceId && generation && Number.isInteger(corePid));
  return { serviceId, generation, corePid };
}
const vaultPath = join(scratch, "core", "provider-credentials.json");
const mappingPath = () =>
  join(scratch, "core", projectId, "state", "desktop", "plugin-auth-configurations.json");
async function mapping() {
  try {
    return JSON.parse(await readFile(mappingPath(), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}
async function openAuth() {
  const summary = page.locator("summary").filter({ hasText: /认证配置/ });
  if (!(await summary.evaluate((el) => el.parentElement.open))) await summary.click();
  return page.getByLabel("API 凭据", { exact: true });
}
async function publicBoundary() {
  noSecret(await state(), "public desktop snapshot");
  for (const operation of ["plugins", "pluginMcp", "mcpApps"]) await call(operation);
  await call("plugin", { id: pluginId });
}
const { builtinSkill, BUILTIN_SKILL_ID } = require("../app/src/core/builtin-skills.cjs");
// Provision verified product bytes once; this runner tests plugins, not concurrent first-run cache creation.
await builtinSkill(join(scratch, "core"), BUILTIN_SKILL_ID);
try {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120_000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (e) => errors.push(redacted(e.message)));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120_000 });
  await poll(state, (s) => s.connection?.state === "ready", "desktop ready");
  // Only the OS folder chooser is automated. Credential storage, IPC and Core stay real.
  await app.evaluate(({ dialog, BrowserWindow }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    dialog.showMessageBox = async () => ({ response: 1 });
    BrowserWindow.getAllWindows()[0].setSize(1440, 960);
  }, workspace);
  await page.evaluate(() => window.arealDesktop.chooseProject());
  await createProjectConversation(page, "workspace");
  const ready = await poll(
    state,
    (s) => s.projects.find((p) => p.root === workspace)?.state?.connected,
    "project connected",
  );
  const project = ready.projects.find((p) => p.root === workspace);
  projectId = project.id;
  const selectedProfile = project.profiles.find(
    (profile) =>
      profile.id === project.defaultProfile?.id &&
      profile.revision === project.defaultProfile?.revision,
  );
  assert(selectedProfile, "the current project has its configured default Profile");
  const agentProfile = { id: selectedProfile.id, revision: selectedProfile.revision };
  if (await button("返回应用").isVisible()) await button("返回应用").click();
  await page.getByTestId("chat-input").waitFor();
  await page
    .getByRole("navigation", { name: "应用导航", exact: true })
    .getByRole("button", { name: "插件", exact: true })
    .click();
  await page
    .getByRole("tablist", { name: "市场范围", exact: true })
    .getByRole("tab", { name: "个人", exact: true })
    .click();
  await button("查看插件 " + pluginId).click();
  const detailUrl = page.url(),
    windowCount = (await app.windows()).length;
  await button("复制隐私政策链接").click();
  await page.getByText("已复制隐私政策链接。", { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    privacyUrl,
    "legal link copy writes the declared URL to the actual desktop clipboard",
  );
  assert.equal(page.url(), detailUrl);
  assert.equal((await app.windows()).length, windowCount);
  checks.push(
    "plugin legal URL copies through desktop clipboard without navigation or new windows",
  );
  await button("安装").click();
  assert.equal(
    await page
      .getByRole("checkbox", { name: "我已核对以上来源、版本和内容摘要", exact: true })
      .count(),
    0,
  );
  assert.equal(await button("安装到用户").isEnabled(), true);
  await button("安装到用户").click();
  await button("卸载插件").waitFor();
  const connections = page.getByRole("region", { name: "插件连接状态", exact: true });
  const authService = connections
    .locator(".plugin-service-row")
    .filter({ hasText: "API-key acceptance MCP" });
  await authService.getByText("需要认证", { exact: true }).waitFor();
  await authService.getByRole("button", { name: "启用认证", exact: true }).waitFor();
  const detail = await call("plugin", { id: pluginId });
  // The management read returns the plugin itself, unlike list responses' data array.
  const digest = detail.installedDigest;
  assert.equal(typeof digest, "string");
  assert(digest.length > 0);
  const rows = await call("pluginMcp");
  const row = rows.data.find((r) => r.pluginId === pluginId);
  assert.equal(row?.servers.length, 1);
  serverId = row.servers[0].serverId;
  assert.equal(typeof serverId, "string");
  assert(row.servers[0].config?.authenticationRequirements?.apiKey);
  assert.equal(wire.length, 0);
  assert.equal(modelRequests, 0);
  checks.push(
    "GUI preview and digest confirmation install portable API-key package without transport or inference",
  );

  const reviewSkill = detail.installedSkills.find((skill) => skill.name === "review");
  assert(reviewSkill, "the mixed package exposes its installed Skill identity");
  const skillReference = { id: reviewSkill.id, revision: reviewSkill.revision };
  const skillCatalog = () => call("skills", { agentProfile });
  const skillRead = () =>
    call("skill", {
      agentProfile,
      skill: skillReference,
      resource: "SKILL.md",
      offset: 0,
      maxBytes: 8192,
    });
  assert.equal(row.servers[0].state, "authRequired");
  assert(
    (await skillCatalog()).data.some(
      (skill) =>
        skill.available && skill.id === reviewSkill.id && skill.revision === reviewSkill.revision,
    ),
    "a permitted mixed-package Skill remains available while MCP requires authentication",
  );
  assert.match(
    Buffer.from((await skillRead()).dataBase64, "base64").toString("utf8"),
    /MIXED_PLUGIN_SKILL_BODY/,
  );
  const skillSwitch = () =>
    page.getByRole("switch", { name: "在当前项目启用 Skill review", exact: true });
  await skillSwitch().click();
  await poll(
    () => call("plugin", { id: pluginId }),
    (value) => value.componentChoices.disabledSkills.includes(reviewSkill.id),
    "mixed package Skill choice reaches Core",
  );
  await poll(
    () => skillSwitch().isEnabled(),
    (value) => value,
    "Skill disable operation settled in the GUI",
  );
  assert(
    !(await skillCatalog()).data.some((skill) => skill.id === reviewSkill.id),
    "the current project Skill choice removes actual Core discovery",
  );
  const disabledRead = await raw("skill", {
    agentProfile,
    skill: skillReference,
    resource: "SKILL.md",
    offset: 0,
    maxBytes: 8192,
  });
  assert.equal(
    disabledRead.ok,
    false,
    "the disabled mixed-package Skill denies its retained reference",
  );
  await skillSwitch().click();
  await poll(
    () => call("plugin", { id: pluginId }),
    (value) => !value.componentChoices.disabledSkills.includes(reviewSkill.id),
    "mixed package Skill choice restored in Core",
  );
  await poll(
    () => skillSwitch().isEnabled(),
    (value) => value,
    "Skill enable operation settled in the GUI",
  );
  assert(
    (await skillCatalog()).data.some(
      (skill) =>
        skill.available && skill.id === reviewSkill.id && skill.revision === reviewSkill.revision,
    ),
  );
  assert.match(
    Buffer.from((await skillRead()).dataBase64, "base64").toString("utf8"),
    /MIXED_PLUGIN_SKILL_BODY/,
  );
  const pendingMcp = (await call("pluginMcp")).data.find((plugin) => plugin.pluginId === pluginId);
  assert.equal(
    pendingMcp.servers[0].state,
    "authRequired",
    "Skill changes do not authenticate or connect MCP",
  );
  assert.equal(wire.length, 0);
  assert.equal(modelRequests, 0);
  checks.push(
    "mixed package Skill reads and project switches reach Core independently while MCP authentication remains pending",
  );

  const before = await coreIdentity();
  await (await openAuth()).fill(sentinel);
  await button("保存认证配置").click();
  const saved = await poll(
    mapping,
    (values) =>
      Object.values(values).some(
        (v) =>
          v.plugin === pluginId &&
          v.server === serverId &&
          v.digest === digest &&
          v.references?.apiKeyRef,
      ),
    "Core references-only configuration saved",
    90_000,
  );
  const configured = Object.values(saved).find(
    (v) => v.plugin === pluginId && v.server === serverId,
  );
  // Stored Rust options include nulls; desktop requests use only populated references.
  const references = Object.fromEntries(
    Object.entries(configured.references).filter(([, value]) => value !== null),
  );
  noSecret(saved, "Core configuration");
  const after = await coreIdentity();
  assert.notEqual(after.generation, before.generation, "credential save must restart actual Core");
  assert.notEqual(
    after.corePid,
    before.corePid,
    "credential save must replace actual Core process",
  );
  restart = { before, after };
  assert.equal(await (await openAuth()).inputValue(), "", "GUI transient secret cleared");
  const vaultBytes = await readFile(vaultPath),
    vault = JSON.parse(vaultBytes);
  const key = "AREAL_CREDENTIAL_" + configured.references.apiKeyRef;
  assert.equal(Object.keys(vault.keys).length, 1, "isolated vault has only the fixture credential");
  const ciphertext = vault.keys[key];
  assert.equal(typeof ciphertext, "string");
  assert(
    !vaultBytes.includes(sentinel) && !Buffer.from(ciphertext, "base64").includes(sentinel),
    "vault must not save plaintext",
  );
  encryption = await app.evaluate(
    ({ safeStorage }, { ciphertext, expected }) => ({
      available: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.getSelectedStorageBackend?.() ?? "platform",
      decryptedMatches: safeStorage.decryptString(Buffer.from(ciphertext, "base64")) === expected,
    }),
    { ciphertext, expected: sentinel },
  );
  assert(
    encryption.available && encryption.backend !== "basic_text" && encryption.decryptedMatches,
    "real platform encryption round trip",
  );
  await publicBoundary();
  assert.equal(wire.length, 0);
  assert.equal(modelRequests, 0);
  checks.push(
    "GUI save uses platform-encrypted Main vault; Core restarts and persists bound references only; GUI input clears",
  );

  const vaultHash = sha256(vaultBytes),
    mappingHash = sha256(await readFile(mappingPath()));
  const stale = {
    id: pluginId,
    server: serverId,
    expectedDigest: "0".repeat(64),
    configuration: references,
    requestId: randomUUID(),
  };
  const mainStale = await raw("pluginAuthCredential", { ...stale, credentials: {} });
  assert.equal(mainStale.ok, false, "Main rejects stale digest");
  assert.match(JSON.stringify(mainStale), /已安装摘要已变化/);
  const coreStale = await raw("pluginAuthConfigure", { ...stale, requestId: randomUUID() });
  assert.equal(coreStale.ok, false, "Core rejects stale digest");
  assert.match(JSON.stringify(coreStale), /target turn is stale/);
  assert.equal(sha256(await readFile(vaultPath)), vaultHash);
  assert.equal(sha256(await readFile(mappingPath())), mappingHash);
  checks.push("Main and Core reject stale digest without changing isolated vault or configuration");

  await button("启用认证").click();
  await poll(
    () => call("pluginAuth", { id: pluginId, server: serverId, authOperation: "status" }),
    (s) => s?.status === "ready",
    "explicit GUI enable reaches ready",
  );
  assert.equal(wire.length, 0, "API-key enable does not start MCP");
  await button("审阅并连接").click();
  assert.equal(await page.locator(".plugin-trust-review").getByRole("checkbox").count(), 0);
  assert.equal(await button("信任并连接").isEnabled(), true);
  await button("信任并连接").click();
  await poll(
    () => call("mcpApps"),
    (v) =>
      v.data.some(
        (s) => s.pluginId === pluginId && s.tools.some((t) => t.name === "fixture.authenticated"),
      ),
    "authenticated discovery",
  );
  assert.equal(
    wire.filter((e) => e.method === "initialize").length,
    1,
    "single initialize, no automatic authentication replay",
  );
  assert(wire.some((e) => e.method === "tools/list"));
  assert(wire.every((e) => e.authorized && e.secretOnlyInAuthorization && !e.secretInBody));
  checks.push(
    "GUI explicit enable then trust/connect sends declared bearer to actual local HTTP MCP initialize and tool discovery",
  );

  const connectedIdentity = await coreIdentity();
  assert.equal(
    await button("保存认证配置").count(),
    0,
    "connected view does not offer credential mutation",
  );
  const mainConnected = await raw("pluginAuthCredential", {
    id: pluginId,
    server: serverId,
    expectedDigest: digest,
    credentials: { apiKey: sentinel },
    configuration: {},
    requestId: randomUUID(),
  });
  assert.equal(mainConnected.ok, false, "Main independently rejects connected credential mutation");
  assert.match(JSON.stringify(mainConnected), /请先断开插件/);
  const coreConnected = await raw("pluginAuthConfigure", {
    id: pluginId,
    server: serverId,
    expectedDigest: digest,
    configuration: references,
    requestId: randomUUID(),
  });
  assert.equal(coreConnected.ok, false, "Core independently rejects connected configuration");
  assert.match(
    JSON.stringify(coreConnected),
    /disconnect plugin before changing authentication configuration/,
  );
  assert.equal(sha256(await readFile(vaultPath)), vaultHash);
  assert.equal(sha256(await readFile(mappingPath())), mappingHash);
  assert.deepEqual(
    await coreIdentity(),
    connectedIdentity,
    "rejected connected save must not restart Core",
  );
  await publicBoundary();
  assert.equal(modelRequests, 0);
  checks.push(
    "GUI/Main and Core connected guards reject configuration changes without vault write, mapping write or Core restart",
  );
  await page.screenshot({
    path: join(scratch, "native-api-key-connected.png"),
    animations: "disabled",
  });
  await button("断开并撤销信任").click();
  await poll(
    () => call("mcpApps"),
    (v) => !v.data.some((s) => s.pluginId === pluginId),
    "disconnect removes authenticated server",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (e) {
  failure = { message: redacted(e.message), stack: redacted(e.stack) };
  process.exitCode = 1;
  if (page)
    await captureSmokeFailure(page, scratch, new Error(failure.message)).catch((e) =>
      errors.push("failure capture: " + redacted(e.message)),
    );
} finally {
  if (app) {
    const metadata = await readFile(join(scratch, "core", "service.json"), "utf8")
      .then(JSON.parse)
      .catch((e) => {
        if (e.code !== "ENOENT") errors.push("read cleanup identity: " + redacted(e.message));
        return null;
      });
    await app.close().catch((e) => errors.push("close GUI: " + redacted(e.message)));
    await assertApplicationStopped(coreBinary, env, metadata).catch((e) =>
      errors.push("verify application cleanup: " + redacted(e.message)),
    );
  }
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  let scannedFiles = 0;
  // Inspect only this script's scratch roots after shutdown, including journals/cache/logs/vault.
  for (const root of ["core", "electron", "user", "registry"]) {
    for (const path of await files(join(scratch, root))) {
      try {
        const bytes = await readFile(path);
        scannedFiles++;
        if (bytes.includes(sentinel))
          errors.push("credential leak in isolated file: " + relative(scratch, path));
      } catch (e) {
        if (e.code !== "ENOENT") errors.push("scan failed: " + relative(scratch, path));
      }
    }
  }
  if (passed && !errors.length)
    checks.push(
      "post-shutdown isolated journals, logs, public caches and vault contain no plaintext test credential",
    );
  const unchanged = sha256(await readFile(coreBinary)) === coreSha256;
  if (!unchanged) errors.push("Core binary changed during acceptance");
  if (errors.length) {
    passed = false;
    process.exitCode = 1;
  }
  const manifest = {
    passed,
    checks,
    errors,
    failure,
    scratch,
    source: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
    }).trim(),
    sourceFiles,
    sourceDiffSha256,
    core: { binary: coreBinary, sha256: coreSha256, unchanged },
    restart,
    encryption,
    scannedFiles,
    modelRequests,
    wire,
    scope:
      "source Electron/Main/Core GUI API-key bearer authentication with self-owned loopback HTTP MCP",
    gaps: [
      "no OAuth/mixed browser journey or real provider acceptance",
      "no basic/custom-header native acceptance",
      "no signed package or remote CI acceptance",
    ],
  };
  noSecret(manifest, "evidence manifest");
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}
