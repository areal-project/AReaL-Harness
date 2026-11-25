import { preparePrivateFixtureDirectories } from "./support/desktop-fixture.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { trackedMkdtemp } from "./support/host-cleanup.cjs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { attachPublishedGuiSource, ensureFixtureProject } from "./support/published-source.mjs";
import { assertApplicationStopped, cleanupSyntheticHostKeychain } from "./application-cleanup.mjs";

const root = await realpath(await trackedMkdtemp("/tmp/areal-web-partial-"));
const gui = resolve(fileURLToPath(new URL("..", import.meta.url))),
  binary = resolve(process.env.AREAL_CORE_BIN ?? join(gui, "../../target/debug/areal"));
const expected = process.env.AREAL_SESSION_CORE_SHA256;
const access = process.env.AREAL_SESSION_ACCESS ?? "observe";
assert(["observe", "write"].includes(access), "AREAL_SESSION_ACCESS must be observe or write");
const runs = Number(process.env.AREAL_SESSION_RUNS ?? 21);
assert(Number.isInteger(runs) && runs > 0 && runs <= 21);
if (expected) assert.match(expected, /^[a-f0-9]{64}$/);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const actualSha = sha(await readFile(binary));
if (expected) assert.equal(actualSha, expected, "Core identity changed");
const require = createRequire(join(gui, "app/package.json"));
const { HostClient } = require("@areal/client/node");
const { GuiSourceAdapter } = require("@areal/client/gui-source");
const { chromium } = require("playwright-core");
const source = {
  profile: join(root, "profile"),
  coreHome: join(root, "core"),
  legacyServiceHome: join(root, "legacy"),
};
const home = join(root, "host"),
  user = join(root, "user"),
  config = join(root, "config.toml");
const safe = join(root, "safe-project"),
  blocked = join(root, "blocked-project");
await preparePrivateFixtureDirectories(root, [home, user, safe, blocked, ...Object.values(source)]);
const safeId = sha(safe).slice(0, 24),
  blockedId = sha(blocked).slice(0, 24);
for (const id of [safeId, blockedId])
  await mkdir(join(source.coreHome, id, "state"), { recursive: true, mode: 0o700 });
const marker = join(source.coreHome, blockedId, "state", "unconfirmed-owner-marker");
await writeFile(marker, "synthetic legacy state; no cleanup receipt\n", { mode: 0o600 });
await writeFile(
  join(source.coreHome, "projects.json"),
  JSON.stringify([
    { id: safeId, root: safe },
    { id: blockedId, root: blocked },
  ]),
  { mode: 0o600 },
);
await writeFile(
  config,
  'schema_version=1\n[logging]\nfilter="areal::session_load=debug"\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:1"\n',
  { mode: 0o600 },
);
Object.assign(process.env, {
  AREAL_HARNESS_HOME: home,
  AREAL_HARNESS_SERVICE_HOME: home,
  AREAL_CORE_USER_HOME: user,
  AREAL_CORE_CONFIG: config,
  OTEL_SDK_DISABLED: "true",
  NO_PROXY: "127.0.0.1,localhost",
});
const evidence = {
  root,
  scope: "synthetic partial GUI import, real Host and Web, no credentials or model requests",
  coreSha256: actualSha,
  access,
  runs,
  diagnostic: runs !== 21,
  rendererInputHash: JSON.parse(
    await readFile(join(gui, "renderer/dist/verification-build.json"), "utf8"),
  ).inputHash,
  checks: [],
  pids: {},
  wire: [],
  rpc: [],
  cleanup: {},
  error: null,
  firstFailure: null,
  reached: [],
  unreached: ["host", "project", "browser-samples", "thresholds"],
};
const save = () =>
  writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const client = new HostClient();
