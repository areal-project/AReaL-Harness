const { app, BrowserWindow, WebContentsView, screen } = require("electron");
const { createServer } = require("node:http");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { join, resolve, relative } = require("node:path");
const os = require("node:os");
const { performance } = require("node:perf_hooks");

const root = resolve(__dirname, "../../../../..");
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.lastIndexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const output = resolve(option("--output", ".scratch/browser-navigation-benchmark"));
mkdirSync(output, { recursive: true });
const started = performance.now();
const now = () => performance.now() - started;
const result = {
  schemaVersion: 1,
  benchmarkVersion: "browser-navigation-native-v2",
  measurementKind: "native-command",
  runStatus: "running",
  startedAt: new Date().toISOString(),
  settings: {},
  provenance: {},
  cases: [],
  setupMs: null,
  teardownMs: null,
  error: null,
};
const save = () => writeFileSync(join(output, "RESULT.json"), JSON.stringify(result, null, 2));
const errorRecord = (error) => ({
  code: error.code ?? error.message,
  message: error.message,
  stack: error.stack,
});
const integer = (name, fallback, minimum, maximum) => {
  const value = Number(option(name, fallback));
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`invalid ${name}`);
  return value;
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = (directory) =>
  Object.fromEntries(
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return Object.entries(hashes(path));
      return /\.(cjs|mjs|ts|json)$/.test(entry.name)
        ? [[relative(root, path), sha256(readFileSync(path))]]
        : [];
    }),
  );
const git = (args) => execFileSync("git", args, { cwd: root });
const requests = [];
const timers = new Set();
const sockets = new Set();
let window, preview, server, watchdog;
save();

const oracle = (sample, dom, facts) => {
  const docs = facts.filter((item) => item.kind === "document");
  const images = facts.filter((item) => item.kind === "image");
  return [
    [
      sample.commandsStarted === 1 && sample.commandsFinished === 1,
      "exactly one completed command",
    ],
    [sample.actualOutcome === "confirmed", "native navigation confirmed"],
    [docs.length === 1 && docs[0].method === "GET", "exactly one document GET"],
    [images.length === 1 && images[0].method === "GET", "exactly one image GET"],
    [
      facts.every((item) => item.finishedAtMs !== null && !item.aborted),
      "all fixture responses completed",
    ],
    [dom?.url === sample.targetUrl, "target URL matches"],
    [
      dom?.marker === sample.trialId && dom?.title === sample.trialId,
      "independent DOM marker matches",
    ],
    [["interactive", "complete"].includes(dom?.readyState), "document is readable"],
  ].map(([passed, assertion]) => ({ assertion, passed }));
};

