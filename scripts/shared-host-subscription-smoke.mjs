import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect as tcpConnect } from "node:net";
import { createRequire } from "node:module";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { connect } from "../examples/desktop-api/client.mjs";
import { CoreSubscription } from "../clients/gui/packages/chatgpt-provider/core.js";

assert.equal(
  process.env.AREAL_TEST_HOST_KEYCHAIN,
  "1",
  "Requires isolated synthetic vault authorization",
);
const repository = await realpath(new URL("..", import.meta.url).pathname);
const require = createRequire(join(repository, "clients/gui/app/package.json"));
const { HostClient } = require("../app/src/core/host-client.cjs");
const { GuiHostProjects } = require("../app/src/core/gui-host-projects.cjs");
const { HostVault } = require("../app/src/core/host-vault.cjs");
const { SubscriptionStore } = require("../app/src/core/subscription.cjs");
const { NativeSubscription } = require("../app/src/core/native-subscription.cjs");
const oauthRequire = createRequire(
  join(repository, "clients/gui/packages/chatgpt-provider/package.json"),
);
const { SignJWT } = await import(oauthRequire.resolve("jose"));
const root = await realpath(await mkdtemp("/tmp/ah-host-subscription-"));
const home = join(root, "host"),
  user = join(root, "user"),
  workspace = join(root, "workspace");
const binary = resolve(
  process.env.AREAL_CORE_BIN ?? join(repository, ".local/shared-host-bin/areal"),
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const evidence = {
  root,
  binary,
  binarySha256: hash(await readFile(binary)),
  scriptSha256: hash(await readFile(new URL(import.meta.url))),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  checks: [],
  commands: [],
  cleanup: [],
  excluded: ["actual Electron GUI exit", "real provider", "installed package"],
};
const host = new HostClient();
const source = new GuiHostProjects({
  binary,
  home,
  singletonHeld: true,
  source: {
    profile: join(root, "profile"),
    coreHome: join(root, "gui-core"),
    legacyServiceHome: join(root, "legacy"),
  },
  encryption: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString("utf8"),
  },
});
let hostChild,
  hostIdentity,
  native,
  legacy,
  core,
  coreTwo,
  failure,
  fixtureFailure,
  heldOriginal,
  heldEpoch,
  authNonce,
  authClient;
const requests = [],
  networkRequests = [],
  refreshes = [],
  recoverySources = [],
  sockets = new Set();