let browser, web, hostPid, attachment;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if (e.code === "ESRCH") return false;
    throw e;
  }
};
try {
  await client.connectOrStart(home, binary);
  evidence.reached.push("host");
  evidence.unreached.shift();
  const descriptor = JSON.parse(await readFile(join(home, "host/host.json"), "utf8"));
  hostPid = descriptor.pid;
  evidence.pids.host = hostPid;
  const adapter = new GuiSourceAdapter({ source, hostHome: home, singletonHeld: true });
  const requestId = randomUUID();
  const result = await adapter.import(requestId, { publishOnly: true });
  await writeFile(join(root, "import-result.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  assert.equal(result.sourcePublished, true);
  assert(
    result.blockers.some((x) => x.code === "legacyPending" && x.data?.projectId === blockedId),
  );
  const status = await client.request("gui.importStatus", { migrationId: result.migrationId });
  evidence.checks.push({
    stage: "partial-import",
    requestId,
    phase: result.phase,
    blocker: "legacyPending",
    statusPhase: status.phase,
  });
  const listing = await client.listProjects();
  const safeProject = listing.projects.find((p) => p.projectId === safeId);
  assert(safeProject, "safe project not published");
  let fixtureId;
  {
    const fixturePath = join(
      gui,
      "scripts/fixtures/history-compat/111111111111111111111111/state/66666666-6666-4666-8666-666666666666.json",
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    fixture.thread.cwd = safe;
    fixture.thread.name = "Latency long session";
    fixture.thread.turns = Array.from({ length: 1500 }, (_, i) => ({
      ...fixture.thread.turns[0],
      id: `turn-${i}`,
      items: [
        {
          type: "agentMessage",
          id: `item-${i}`,
          text: `LONG_MESSAGE_${i} ` + "example message ".repeat(500),
        },
      ],
    }));
    const short = structuredClone(fixture);
    short.thread.id = short.thread.sessionId = "77777777-7777-4777-8777-777777777777";
    short.thread.name = "Latency short session";
    short.thread.turns = short.thread.turns
      .slice(0, 3)
      .map((turn, i) => ({ ...turn, items: [{ ...turn.items[0], text: `SHORT_MESSAGE_${i}` }] }));
    await writeFile(
      join(source.coreHome, safeId, "state", `${short.thread.id}.json`),
      JSON.stringify(short),
      { mode: 0o600 },
    );
    const medium = structuredClone(fixture);
    medium.thread.id = medium.thread.sessionId = "88888888-8888-4888-8888-888888888888";
    medium.thread.name = "Latency medium session";
    medium.thread.turns = medium.thread.turns.slice(0, 300).map((turn, i) => ({
      ...turn,
      items: [{ ...turn.items[0], text: `MEDIUM_MESSAGE_${i} ` + "example message ".repeat(20) }],
    }));
    await writeFile(
      join(source.coreHome, safeId, "state", `${medium.thread.id}.json`),
      JSON.stringify(medium),
      { mode: 0o600 },
    );
    fixtureId = fixture.thread.id;
    await writeFile(
      join(source.coreHome, safeId, "state", `${fixtureId}.json`),
      JSON.stringify(fixture),
      { mode: 0o600 },
    );
  }
  attachment = await attachPublishedGuiSource(client, { binary, home, source, user, config });
  const activation = await ensureFixtureProject(client, safeId);
  evidence.reached.push("project");
  evidence.unreached.shift();
  const created = { threadId: fixtureId };
  evidence.checks.push({
    stage: "safe-project-host-ready",
    ...activation,
  });
  const endpoint = JSON.parse(await readFile(join(home, "host/endpoint.json"), "utf8"));
  assert.equal(endpoint.hostId, client.hostId);
  assert.equal(endpoint.generation, client.generation);
  const samples = [];
  const wire = [];
  evidence.samples = samples;
  evidence.wire = wire;
  const clockStart = performance.now();
  for (let run = 0; run < runs; run++) {
    browser = await chromium.launch({ headless: true, channel: "chrome" });
    web = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await web.addLocatorHandler(web.getByRole("button", { name: "稍后处理" }), async (later) => {
      await later.click();
    });
    await web.addInitScript(() => {
      window.__latencyLongtasks = [];
      window.__latencyClicks = [];
      document.addEventListener(
        "click",
        (event) => {
          const row =
            event.target instanceof Element
              ? event.target.closest('[data-testid^="task-item-"]')
              : null;
          if (row)
            window.__latencyClicks.push({
              id: row.getAttribute("data-testid"),
              timeStamp: event.timeStamp,
              trusted: event.isTrusted,
            });
        },
        true,
      );
      new PerformanceObserver((list) =>
        window.__latencyLongtasks.push(
          ...list
            .getEntries()
            .map((entry) => ({ start: entry.startTime, duration: entry.duration })),
        ),
      ).observe({ type: "longtask", buffered: true });
    });
    const pending = new Map();
    const timings = new Map();
    web.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          if (typeof frame.method === "string" && frame.id != null)
            timings.set(String(frame.id), {
              method: frame.method,
              sentMs: performance.now() - clockStart,
            });
          if (["hello", "session.open", "session.openPersisted"].includes(frame.method))
            pending.set(String(frame.id), frame.method);
        } catch {}
      });
      socket.on("framereceived", ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload));
          const timing = timings.get(String(frame.id));
          if (timing) {
            timings.delete(String(frame.id));
            evidence.rpc.push({
              run,
              ...timing,
              responseMs: performance.now() - clockStart,
              error: !!frame.error,
            });
          }
          const method = pending.get(String(frame.id));
          if (!method) return;
          pending.delete(String(frame.id));
          if (method === "hello") {
            const capabilities = frame.result?.negotiatedCapabilities;
            evidence.checks.push({ stage: "negotiated-capabilities", run, capabilities });
            return;
          }
          const thread = frame.result?.snapshot?.thread;
          wire.push({
            method,
            bytes: Buffer.byteLength(String(payload)),
            turns: thread?.turns?.length,
            last: thread?.turns?.at(-1)?.items?.[0]?.text?.slice(0, 32),
            error: frame.error,
          });
        } catch {}
      });
    });
    const pairing = web.waitForResponse(
      (r) => r.url().endsWith("/host/auth/challenge") && r.request().method() === "POST",
    );
    await web.goto(endpoint.origin);
    const challenge = await (await pairing).json();
    await client.request("web.approve", {
      requestId: challenge.requestId,
      expectedGeneration: client.generation,
      scopes: access === "write" ? ["observe", "manage"] : ["observe"],
    });
    await web.getByRole("button", { name: "检查批准状态" }).click();
    await web.getByTestId(`task-item-${created.threadId}`).waitFor({ timeout: 60000 });
    const switches = run === 0 ? 83 : 1;
    for (let i = 0; i < switches; i++) {
      const long = i % 2 === 0;
      const medium = run === 0 && i >= 42 && long;
      const id = medium
        ? "88888888-8888-4888-8888-888888888888"
        : long
          ? created.threadId
          : "77777777-7777-4777-8777-777777777777";
      const prior = await web.evaluate(
        () =>
          performance
            .getEntriesByName("areal.session-load")
            .filter((entry) => entry.detail.stage === "messagesPainted")
            .at(-1)?.detail.sample ?? 0,
      );
      await web.getByTestId(`task-item-${id}`).click();
      await web
        .getByText(medium ? "MEDIUM_MESSAGE_299" : long ? "LONG_MESSAGE_1499" : "SHORT_MESSAGE_2", {
          exact: false,
        })
        .waitFor({ timeout: 60000 });
      await web.waitForFunction(
        (n) =>
          performance
            .getEntriesByName("areal.session-load")
            .some((entry) => entry.detail.stage === "messagesPainted" && entry.detail.sample > n),
        prior,
        { timeout: 30000 },
      );
      samples.push(
        await web.evaluate(
          ({ kind, id }) => {
            const all = performance.getEntriesByName("areal.session-load");
            const last = all.filter((entry) => entry.detail.stage === "messagesPainted").at(-1);
            const click = window.__latencyClicks.at(-1);
            const selected = all.find(
              (entry) =>
                entry.detail.sample === last.detail.sample && entry.detail.stage === "selected",
            );
            if (
              !click ||
              click.id !== `task-item-${id}` ||
              !click.trusted ||
              !selected ||
              selected.startTime < click.timeStamp
            )
              throw new Error("missing or invalid trusted click timing");
            return {
              kind,
              click,
              queueBeforeSelectionMs: selected.startTime - click.timeStamp,
              clickToPaintMs: last.startTime + last.duration - click.timeStamp,
              visibility: document.visibilityState,
              focus: document.hasFocus(),
              longtasks: window.__latencyLongtasks,
              entries: all
                .filter((entry) => entry.detail.sample === last.detail.sample)
                .map((entry) => ({
                  duration: entry.duration,
                  startTime: entry.startTime,
                  ...entry.detail,
                })),
            };
          },
          { kind: medium ? "medium" : long ? "long" : "short", id },
        ),
      );
    }
    const raf = await web.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame((a) => requestAnimationFrame((b) => done(b - a))),
        ),
    );
    evidence.checks.push({ stage: "browser-sample", run, raf });
    await browser.close();
    browser = undefined;
    web = undefined;
  }
  evidence.samples = samples;
  evidence.wire = wire;
  evidence.reached.push("browser-samples");
  evidence.unreached.shift();
  assert(
    evidence.checks.filter((item) => item.stage === "negotiated-capabilities").length >= runs &&
      evidence.checks
        .filter((item) => item.stage === "negotiated-capabilities")
        .every((item) => item.capabilities?.includes("gui-write-v1") === (access === "write")),
    `unexpected negotiated capabilities for ${access}`,
  );
  assert(
    wire.some(
      (entry) =>
        entry.turns > 0 && entry.turns <= 1500 && entry.last?.startsWith("LONG_MESSAGE_1499"),
    ),
    "Host snapshot must include the latest long message",
  );
  evidence.checks.push({
    stage: "long-session-window-visible",
    sourceTurns: 1500,
    sourceBytes: (await readFile(join(source.coreHome, safeId, "state", `${fixtureId}.json`)))
      .length,
  });
  evidence.cleanup.browser = "stopped";
  evidence.statistics = {};
  for (const [kind, cache] of [
    ["long", "miss"],
    ["long", "hit"],
    ["medium", "hit"],
    ["short", "hit"],
  ]) {
    const durations = samples
      .filter((sample) => sample.kind === kind)
      .filter(
        (sample) =>
          sample.entries.find((entry) => entry.stage === "messagesPainted")?.cache === cache,
      )
      .map((sample) => sample.clickToPaintMs)
      .sort((a, b) => a - b);
    const stats = {
      n: durations.length,
      p50: durations[Math.ceil(durations.length * 0.5) - 1],
      p95: durations[Math.ceil(durations.length * 0.95) - 1],
      max: durations.at(-1),
    };
    evidence.statistics[`${kind}-${cache}`] = stats;
    assert(stats.n >= 20, `${kind}-${cache}: insufficient completed samples`);
    assert(stats.max <= 200, `${kind}-${cache}: maximum ${stats.max}ms exceeds 200ms`);
  }
  assert(
    samples.every((sample) => sample.visibility === "visible" && sample.focus),
    "measurement page must be visible and focused",
  );
  assert(
    evidence.checks
      .filter((item) => item.stage === "browser-sample")
      .every((item) => item.raf < 100),
    "browser animation frames are throttled",
  );
  evidence.reached.push("thresholds");
  evidence.unreached.shift();
} catch (e) {
  evidence.error = { message: e.message, stack: e.stack };
  evidence.firstFailure = { stage: evidence.unreached[0] ?? "cleanup", message: e.message };
  if (web) {
    const details = web.getByRole("button", { name: "查看详情" });
    if (await details.isVisible().catch(() => false)) await details.click().catch(() => {});
    await web.screenshot({ path: join(root, "web-failure.png") }).catch(() => {});
    await writeFile(
      join(root, "web-failure.aria"),
      await web
        .locator("body")
        .ariaSnapshot()
        .catch(() => ""),
      { mode: 0o600 },
    );
  }
} finally {
  if (web)
    evidence.webSelection = await web
      .evaluate(() => {
        const node = document.querySelector('[data-testid="areal-workbench"]');
        return {
          projectId: node?.getAttribute("data-project-id") ?? null,
          threadId: node?.getAttribute("data-thread-id") ?? null,
        };
      })
      .catch(() => null);
  if (browser) {
    try {
      await browser.close();
      evidence.cleanup.browser = "stopped";
    } catch (e) {
      evidence.cleanup.browser = e.message;
    }
  }
  try {
    if (client.generation) {
      const r = await client.stop(randomUUID(), client.generation, "ifIdle");
      evidence.cleanup.host = r.state;
      if (r.state === "completed") {
        for (let i = 0; i < 300 && alive(hostPid); i++)
          await new Promise((r) => setTimeout(r, 100));
        evidence.cleanup.hostPidExited = !alive(hostPid);
      }
    }
  } catch (e) {
    evidence.cleanup.hostError = e.message;
  } finally {
    client.close();
  }
  attachment?.close();
  if (evidence.cleanup.host === "completed" && evidence.cleanup.hostPidExited) {
    try {
      await assertApplicationStopped(binary, { ...process.env, HOME: user }, { hostPid });
      evidence.cleanup.inventory = "stopped";
      evidence.cleanup.keychain = await cleanupSyntheticHostKeychain(home, root);
    } catch (e) {
      evidence.cleanup.inventory = e.message;
    }
  }
  evidence.cleanup.markerUnchanged =
    (await readFile(marker, "utf8")) === "synthetic legacy state; no cleanup receipt\n";
  if (
    JSON.parse(await readFile(join(gui, "renderer/dist/verification-build.json"), "utf8"))
      .inputHash !== evidence.rendererInputHash
  )
    evidence.error ??= { message: "Renderer identity changed during run" };
  if (sha(await readFile(binary)) !== actualSha)
    evidence.error ??= { message: "Core changed during run" };
  if (
    !evidence.error &&
    (evidence.cleanup.browser !== "stopped" ||
      evidence.cleanup.host !== "completed" ||
      !evidence.cleanup.hostPidExited ||
      evidence.cleanup.inventory !== "stopped" ||
      !Array.isArray(evidence.cleanup.keychain) ||
      !evidence.cleanup.markerUnchanged)
  )
    evidence.error = { message: "cleanup incomplete" };
  if (evidence.error && !evidence.firstFailure)
    evidence.firstFailure = { stage: "cleanup", message: evidence.error.message };
  await save();
  console.log(
    JSON.stringify({
      root,
      diagnostic: evidence.diagnostic,
      checks: evidence.checks,
      statistics: evidence.statistics,
      firstFailure: evidence.firstFailure,
      reached: evidence.reached,
      unreached: evidence.unreached,
      error: evidence.error?.message,
      cleanup: evidence.cleanup,
    }),
  );
}
if (evidence.error) process.exitCode = 1;