async function trial(sample) {
  sample.status = "running";
  save();
  const setupStarted = now();
  const key = JSON.stringify(["native-benchmark", "project", "thread", sample.trialId]);
  let page;
  try {
    page = preview.lifecycle.create(key, "project", "thread", {
      id: sample.trialId,
      origin: "agent",
    });
    const contents = page.view.webContents;
    page.view.setBounds({ x: 0, y: 0, width: 640, height: 480 });
    await contents.loadURL("about:blank");
    await preview.control.claim("project", "thread", sample.trialId);
    sample.setupMs = now() - setupStarted;
    const actualTrialId = sample.fault === "wrong" ? `${sample.trialId}-wrong` : sample.trialId;
    const targetUrl = sample.targetUrl.replace(sample.trialId, actualTrialId);
    const request = {
      coreInstanceId: "native-benchmark",
      coreGeneration: 1,
      projectId: "project",
      threadId: "thread",
      turnId: sample.trialId,
      callId: randomUUID(),
      requestId: randomUUID(),
      operation: sample.dialect === "legacy" ? "navigate" : "command",
      pageId: page.id,
      browserHostId: preview.browserHostId,
      hostGeneration: preview.hostGeneration,
      pageGeneration: page.pageGeneration,
      controlEpoch: page.controlEpoch,
      workspacePath: result.provenance.workspace,
      parameters:
        sample.dialect === "legacy"
          ? { pageId: page.id, url: targetUrl }
          : { pageId: page.id, command: { method: "navigate", url: targetUrl } },
    };
    contents.on("dom-ready", () => {
      sample.observations.domReadyAtMs ??= now();
    });
    const taskStarted = now();
    sample.observations.taskStartedAtMs = taskStarted;
    try {
      if (sample.fault !== "skipped") {
        sample.commandsStarted++;
        const prepareStarted = now();
        const prepared = await preview.prepare({ ...request, phase: "prepare" });
        sample.prepareMs = now() - prepareStarted;
        const executeStarted = now();
        const response = await preview.execute({
          ...request,
          phase: "execute",
          browserApproval: { plan: prepared.plan },
        });
        sample.executeMs = now() - executeStarted;
        sample.commandsFinished++;
        sample.responseBytes = Buffer.byteLength(JSON.stringify(response));
        sample.actualOutcome =
          sample.dialect === "legacy"
            ? response.dispatch
            : response.commandResult.ok
              ? "confirmed"
              : response.commandResult.error?.code;
        sample.observations.response = response;
        if (sample.actualOutcome !== "confirmed") sample.toolFailureCount++;
      }
    } catch (error) {
      sample.toolFailureCount++;
      sample.error = errorRecord(error);
      sample.actualOutcome = error.message.includes("unknown") ? "unknown" : "not_sent";
    }
    sample.observations.executeReturnedAtMs = now();
    sample.totalMs = sample.caseMs = now() - taskStarted;
    const oracleStarted = now();
    const domRead = await contents.debugger.sendCommand("Runtime.evaluate", {
      expression: `({url:location.href,title:document.title,marker:document.querySelector('#trial')?.textContent,readyState:document.readyState,imageComplete:document.querySelector('img')?.complete})`,
      returnByValue: true,
    });
    sample.observations.dom = domRead.result.value;
    sample.observations.domReadAtMs = now();
    if (sample.fault === "duplicate") await contents.loadURL(targetUrl);
    const deadline = now() + result.settings.siteDelayMs + 5000;
    if (sample.commandsStarted > 0) {
      while (
        !requests.some((item) => item.trialId === actualTrialId && item.kind === "image") ||
        requests.some(
          (item) => item.trialId === actualTrialId && item.finishedAtMs === null && !item.aborted,
        )
      ) {
        if (now() > deadline) throw new Error("fixture response deadline");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
    }
    const facts = requests
      .filter((item) => item.trialId === sample.trialId)
      .map((item) => ({ ...item }));
    sample.observations.requests = facts;
    sample.siteRequests = facts.length;
    sample.documentRequests = facts.filter((item) => item.kind === "document").length;
    sample.resourceRequests = facts.filter((item) => item.kind === "image").length;
    sample.assertions = oracle(sample, sample.observations.dom, facts);
    sample.oracleMs = now() - oracleStarted;
    sample.status =
      sample.assertions.every((item) => item.passed) && !sample.error ? "passed" : "failed";
    if (sample.status === "failed" && !sample.error)
      sample.error = {
        code: "oracle_failed",
        message: sample.assertions
          .filter((item) => !item.passed)
          .map((item) => item.assertion)
          .join("; "),
      };
  } catch (error) {
    sample.status = "failed";
    sample.error = errorRecord(error);
  } finally {
    const cleanupStarted = now();
    if (page) preview.lifecycle.release(key);
    sample.cleanupMs = now() - cleanupStarted;
    sample.observations.allTrialRequests = requests
      .filter((item) => item.trialId.startsWith(sample.trialId))
      .map((item) => ({ ...item }));
    save();
    console.log(
      `${sample.status} ${sample.id} ${sample.trialId} ${sample.totalMs ?? "unmeasured"}ms`,
    );
  }
}

async function main() {
  result.settings = {
    samples: integer("--samples", 5, 1, 100),
    warmup: integer("--warmup", 1, 0, 20),
    siteDelayMs: integer("--site-delay-ms", 2000, 1, 8000),
    seed: integer("--seed", 73921, 0, 2147483647),
    sensitivity: argv.includes("--sensitivity"),
    viewport: { width: 640, height: 480 },
  };
  const schedule = (scenario, dialect, index, warmup, fault = null) => {
    const trialId = `s${result.settings.seed}-${result.cases.length}-${scenario}-${dialect}${fault ? `-${fault}` : ""}`;
    result.cases.push({
      id: fault ? `sensitivity-${fault}` : `${scenario}-${dialect}`,
      trialId,
      scenario,
      dialect,
      sampleIndex: index,
      warmup,
      sensitivity: fault !== null,
      fault,
      status: "planned",
      targetUrl: null,
      caseMs: null,
      totalMs: null,
      prepareMs: null,
      executeMs: null,
      oracleMs: null,
      cleanupMs: null,
      commandsPlanned: 1,
      commandsStarted: 0,
      commandsFinished: 0,
      responseBytes: 0,
      toolFailureCount: 0,
      siteRequests: 0,
      documentRequests: 0,
      resourceRequests: 0,
      actualOutcome: null,
      observations: {},
      error: null,
    });
  };
  for (const warmup of [true, false]) {
    const count = warmup ? result.settings.warmup : result.settings.samples;
    for (let index = 0; index < count; index++)
      for (const scenario of ["ordinary", "slow-image"]) {
        const order =
          (index + result.settings.seed) % 2 ? ["command", "legacy"] : ["legacy", "command"];
        for (const dialect of order) schedule(scenario, dialect, index, warmup);
      }
  }
  if (result.settings.sensitivity)
    for (const fault of ["skipped", "wrong", "duplicate", "timer-delay"])
      schedule("ordinary", "command", 0, false, fault);
  result.plannedCases = result.cases.map(({ id, sampleIndex, warmup, sensitivity, trialId }) => ({
    id,
    sampleIndex,
    warmup,
    sensitivity,
    trialId,
  }));
  result.workload = {
    requiredCaseIds: [
      "ordinary-legacy",
      "ordinary-command",
      "slow-image-legacy",
      "slow-image-command",
    ],
    ...result.settings,
  };
  save();
  const scratch = mkdtempSync(join(os.tmpdir(), "areal-navigation-benchmark-"));
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  app.setPath("userData", join(scratch, "user"));
  const sourceHashes = {
    ...hashes(join(root, "clients/gui/app/src/core/preview-native")),
    ...hashes(join(root, "clients/gui/app/src/core/preview")),
    ...hashes(join(root, "clients/gui/packages/browser-automation/src")),
  };
  for (const path of [
    "clients/gui/app/src/core/preview.cjs",
    "clients/gui/app/src/core/browser-navigation.cjs",
    "clients/gui/pnpm-lock.yaml",
  ])
    sourceHashes[path] = sha256(readFileSync(join(root, path)));
  sourceHashes[relative(root, __filename)] = sha256(readFileSync(__filename));
  sourceHashes[relative(root, join(__dirname, "navigation-benchmark-run.mjs"))] = sha256(
    readFileSync(join(__dirname, "navigation-benchmark-run.mjs")),
  );
  result.provenance = {
    sourceHead: git(["rev-parse", "HEAD"]).toString().trim(),
    diffSHA256: sha256(git(["diff", "HEAD", "--binary"])),
    dirtyStatus: git(["status", "--short"]).toString(),
    scriptSHA256: sha256(readFileSync(__filename)),
    fixtureSHA256: sha256(readFileSync(__filename)),
    launcherSHA256: sha256(readFileSync(join(__dirname, "navigation-benchmark-run.mjs"))),
    sourceHashes,
    distHashes: hashes(join(root, "clients/gui/packages/browser-automation/dist")),
    browserAutomationDistSHA256: sha256(
      readFileSync(join(root, "clients/gui/packages/browser-automation/dist/electron.cjs")),
    ),
    electronExecutable: process.execPath,
    electronExecutableSHA256: sha256(readFileSync(process.execPath)),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    playwrightPath: require.resolve("playwright-core"),
    playwright: require("playwright-core/package.json").version,
    os: `${os.platform()} ${os.release()}`,
    arch: process.arch,
    cpuCount: os.cpus().length,
    cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))],
    loadAverageBefore: os.loadavg(),
    argv,
    scratch,
    workspace,
    userData: app.getPath("userData"),
  };
  await app.whenReady();
  server = createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    const match = /^\/(document|image)\/([a-z0-9-]+)$/.exec(url.pathname);
    if (!match) {
      response.writeHead(204);
      response.end();
      return;
    }
    const [, kind, trialId] = match;
    const fact = {
      kind: kind === "document" ? "document" : "image",
      trialId,
      method: request.method,
      url: request.url,
      requestedAtMs: now(),
      responseStartedAtMs: null,
      finishedAtMs: null,
      aborted: false,
    };
    requests.push(fact);
    response.on("finish", () => {
      fact.finishedAtMs = now();
    });
    response.on("close", () => {
      if (fact.finishedAtMs === null) fact.aborted = true;
    });
    response.setHeader("cache-control", "no-store");
    const send = () => {
      fact.responseStartedAtMs = now();
      if (kind === "document") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(
          `<!doctype html><title>${trialId}</title><p id="trial">${trialId}</p><img src="/image/${trialId}?delay=${url.searchParams.get("delay") || "0"}"><link rel="icon" href="data:,">`,
        );
        return;
      }
      response.setHeader("content-type", "image/svg+xml");
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="green"/></svg>',
      );
    };
    const delay =
      kind === "image"
        ? Number(url.searchParams.get("delay"))
        : trialId.includes("timer-delay")
          ? result.settings.siteDelayMs
          : 0;
    if (!delay) {
      send();
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!response.destroyed) send();
    }, delay);
    timers.add(timer);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const origin = `http://browser-fixture.localhost:${server.address().port}`;
  for (const sample of result.cases)
    sample.targetUrl = `${origin}/document/${sample.trialId}?delay=${sample.scenario === "slow-image" ? result.settings.siteDelayMs : 0}`;
  window = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL("data:text/html,<title>Navigation benchmark owner</title>");
  const { CorePreview } = require("../../../app/src/core/preview.cjs");
  preview = new CorePreview(
    window,
    WebContentsView,
    () => true,
    () => ({}),
    () => "native-benchmark",
  );
  result.provenance.displays = screen
    .getAllDisplays()
    .map((display) => ({ size: display.size, scaleFactor: display.scaleFactor }));
  result.provenance.ownerVisible = window.isVisible();
  result.provenance.ownerFocused = window.isFocused();
  result.setupMs = now();
  save();
  watchdog = setTimeout(
    () => {
      result.error = { message: "native benchmark deadline" };
      result.runStatus = "failed";
      save();
      app.exit(1);
    },
    9 * 60 * 1000,
  );
  watchdog.unref();
  for (const sample of result.cases) await trial(sample);
  if (result.settings.sensitivity) {
    const duration = (scenario) =>
      result.cases
        .filter(
          (sample) =>
            !sample.sensitivity &&
            !sample.warmup &&
            sample.scenario === scenario &&
            sample.status === "passed",
        )
        .map((sample) => sample.observations.requests.find((item) => item.kind === "image"))
        .map((item) => item.finishedAtMs - item.requestedAtMs)
        .sort((a, b) => a - b);
    const slow = duration("slow-image"),
      ordinary = duration("ordinary");
    const delayedTask = result.cases.find((sample) => sample.fault === "timer-delay");
    const median = (values) => (values.length ? values[Math.floor(values.length / 2)] : null);
    result.sensitivity = {
      oracleRejections: result.cases
        .filter((sample) => sample.sensitivity && sample.fault !== "timer-delay")
        .map((sample) => ({
          fault: sample.fault,
          passed: sample.status === "failed" && sample.error?.code === "oracle_failed",
        })),
      taskTimer: {
        observedMs: delayedTask?.caseMs,
        expectedDelayMs: result.settings.siteDelayMs,
        passed:
          delayedTask?.status === "passed" &&
          delayedTask.caseMs >= result.settings.siteDelayMs * 0.8,
      },
      timer: {
        slowResourceMedianMs: median(slow),
        ordinaryResourceMedianMs: median(ordinary),
        expectedDelayMs: result.settings.siteDelayMs,
        passed:
          slow.length > 0 &&
          ordinary.length > 0 &&
          median(slow) - median(ordinary) >= result.settings.siteDelayMs * 0.8,
      },
      interpretation: "Fixture timing and oracle sensitivity only; not an optimization result",
    };
  }
  const failed = result.cases.some((sample) => !sample.sensitivity && sample.status !== "passed");
  const sensitivityFailed =
    result.sensitivity &&
    (!result.sensitivity.timer.passed ||
      !result.sensitivity.taskTimer.passed ||
      result.sensitivity.oracleRejections.some((item) => !item.passed));
  result.runStatus = failed || sensitivityFailed ? "failed" : "completed";
}