const chunk = (value) => `data: ${JSON.stringify(value)}\n\n`;
const completed = (text) =>
  chunk({ type: "response.output_text.delta", delta: text }) +
  chunk({
    type: "response.completed",
    response: {
      id: "fixture-response",
      status: "completed",
      output: [
        {
          id: "fixture-message",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  });
const tokenFor = (client) => `synthetic-access-${client}`;
const jwtKeyPath = join(root, "jwt.pem"),
  tlsKeyPath = join(root, "tls-key.pem"),
  tlsCertPath = join(root, "tls.pem"),
  caPath = join(root, "ca.pem");
for (const path of [
  home,
  user,
  workspace,
  source.source.profile,
  source.source.coreHome,
  source.source.legacyServiceHome,
])
  await mkdir(path, { recursive: true, mode: 0o700 });
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "ca-key.pem"),
    "-out",
    caPath,
    "-days",
    "2",
    "-subj",
    "/CN=AReaL subscription isolated CA",
  ],
  { stdio: "ignore" },
);
execFileSync(
  "openssl",
  [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    tlsKeyPath,
    "-out",
    join(root, "tls.csr"),
    "-subj",
    "/CN=auth.openai.com",
  ],
  { stdio: "ignore" },
);
await writeFile(
  join(root, "tls.ext"),
  "subjectAltName=DNS:auth.openai.com,DNS:api.openai.com\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
);
execFileSync(
  "openssl",
  [
    "x509",
    "-req",
    "-in",
    join(root, "tls.csr"),
    "-CA",
    caPath,
    "-CAkey",
    join(root, "ca-key.pem"),
    "-CAcreateserial",
    "-out",
    tlsCertPath,
    "-days",
    "2",
    "-extfile",
    join(root, "tls.ext"),
  ],
  { stdio: "ignore" },
);
execFileSync(
  "openssl",
  ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", jwtKeyPath],
  { stdio: "ignore" },
);
const privateKey = createPrivateKey(await readFile(jwtKeyPath));
const jwk = {
  ...createPublicKey(privateKey).export({ format: "jwk" }),
  kid: "subscription-fixture",
  alg: "ES256",
  use: "sig",
};
const upstream = httpsServer(
  { key: await readFile(tlsKeyPath), cert: await readFile(tlsCertPath) },
  async (request, response) => {
    networkRequests.push({ method: request.method, path: request.url, at: Date.now() });
    try {
      let raw = "";
      for await (const part of request) raw += part;
      const json = (value) => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(value));
      };
      if (request.url === "/.well-known/openid-configuration")
        return json({
          issuer: "https://auth.openai.com",
          authorization_endpoint: "https://auth.openai.com/authorize",
          token_endpoint: "https://auth.openai.com/token",
          jwks_uri: "https://auth.openai.com/keys",
          revocation_endpoint: "https://auth.openai.com/revoke",
        });
      if (request.url === "/keys") return json({ keys: [jwk] });
      if (request.url === "/revoke") {
        response.writeHead(200);
        response.end();
        return;
      }
      if (request.url === "/token") {
        const form = new URLSearchParams(raw),
          client = form.get("client_id");
        assert.ok(client && client !== "dynamic_agent_client");
        assert.equal(form.get("resource"), "https://api.openai.com/v1");
        const tokens = {
          token_type: "Bearer",
          access_token: tokenFor(client),
          refresh_token: `synthetic-refresh-next-${client}`,
          expires_in: 3600,
          scope: "openid resource.invoke chatgpt.tokens.use.direct",
        };
        if (form.get("grant_type") === "authorization_code") {
          assert.equal(client, authClient);
          assert.equal(form.get("code"), "fixture-code");
          assert.ok(form.get("code_verifier"));
          tokens.id_token = await new SignJWT({
            sub: "subject-new",
            nonce: authNonce,
            email: "same@fixture.invalid",
          })
            .setProtectedHeader({ alg: "ES256", kid: jwk.kid })
            .setIssuer("https://auth.openai.com")
            .setAudience(client)
            .setIssuedAt()
            .setExpirationTime("1h")
            .sign(privateKey);
        } else {
          assert.equal(form.get("grant_type"), "refresh_token");
          refreshes.push({ client, at: Date.now() });
        }
        return json(tokens);
      }
      if (request.url === "/v1/models")
        return json({
          models: [
            {
              slug: "fixture",
              visibility: "list",
              display_name: "Fixture account",
              context_window: 131072,
              use_responses_lite: true,
              support_verbosity: true,
              default_verbosity: "low",
            },
          ],
        });
      if (request.url === "/v1/responses") {
        const body = JSON.parse(raw);
        assert.equal(body.stream, true);
        const text = JSON.stringify(body.input);
        if (
          `${body.instructions ?? ""}\n${text}`.includes(
            "Generate a concise semantic session title",
          )
        ) {
          requests.push({ purpose: "summary", at: Date.now() });
          response.setHeader("content-type", "text/event-stream");
          return response.end(completed("Fixture session"));
        }
        const purpose = text.includes("HOST_SUB_ORIGINAL")
          ? "original"
          : text.includes("HOST_SUB_EPOCH")
            ? "epoch"
            : "new-account";
        requests.push({
          purpose,
          account:
            request.headers.authorization === `Bearer ${tokenFor("client-primary")}`
              ? "primary"
              : request.headers.authorization === `Bearer ${tokenFor("fixture-issued")}`
                ? "new"
                : "other",
          at: Date.now(),
        });
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("x-codex-turn-state", "fixture-turn-state");
        if (purpose === "original" || purpose === "epoch") {
          response.write(chunk({ type: "response.output_text.delta", delta: "HOST_SUB_NATIVE_" }));
          if (purpose === "original") heldOriginal = response;
          else heldEpoch = response;
          return;
        }
        return response.end(completed("HOST_SUB_NEW_ACCOUNT_DONE"));
      }
      response.writeHead(404);
      response.end();
    } catch (error) {
      fixtureFailure = error;
      response.destroy(error);
    }
  },
);
upstream.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
const proxy = createServer();
proxy.on("connect", (request, downstream, head) => {
  try {
    assert.ok(
      ["auth.openai.com:443", "api.openai.com:443"].includes(request.url),
      `Unexpected external authority ${request.url}`,
    );
    const socket = tcpConnect(upstream.address().port, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) socket.write(head);
      downstream.pipe(socket);
      socket.pipe(downstream);
    });
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => downstream.destroy());
    downstream.on("error", () => socket.destroy());
  } catch (error) {
    fixtureFailure = error;
    downstream.destroy(error);
  }
});
proxy.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
async function until(read, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fixtureFailure) throw fixtureFailure;
    const value = await read();
    if (value) return value;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timeout: ${label}`);
}
async function command(action) {
  const id = randomUUID();
  const before = await host.request("subscription.read", { sourceId: source.sourceId });
  await host.request("subscription.command", {
    requestId: id,
    expectedGeneration: host.generation,
    sourceId: source.sourceId,
    expectedAccountEpoch: before.accountEpoch,
    action,
  });
  const receipt = await until(async () => {
    const row = (await host.operation(id)).operation;
    return ["completed", "blocked"].includes(row?.state) && row;
  }, `native ${action.kind}`);
  assert.equal(receipt.state, "completed", JSON.stringify(receipt));
  evidence.commands.push({ kind: action.kind, requestId: id });
  return receipt.result;
}
async function startHost() {
  const log = await open(join(home, "host.log"), "a", 0o600);
  hostChild = spawn(binary, ["host", "run"], {
    env: { ...process.env, AREAL_HARNESS_HOME: home, AREAL_HARNESS_SERVICE_HOME: home },
    stdio: ["ignore", "ignore", log.fd],
  });
  await log.close();
  await until(async () => {
    assert.equal(hostChild.exitCode, null, "Host startup");
    try {
      await host.connect(home);
      return true;
    } catch {
      host.close();
      return false;
    }
  }, "native Host startup");
  hostIdentity = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
}
async function stopHost() {
  const receipt = await host.stop(randomUUID(), host.generation, "cancel");
  evidence.cleanup.push({ kind: "Host stop", receipt });
  assert.equal(receipt.state, "completed");
  await until(() => hostChild.exitCode !== null, "Host process exit");
  host.close();
}
async function transportState(sourceId) {
  for (const file of await readdir(join(home, "host/vault-slots"))) {
    const state = JSON.parse(await readFile(join(home, "host/vault-slots", file), "utf8"));
    if (state.slot.kind === "subscriptionTransport" && state.slot.sourceId === sourceId)
      return state;
  }
  assert.fail("missing original subscription transport slot");
}
async function recoverySource(name, zero) {
  const projects = new GuiHostProjects({
    binary,
    home,
    singletonHeld: true,
    source: {
      profile: join(root, name, "profile"),
      coreHome: join(root, name, "core"),
      legacyServiceHome: join(root, name, "legacy"),
    },
    encryption: source.options.encryption,
  });
  const row = { name, zero, projects, legacy: null, native: null };
  recoverySources.push(row);
  await mkdir(projects.source.coreHome, { recursive: true, mode: 0o700 });
  await writeFile(join(projects.source.coreHome, "projects.json"), "[]", { mode: 0o600 });
  await writeFile(
    join(projects.source.coreHome, "subscription-transport.json"),
    JSON.stringify({ token: "8".repeat(64), port: 0 }),
    { mode: 0o600 },
  );
  await projects.init();
  const backend = {
    host: projects,
    home: projects.source.coreHome,
    hooks: { environment: () => ({}) },
    save: (name, value) =>
      writeFile(join(projects.source.coreHome, name), JSON.stringify(value), { mode: 0o600 }),
  };
  const vault = new HostVault(backend);
  await vault.init();
  const slot = { kind: "subscriptionTransport", sourceId: projects.sourceId };
  if (!zero) {
    let saved = await vault.read(slot);
    row.legacy = new CoreSubscription({
      store: new SubscriptionStore(backend, vault),
      token: saved.value.token,
      port: 0,
      kind: "openai",
      onListen: async (port) => {
        saved = await vault.replace(slot, saved.revision, { ...saved.value, port });
      },
    });
    await row.legacy.ready();
    await row.legacy.close();
    row.legacy = null;
  }
  row.native = await NativeSubscription.connect(backend, vault);
  const markerPath = join(home, "host/subscription-owners", `${projects.sourceId}.json`);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const path = join(home, "host/subscription-operations", `${marker.requestId}.json`);
  const record = JSON.parse(await readFile(path, "utf8"));
  assert.equal(record.context.migrationId, projects.migrationId);
  const transport = (await host.operation(record.context.transportRequestId)).operation;
  assert.equal(transport.state, "completed");
  const port = (await host.operation(record.context.portRequestId)).operation;
  if (zero) {
    assert.equal(port.state, "completed");
    assert.equal(port.previousRevision, transport.revision);
  } else assert.equal(port, null);
  const before = await host.request("subscription.read", { sourceId: projects.sourceId });
  const current = await transportState(projects.sourceId);
  assert.equal(current.entryId, (zero ? port : transport).entryId);
  assert.equal(current.revision, (zero ? port : transport).revision);
  Object.assign(row, { path, markerPath, record, before, current, transport, port });
  await writeFile(join(root, `before-${name}-recovery.json`), JSON.stringify(record), {
    mode: 0o600,
  });
  record.receipt = record.acceptedReceipt;
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  row.native.pending = [{ requestId: marker.requestId, method: "subscription.handoff" }];
  await row.native.save();
  await row.native.settle();
  assert.equal(row.native.outcomeUnknown, true);
  assert.match((await row.native.read()).error, /效果尚未确认/);
  return row;
}
const primaryExpires = Date.now() + 90_000;
const grant = (client, subject, expires) => ({
  kind: "grant",
  payload: {
    type: "oauth",
    hostId: "urn:uuid:fixture",
    clientId: client,
    subject,
    accountId: subject,
    issuer: "https://auth.openai.com",
    email: "same@fixture.invalid",
    access: `synthetic-access-initial-${client}`,
    refresh: `synthetic-refresh-${client}`,
    expires,
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
  },
});
try {
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  await writeFile(join(source.source.coreHome, "projects.json"), "[]", { mode: 0o600 });
  await writeFile(
    join(source.source.coreHome, "openai-subscription.json"),
    JSON.stringify({
      secret: Buffer.from(
        JSON.stringify({
          kind: "directory",
          payload: {
            version: 1,
            hostId: "urn:uuid:fixture",
            activeId: "primary",
            records: {
              primary: {
                label: "Primary",
                record: grant("client-primary", "subject-primary", primaryExpires),
              },
              second: {
                label: "Second",
                record: grant("client-second", "subject-second", Date.now() + 3600000),
              },
            },
          },
        }),
      ).toString("base64"),
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(source.source.coreHome, "subscription-transport.json"),
    JSON.stringify({ token: "9".repeat(64), port: 0 }),
    { mode: 0o600 },
  );
  await startHost();
  evidence.host = hostIdentity;
  host.requireCapability("subscriptionOwnerV1");
  await source.init();
  const backend = {
    host: source,
    home: source.source.coreHome,
    hooks: {
      environment: () => ({
        HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}`,
        HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
        NO_PROXY: "127.0.0.1,localhost,::1",
        NODE_EXTRA_CA_CERTS: caPath,
      }),
    },
    save: (name, value) =>
      writeFile(join(source.source.coreHome, name), JSON.stringify(value), { mode: 0o600 }),
  };
  const vault = new HostVault(backend);
  await vault.init();
  const store = new SubscriptionStore(backend, vault);
  const transportSlot = { kind: "subscriptionTransport", sourceId: source.sourceId };
  let transport = await vault.read(transportSlot);
  legacy = new CoreSubscription({
    store,
    token: transport.value.token,
    port: transport.value.port,
    kind: "openai",
    onListen: async (port) => {
      transport = await vault.replace(transportSlot, transport.revision, {
        ...transport.value,
        port,
      });
    },
  });
  await legacy.ready();
  const oldPort = new URL(legacy.endpoint).port;
  const oldAccounts = await legacy.openaiAccount.directory.public();
  const accountSlot = {
    kind: "subscriptionAccount",
    sourceId: source.sourceId,
    providerId: "openai",
  };
  const before = await vault.read(accountSlot);
  const oldWrite = randomUUID();
  const oldReceipt = await source.client.vaultReplace(
    oldWrite,
    accountSlot,
    before.revision,
    before.value,
  );
  const projectId = "111111111111111111111111";
  const configPath = join(root, "config.toml");
  await writeFile(
    configPath,
    'schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1/unused"\n',
  );
  const ensureGui = async (id, names) => {
    await source.register(randomUUID(), { id, root: workspace });
    const binding = source.resolve(id);
    await mkdir(binding.scratchDir, { recursive: true, mode: 0o700 });
    return {
      binding,
      result: await host.ensureProject(randomUUID(), binding.projectId, {
        workspace,
        cwd: workspace,
        configHome: user,
        homedir: user,
        configPath,
        schedulePreparation: { kind: "external" },
        environment: { PATH: process.env.PATH, NO_PROXY: "127.0.0.1,localhost" },
        credentialNames: names,
        options: {
          workspace,
          data_dir: binding.dataDir,
          scratch: binding.scratchDir,
          allow_write: true,
          allow_network: false,
          allow_concurrent_writes: false,
          read_only_path: [],
          task_credential_command: [],
          no_deployment_mcp: false,
          sandbox_profile: "native",
        },
      }),
    };
  };
  const first = await ensureGui(projectId, ["AREAL_CREDENTIAL_areal_openai"]);
  const binding = first.binding;
  const ensured = first.result;
  evidence.service = ensured.service;
  core = await connect(ensured.service.endpoint, ensured.service.authFile);
  const provider = {
    id: "areal_openai",
    revision: 0,
    contextSource: "account",
    protocol: "responses",
    endpoint: legacy.endpoint,
    credentialRef: "areal_openai",
    models: ["fixture"],
    modelParameters: { fixture: { contextWindowTokens: 131072 } },
    modelCapabilities: {},
    parameters: {},
  };
  const rejectedId = randomUUID(),
    acceptedId = randomUUID();
  const rejectedParams = {
    requestId: rejectedId,
    provider: { ...provider, credentialRef: "unconfigured-old-reference" },
    expectedRevision: 0,
  };
  const acceptedParams = { requestId: acceptedId, provider, expectedRevision: 0 };
  const journal = source.journal(projectId);
  await journal.change((snapshot) => ({
    ...snapshot,
    pending: [
      ...snapshot.pending,
      { method: "areal/provider/upsert", operationId: rejectedId, params: rejectedParams },
    ],
  }));
  await assert.rejects(
    core.call("areal/provider/upsert", rejectedParams),
    (error) => error.data?.reason === "CREDENTIAL_UNAVAILABLE",
  );
  await journal.change((snapshot) => ({
    ...snapshot,
    pending: [
      ...snapshot.pending,
      { method: "areal/provider/upsert", operationId: acceptedId, params: acceptedParams },
    ],
  }));
  const configured = await core.call("areal/provider/upsert", acceptedParams);
  await legacy.close();
  legacy = null;
  await store.chain;
  await vault.ready(accountSlot);
  await vault.ready(transportSlot);
  native = await NativeSubscription.connect(backend, vault);
  assert.equal(new URL(native.endpoint).port, oldPort, "native binds released original port");
  const nativeState = await source.client.request("subscription.read", {
    sourceId: source.sourceId,
  });
  assert.deepEqual(
    nativeState.accounts.map((row) => row.id),
    oldAccounts.accounts.map((row) => row.id),
  );
  assert.deepEqual(
    await source.client.vaultReplace(oldWrite, accountSlot, before.revision, before.value),
    oldReceipt,
    "original accepted receipt survives native writer fence",
  );
  await assert.rejects(
    source.client.vaultReplace(randomUUID(), accountSlot, oldReceipt.revision, before.value),
    { code: "subscriptionOwnerRequired" },
  );
  await until(async () => {
    const state = await host.request("subscription.read", { sourceId: source.sourceId });
    return state.applied?.[binding.projectId]?.generation === ensured.service.generation;
  }, "existing Core native continuity");
  const preserved = await journal.read();
  assert.deepEqual(preserved.snapshot.outcomes[rejectedId].params, rejectedParams);
  assert.equal(
    preserved.snapshot.outcomes[rejectedId].response.error.data.reason,
    "CREDENTIAL_UNAVAILABLE",
  );
  assert.deepEqual(preserved.snapshot.outcomes[acceptedId].params, acceptedParams);
  const existing = (await host.status()).projects.find(
    (row) => row.registration.projectId === binding.projectId,
  );
  assert.equal(existing.service.generation, ensured.service.generation);
  assert.equal(existing.service.serviceId, ensured.service.serviceId);
  const unchanged = (await core.call("areal/provider/list", {})).data.find(
    (row) => row.id === "areal_openai",
  );
  assert.equal(
    unchanged.revision,
    configured.revision,
    "equivalent canonical parameters do not create another provider mutation",
  );
  evidence.checks.push({
    name: "existing Core generation and original token/port continue through old source drain; original rejected and accepted provider receipts retained without replay; writer fenced",
    rejectedId,
    acceptedId,
    passed: true,
  });
  const second = await ensureGui("222222222222222222222222", []);
  coreTwo = await connect(second.result.service.endpoint, second.result.service.authFile);
  evidence.freshService = second.result.service;
  await until(async () => {
    const rows = await coreTwo.call("areal/provider/list", {});
    return rows.data.find((row) => row.id === "areal_openai");
  }, "fresh Core receives Host-owned reserved credential and native provider");
  evidence.checks.push({
    name: "fresh bound Core with empty GUI credential names receives Host-owned native transport credential",
    passed: true,
  });
  const login = await native.command({ operation: "login", newAccount: true });
  const authorization = new URL(login.authUrl);
  authNonce = authorization.searchParams.get("nonce");
  authClient = "fixture-issued";
  assert.equal(authorization.searchParams.get("client_id"), "dynamic_agent_client");
  await native.close();
  native = null;
  source.close();
  evidence.sourceClientClosedAt = Date.now();
  await until(() => Date.now() >= primaryExpires - 60000, "refresh margin reached", 45000);
  const original = await core.call("areal/thread/start", {
    requestId: randomUUID(),
    cwd: workspace,
    model: { providerId: "areal_openai", modelId: "fixture" },
  });
  const threadId = original.thread.id;
  const started = await core.call("areal/turn/start", {
    requestId: randomUUID(),
    threadId,
    input: [{ type: "text", text: "HOST_SUB_ORIGINAL" }],
    expectedConfigRevision: 1,
  });
  const turnId = started.turn.id;
  await until(() => heldOriginal, "original paused SSE");
  assert.equal(refreshes.length, 1);
  assert.ok(
    refreshes[0].at >= evidence.sourceClientClosedAt,
    "refresh performed after source client closed",
  );
  const epoch = (await host.request("subscription.read", { sourceId: source.sourceId }))
    .accountEpoch;
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({
    state: authorization.searchParams.get("state"),
    code: "fixture-code",
    client_id: authClient,
  }).toString();
  assert.equal((await fetch(callback)).status, 200);
  const inactive = await until(async () => {
    const state = await host.request("subscription.read", { sourceId: source.sourceId });
    return (
      state.accounts.find(
        (row) => !["primary", "second"].includes(row.id) && row.state === "saved",
      ) && state
    );
  }, "new account saved inactive while original Core busy");
  const newId = inactive.accounts.find((row) => !["primary", "second"].includes(row.id)).id;
  assert.equal(inactive.activeAccountId, "primary");
  assert.equal(inactive.accountEpoch, epoch);
  assert.equal(heldOriginal.destroyed, false);
  heldOriginal.end(
    chunk({ type: "response.output_text.delta", delta: "DONE" }) +
      chunk({
        type: "response.completed",
        response: {
          id: "original-response",
          status: "completed",
          output: [
            {
              id: "original-message",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "HOST_SUB_NATIVE_DONE" }],
            },
          ],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      }),
  );
  const finished = await until(async () => {
    const result = await core.call("thread/read", { threadId, includeTurns: true });
    return (
      result.thread.turns?.some((turn) => turn.id === turnId && turn.status === "completed") &&
      result
    );
  }, "original Core Turn completed after source client closed");
  assert.ok(JSON.stringify(finished).includes("HOST_SUB_NATIVE_DONE"));
  await until(async () => {
    const records = await readModelRequests(ensured.service);
    return records.some((row) => row.purpose === "Summary" && row.outcome === "completed");
  }, "independent session title request completed");
  assert.equal(requests.filter((row) => row.purpose === "original").length, 1);
  evidence.checks.push({
    name: "actual Host refresh after source client close; SIWC new account saved inactive; original Core SSE Turn completes once",
    threadId,
    turnId,
    passed: true,
  });
  await command({ kind: "select", accountId: newId });
  await until(async () => {
    const state = await host.request("subscription.read", { sourceId: source.sourceId });
    return state.activeAccountId === newId && state.state === "ready";
  }, "native new account selected");
  const directToken = (await host.vaultRead(transportSlot)).value.token;
  const state = await host.request("subscription.read", { sourceId: source.sourceId });
  const response = await fetch(state.endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${directToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "fixture",
      stream: true,
      input: [{ role: "user", content: "HOST_SUB_EPOCH" }],
    }),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length);
  await command({ kind: "logout" });
  await assert.rejects(reader.read());
  assert.equal(requests.filter((row) => row.purpose === "epoch").length, 1);
  const signedOut = await host.request("subscription.read", { sourceId: source.sourceId });
  assert.equal(signedOut.authenticated, false);
  assert.equal(signedOut.state, "signed_out");
  await until(
    async () =>
      !(await core.call("areal/provider/list", {})).data.some((row) => row.id === "areal_openai"),
    "signed out Core provider removed",
  );
  assert.equal(refreshes.length, 1);
  evidence.checks.push({
    name: "native account select then logout aborts old HTTP body and removes Core provider without POST replay",
    passed: true,
  });
  const marker = JSON.parse(
    await readFile(join(home, "host/subscription-owners", `${source.sourceId}.json`), "utf8"),
  );
  const logout = evidence.commands.find((row) => row.kind === "logout");
  const requestsBeforeRecovery = networkRequests.length;
  await recoverySource("original-nonzero-port", false);
  await recoverySource("original-zero-port", true);
  await core.close();
  core = null;
  await coreTwo.close();
  coreTwo = null;
  await stopHost();
  for (const row of recoverySources) {
    row.projects.close();
    await unlink(row.markerPath);
  }
  evidence.recoveryInjection = {
    kind: "original accepted receipt restored after orderly process stop, before next process start",
    oldHost: hostIdentity,
    operations: [],
  };
  for (const id of [marker.requestId, logout.requestId]) {
    const path = join(home, "host/subscription-operations", `${id}.json`);
    const record = JSON.parse(await readFile(path, "utf8"));
    assert.equal(record.receipt.state, "completed");
    assert.equal(record.acceptedReceipt.requestId, id);
    assert.equal(record.acceptedReceipt.state, "acceptedPending");
    await writeFile(join(root, `before-recovery-${id}.json`), JSON.stringify(record), {
      mode: 0o600,
    });
    record.receipt = record.acceptedReceipt;
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    evidence.recoveryInjection.operations.push({ requestId: id, method: record.receipt.method });
  }
  await startHost();
  evidence.restartedHost = hostIdentity;
  assert.notEqual(host.generation, evidence.recoveryInjection.oldHost.generation);
  const recoveredHandoff = (await host.operation(marker.requestId)).operation;
  assert.equal(recoveredHandoff.requestId, marker.requestId);
  assert.equal(recoveredHandoff.state, "completed");
  const recoveredLogout = (await host.operation(logout.requestId)).operation;
  assert.equal(recoveredLogout.requestId, logout.requestId);
  assert.equal(recoveredLogout.state, "blocked");
  assert.equal(recoveredLogout.error.code, "outcomeUnknown");
  const restored = await host.request("subscription.read", { sourceId: source.sourceId });
  assert.equal(restored.state, "signed_out");
  assert.equal(restored.accountRevision, signedOut.accountRevision);
  assert.equal(restored.transportRevision, signedOut.transportRevision);
  assert.equal(restored.endpoint, state.endpoint);
  assert.equal(refreshes.length, 1);
  for (const row of recoverySources) {
    await row.projects.client.connect(home);
    const operations = await readdir(join(home, "host/subscription-operations"));
    const observed = await row.native.refresh();
    assert.equal(observed.state, "signed_out");
    assert.equal(observed.error, null);
    assert.equal(row.native.outcomeUnknown, false);
    assert.deepEqual(row.native.pending, []);
    const restored = await host.request("subscription.read", { sourceId: row.projects.sourceId });
    assert.equal(restored.owner, "nativeV1");
    assert.equal(restored.endpoint, row.before.endpoint);
    assert.equal(restored.accountRevision, row.before.accountRevision);
    assert.equal(restored.transportRevision, row.before.transportRevision);
    const current = await transportState(row.projects.sourceId);
    assert.deepEqual(current, row.current);
    assert.deepEqual(
      (await host.operation(row.record.context.transportRequestId)).operation,
      row.transport,
    );
    assert.deepEqual((await host.operation(row.record.context.portRequestId)).operation, row.port);
    assert.deepEqual(await readdir(join(home, "host/subscription-operations")), operations);
    const original = JSON.parse(await readFile(row.path, "utf8"));
    assert.equal(original.receipt.requestId, row.record.acceptedReceipt.requestId);
    assert.equal(original.receipt.state, "completed");
    assert.equal(original.recovery.outcome, "originalHandoffResumed");
    const marker = JSON.parse(await readFile(row.markerPath, "utf8"));
    assert.equal(marker.requestId, original.receipt.requestId);
    evidence.checks.push({
      name: `no-marker ${row.name} resumes original local handoff and same facade becomes readable without extra mutation`,
      sourceId: row.projects.sourceId,
      requestId: original.receipt.requestId,
      originalTransportReceipt: row.transport,
      originalPortReceipt: row.port,
      currentEntryId: current.entryId,
      currentRevision: current.revision,
      passed: true,
    });
  }
  assert.equal(requests.length, 3);
  assert.equal(refreshes.length, 1);
  assert.equal(
    networkRequests.length,
    requestsBeforeRecovery,
    "local handoff recovery sends no upstream HTTP",
  );
  const recoveryBackend = {
    ...backend,
    host: { client: host, sourceId: source.sourceId },
  };
  await backend.save("subscription-operations.json", {
    version: 1,
    pending: [{ requestId: logout.requestId, method: "subscription.command" }],
  });
  const operationsBefore = await readdir(join(home, "host/subscription-operations"));
  const consumer = await NativeSubscription.connect(recoveryBackend, vault);
  const observed = await consumer.read();
  assert.equal(observed.state, "signed_out");
  assert.match(observed.error, /效果尚未确认/);
  assert.equal(consumer.pending[0].requestId, logout.requestId);
  await assert.rejects(consumer.action({ kind: "logout" }), /效果尚未确认/);
  await consumer.refresh();
  assert.deepEqual(await readdir(join(home, "host/subscription-operations")), operationsBefore);
  await consumer.close();
  const recoveredRecord = JSON.parse(
    await readFile(join(home, "host/subscription-operations", `${logout.requestId}.json`), "utf8"),
  );
  assert.equal(recoveredRecord.acceptedReceipt.state, "acceptedPending");
  assert.equal(recoveredRecord.context.sourceId, source.sourceId);
  assert.equal(recoveredRecord.context.generation, evidence.recoveryInjection.oldHost.generation);
  assert.equal(recoveredRecord.recovery.generation, host.generation);
  evidence.checks.push({
    name: "new Host settles original committed handoff, retains interrupted command outcomeUnknown and GUI pending, without replay or revision change",
    handoffRequestId: marker.requestId,
    commandRequestId: logout.requestId,
    passed: true,
  });
} catch (error) {
  failure = error.stack;
} finally {
  for (const row of recoverySources) {
    await row.legacy?.close().catch((error) => (failure ??= error.stack));
    await row.native?.close().catch((error) => (failure ??= error.stack));
    row.projects.close();
  }
  await legacy?.close().catch((error) => (failure ??= error.stack));
  await native?.close().catch((error) => (failure ??= error.stack));
  source.close();
  await core?.close().catch((error) => (failure ??= error.stack));
  await coreTwo?.close().catch((error) => (failure ??= error.stack));
  if (hostIdentity) {
    try {
      const state = await host.request("subscription.read", { sourceId: source.sourceId });
      if (state.login) state.login = { loginId: state.login.loginId, authUrl: "[redacted]" };
      evidence.lastSubscription = state;
    } catch (error) {
      evidence.lastSubscriptionError = { code: error.code, message: error.message };
    }
  }
  if (hostIdentity) {
    try {
      await stopHost();
    } catch (error) {
      failure ??= error.stack;
    }
  }
  host.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => proxy.close(done));
  await new Promise((done) => upstream.close(done));
  if (process.platform === "darwin") {
    const service = `org.areal.host.v1.${hash(home)}`;
    const entries = new Set();
    for (const directory of ["vault-operations", "remote-operations"]) {
      for (const file of await readdir(join(home, "host", directory)).catch((error) =>
        error.code === "ENOENT" ? [] : Promise.reject(error),
      )) {
        const row = JSON.parse(await readFile(join(home, "host", directory, file), "utf8"));
        if (row.entryId) entries.add(row.entryId);
      }
    }
    for (const directory of await readdir(join(home, "host/imports")).catch((error) =>
      error.code === "ENOENT" ? [] : Promise.reject(error),
    )) {
      const record = JSON.parse(
        await readFile(join(home, "host/imports", directory, "record.json"), "utf8"),
      );
      for (const row of [...record.secrets, ...record.vaultReceipts])
        if (row.entryId) entries.add(row.entryId);
    }
    for (const entryId of entries) {
      const remove = spawnSync(
        "security",
        ["delete-generic-password", "-s", service, "-a", entryId],
        { encoding: "utf8" },
      );
      const absent = spawnSync(
        "security",
        ["find-generic-password", "-s", service, "-a", entryId],
        { encoding: "utf8" },
      );
      assert.equal(absent.status, 44);
      evidence.cleanup.push({
        kind: "synthetic Vault item",
        entryId,
        removed: remove.status === 0,
        absent: true,
      });
    }
  }
  evidence.requests = requests;
  evidence.networkRequests = networkRequests;
  evidence.refreshes = refreshes;
  evidence.coreModelRequests = [];
  for (const service of [evidence.service, evidence.freshService].filter(Boolean)) {
    const records = await readModelRequests(service);
    evidence.coreModelRequests.push(...records);
  }
  if (!failure) {
    const solve = evidence.coreModelRequests.filter((row) => row.purpose === "Solve");
    try {
      assert.equal(solve.length, 1, "final Core Solve count after all asynchronous work stopped");
      assert.equal(solve[0].httpAttempts, 1);
      assert.equal(solve[0].outcome, "completed");
      assert.equal(requests.filter((row) => row.purpose === "original").length, 1);
      assert(
        evidence.coreModelRequests
          .filter((row) => row.purpose === "Summary")
          .every((row) => row.outcome === "completed"),
      );
    } catch (error) {
      failure = error.stack;
    }
  }
  evidence.failure = failure;
  evidence.fixtureFailure = fixtureFailure?.stack;
  evidence.passed = !failure && !fixtureFailure;
  evidence.ports = { upstream: upstream.address(), proxy: proxy.address() };
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify(
      { passed: evidence.passed, evidence: join(root, "result.json"), failure },
      null,
      2,
    ),
  );
  if (!evidence.passed) process.exitCode = 1;
}

async function readModelRequests(service) {
  const text = await readFile(join(service.dataDir, "model-requests/requests.jsonl"), "utf8").catch(
    (error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      return {
        serviceId: service.serviceId,
        requestId: row.requestId,
        threadId: row.threadId,
        turnId: row.turnId,
        purpose: row.purpose,
        httpAttempts: row.httpAttempts,
        outcome: row.outcome,
      };
    });
}
