import { attachRemoteHostFixture } from "./remote-host-fixture.cjs";
import { makeTempDir } from "./support/temp.mjs";
import { selectRemoteTransport, requireBrowserTransport } from "./remote-conformance-transport.mjs";
const transport = selectRemoteTransport();
await requireBrowserTransport(transport, "remote-observation-e2e");
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chromium } from "../app/node_modules/playwright-core/index.mjs";
import { createIdentity, identityId } from "../packages/remote/src/channel.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { CoreBackend } = require("@areal/workbench-service/desktop/core/backend.cjs");
const { DesktopService } = require("@areal/workbench-service/desktop/core/service-protocol.cjs");
const { RemoteControl } = require("@areal/workbench-service/desktop/core/remote.cjs");
const scratch = await makeTempDir("areal-remote-rc01-");
const workspace = join(scratch, "workspace");
const home = join(scratch, "desktop");
await mkdir(workspace);
await mkdir(join(scratch, "user", ".areal"), { recursive: true });
let modelRequests = 0;
const model = createServer(async (request, response) => {
  for await (const _ of request) {
    /* 消费确定性模型请求。 */
  }
  modelRequests++;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    'data: {"choices":[{"index":0,"delta":{"content":"RC01_READY"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );
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
const backend = new CoreBackend({
  binary: process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal"),
  home,
  harnessHome: join(scratch, "registry"),
  userHome: join(scratch, "user"),
  desktopConfig: deployment,
  defaultProfile: { id: "fixture", revision: "v1" },
});
let service,
  browser,
  passed = false;
const checks = [];
async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
try {
  await backend.init();
  const projectId = await backend.addProject(workspace);
  const { threadId } = await backend.command("create", { projectId });
  await backend.command("send", { projectId, threadId, text: "Return RC01_READY" });
  const deadline = Date.now() + 15000;
  while (modelRequests < 1 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(modelRequests, 1, "real Core called the deterministic model");
  checks.push("real Core/Runtime deterministic model");
  service = new DesktopService(backend, "fixture-desktop");
  const hostIdentity = await createIdentity();
  const protectedConfig = {
    enabled: false,
    directEnabled: true,
    identity: hostIdentity,
    deviceGrants: [],
  };
  const encryptionFixture = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "fixture",
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString("utf8"),
  };
  await writeFile(
    join(home, "remote-host-fixture.json"),
    JSON.stringify({ encrypted: Buffer.from(JSON.stringify(protectedConfig)).toString("base64") }),
  );
  const remote = (service.remote = new RemoteControl(service));
  const previousResourcePath = process.resourcesPath;
  process.resourcesPath = join(scratch, "missing-assets");
  try {
    attachRemoteHostFixture(remote, encryptionFixture);
    await remote.init();
  } finally {
    process.resourcesPath = previousResourcePath;
  }
  assert.equal(
    remote.state().directEnabled,
    false,
    "failed optional Direct startup leaves desktop available",
  );
  assert.equal(remote.direct ?? null, null);
  assert.match(remote.state().directError, /Direct|资源|入口/);
  const privateService = await service.listen();
  assert.equal(
    typeof privateService.endpoint,
    "string",
    "private desktop listener remains available",
  );
  process.resourcesPath = join(scratch, "missing-assets");
  try {
    await assert.rejects(() => remote.control({ operation: "enableDirect" }));
  } finally {
    process.resourcesPath = previousResourcePath;
  }
  assert.equal(remote.state().directEnabled, false);
  assert.equal(remote.direct ?? null, null);
  const savedAfterFailure = JSON.parse(
    encryptionFixture.decryptString(
      Buffer.from(
        JSON.parse(await readFile(join(home, "remote-host-fixture.json"), "utf8")).encrypted,
        "base64",
      ),
    ),
  );
  assert.equal(savedAfterFailure.directEnabled, false, "failed enable leaves durable setting off");
  await remote.control({ operation: "enableDirect" });
  const address = remote.direct;
  checks.push(
    "missing Direct assets do not block DesktopService and enable failure leaves no listener",
  );
  const hostId = identityId(remote.config.identity);
  browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  const page = await browser.newPage();
  await page.goto(`${address.origin}/#host=${hostId}`);
  await page.getByRole("button", { name: "连接电脑" }).click();
  const device = page.locator("#device");
  await device.waitFor();
  const peer = (await device.textContent()).trim();
  assert.ok(peer?.startsWith("12D3Koo"));
  // 夹具在桌面侧预置当前设备授权；浏览器仍需通过 Noise 身份证明。
  remote.config.deviceGrants = [
    {
      devicePeerId: peer,
      displayName: "E2E browser",
      projectIds: [projectId],
      capabilities: ["observe"],
      revision: 1,
      status: "active",
    },
  ];
  await page.getByRole("button", { name: "连接电脑" }).click();
  await page
    .getByRole("status")
    .getByText(/已连接/)
    .waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#host").textContent(), hostId);
  assert.match(await page.locator("#projects").textContent(), /workspace.*online/);
  assert.equal(await page.locator("#projects li").count(), 1);
  assert.equal((await page.locator("body").textContent()).includes(workspace), false);
  assert.equal((await page.locator("body").textContent()).includes(privateService.token), false);
  await page.screenshot({ path: join(scratch, "remote-observation.png") });
  checks.push("production browser page authenticated Noise and displayed one authorized project");
  const blocked = await page.request.get(`${address.origin}/service.json`);
  assert.equal(blocked.status(), 404);
  const wrong = await browser.newPage();
  await wrong.goto(`${address.origin}/#host=${identityId(await createIdentity())}`);
  await wrong.getByRole("button", { name: "连接电脑" }).click();
  await wrong
    .getByRole("status")
    .getByText(/不匹配|连接失败|remote peer|expected/i)
    .waitFor({ timeout: 15000 });
  checks.push("wrong Host pin rejected");
  await wrong.close();
  const hostilePage = async (needle, replacement) => {
    const target = await browser.newPage();
    await target.route("**/assets/remote-*.js", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      assert.ok(source.includes(needle), `browser bundle contains ${needle}`);
      await route.fulfill({
        response,
        body: source.replace(needle, replacement),
        contentType: "text/javascript",
      });
    });
    await target.goto(`${address.origin}/#host=${hostId}`);
    return target;
  };
  const unsupported = await hostilePage(
    'apiVersion:"areal.remote.v2"',
    'apiVersion:"areal.remote.v9"',
  );
  await unsupported.getByRole("button", { name: "连接电脑" }).click();
  await unsupported
    .getByRole("status")
    .getByText(/更新远程客户端/)
    .waitFor({ timeout: 15000 });
  checks.push("host rejected unsupported browser protocol");
  await unsupported.close();
  const crossing = await hostilePage(
    'method:"project.list",params:{}',
    'method:"project.list",context:{projectId:"forbidden-project"},params:{}',
  );
  const authorizeHostile = async (target) => {
    await target.getByRole("button", { name: "连接电脑" }).click();
    await target.locator("#device").waitFor();
    const hostilePeer = (await target.locator("#device").textContent()).trim();
    remote.config.deviceGrants.push({
      devicePeerId: hostilePeer,
      displayName: "Adversarial browser",
      projectIds: [projectId],
      capabilities: ["observe"],
      revision: 1,
      status: "active",
    });
    await target.getByRole("button", { name: "连接电脑" }).click();
  };
  await authorizeHostile(crossing);
  await crossing
    .getByRole("status")
    .getByText(/未获授权/)
    .waitFor({ timeout: 15000 });
  checks.push("host rejected browser cross-project request");
  await crossing.close();
  const unknownMethod = await hostilePage(
    'method:"project.list",params:{}',
    'method:"no.such.method",params:{}',
  );
  await authorizeHostile(unknownMethod);
  await unknownMethod
    .getByRole("status")
    .getByText(/不支持的字段或方法/)
    .waitFor({ timeout: 15000 });
  checks.push("host rejected unknown browser method");
  await unknownMethod.close();
  const unknownField = await hostilePage(
    'method:"project.list",params:{}',
    'method:"project.list",params:{},extra:true',
  );
  await authorizeHostile(unknownField);
  await unknownField
    .getByRole("status")
    .getByText(/不支持的字段或方法/)
    .waitFor({ timeout: 15000 });
  checks.push("host rejected unknown browser field");
  await unknownField.close();
  const foreignOrigin = await browser.newPage();
  await foreignOrigin.goto("about:blank");
  const foreignResult = await foreignOrigin.evaluate(
    (url) =>
      new Promise((resolve) => {
        const socket = new WebSocket(url);
        socket.onopen = () => {
          socket.close();
          resolve("opened");
        };
        socket.onerror = () => resolve("rejected");
        socket.onclose = () => resolve("rejected");
      }),
    address.ws,
  );
  assert.equal(
    foreignResult,
    "rejected",
    "browser WebSocket upgrade from foreign Origin is denied",
  );
  checks.push("foreign browser Origin rejected at WebSocket upgrade");
  await foreignOrigin.close();
  await remote.control({ operation: "disableDirect" });
  await page
    .getByRole("status")
    .getByText(/已断开/)
    .waitFor({ timeout: 15000 });
  assert.equal(await page.getByRole("button", { name: "连接电脑" }).isEnabled(), true);
  const localCore = await backend.command("providers", { operation: "list" });
  assert.ok(localCore.data.some((value) => value.id === "fixture"));
  checks.push("Host disconnect clears stale browser state while local Core remains available");
  passed = true;
  checks.push("public listener did not expose desktop service token or route");
  console.log(JSON.stringify({ passed, evidence: scratch, checks }));
} finally {
  await browser?.close();
  service?.close();
  for (const project of backend.projects.values()) {
    try {
      await project.client?.request("areal/server/drain", { strategy: "cancel" });
    } catch {
      /* 保留原失败。 */
    }
  }
  await backend.shutdown().catch(() => backend.disconnect());
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  const manifest = {
    passed,
    checks,
    modelRequests,
    transport: "direct-loopback",
    screenshot: "remote-observation.png (desktop Chrome; not mobile acceptance)",
    command: "pnpm --dir clients/gui run test:remote-observation-e2e",
    source: {
      revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      dirty: execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" }).trim(),
      diffSha256: createHash("sha256")
        .update(execFileSync("git", ["diff", "HEAD"], { cwd: root }))
        .digest("hex"),
    },
    core: { binary: backend.binary, sha256: await fileSha256(backend.binary) },
    environment: {
      node: process.version,
      chrome: browser?.version() ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    scope:
      "real isolated DesktopService/Core/Runtime, deterministic local model, production Remote browser page",
    notRun: [
      "public HTTPS/WSS",
      "mobile Safari/Chrome devices",
      "system keychain",
      "signed package",
      "Relay",
    ],
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifest, null, 2));
}