main()
  .catch((error) => {
    result.error = errorRecord(error);
    result.runStatus = result.setupMs === null ? "blocked" : "failed";
  })
  .finally(async () => {
    const teardownStarted = now();
    try {
      await preview?.dispose();
    } catch (error) {
      result.cleanupError = errorRecord(error);
      result.runStatus = "failed";
    }
    if (window && !window.isDestroyed()) window.destroy();
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (server?.listening) await new Promise((resolveClose) => server.close(resolveClose));
    clearTimeout(watchdog);
    for (const sample of result.cases) if (sample.status === "planned") sample.status = "not_run";
    result.teardownMs = now() - teardownStarted;
    result.provenance.loadAverageAfter = os.loadavg();
    if (result.provenance.sourceHashes) {
      const changed = Object.entries({
        ...result.provenance.sourceHashes,
        ...result.provenance.distHashes,
      })
        .filter(([path, expected]) => {
          try {
            return sha256(readFileSync(join(root, path))) !== expected;
          } catch {
            return true;
          }
        })
        .map(([path]) => path);
      result.provenance.frozenInputs = { unchanged: changed.length === 0, changed };
      if (changed.length) result.runStatus = "failed";
    }
    result.finishedAt = new Date().toISOString();
    result.processMs = now();
    save();
    console.log(`${result.runStatus} ${join(output, "RESULT.json")}`);
    app.exit(result.runStatus === "completed" ? 0 : 1);
  });
