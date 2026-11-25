import { makeTempDir } from "./support/temp.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { connect } from "../../../examples/desktop-api/client.mjs";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  stopAndAssertFixtureHost,
} from "./application-cleanup.mjs";
import { applicationFixture } from "./application-fixture.mjs";
import { respondToSessionName } from "./model-fixture.mjs";
import { readDesktopSnapshot } from "./support/desktop-fixture.mjs";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  root = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { HostClient } = require("@areal/client/node");
const { readOfflineHostReceipt } = require("../app/src/core/host-lifecycle.cjs");
const { _electron: electron, chromium } = require("playwright-core");
const sourceBinary = process.env.AREAL_CORE_BIN;
assert.ok(sourceBinary, "AREAL_CORE_BIN is required");
assert.ok(
  !process.env.AREAL_REOPEN_LEGACY,
  "Detached legacy migration requires the explicit legacy recovery runner",
);
const readingSlice = process.argv.includes("--reading-slice"),
  manualReading = readingSlice && process.argv.includes("--manual");
const replacement = process.env.AREAL_REOPEN_REPLACEMENT_BIN;
assert.ok(!readingSlice || !replacement, "Reading continuity does not replace the Core binary");
const force = process.env.AREAL_REOPEN_FORCE_GUI === "1";
const scratch = await makeTempDir("ar-"),
  workspace = join(scratch, "workspace"),
  config = join(scratch, "config.toml");
let binary = sourceBinary;
if (!sourceBinary.startsWith(join(root, ".local/dev-bin/"))) {
  // CI 传入 target/debug/areal 时复制到本次隔离槽位，避免 utimes/replace 修改共享构建产物。
  const privateBin = join(scratch, "bin");
  await mkdir(privateBin, { recursive: true });
  const sourceDir = dirname(sourceBinary);
  const coreName = basename(sourceBinary);
  for (const name of [
    coreName,
    "areal-runtime",
    "areal-runtime-fs",
    "areal-runtime-reaper",
    "verification-build.json",
  ]) {
    const from = join(sourceDir, name);
    const dest = join(privateBin, name);
    const info = await lstat(from).catch(() => null);
    if (!info?.isFile()) continue;
    await copyFile(from, dest);
    await chmod(dest, info.mode & 0o777);
  }
  const shells = join(sourceDir, "shells");
  if ((await lstat(shells).catch(() => null))?.isDirectory()) {
    await cp(shells, join(privateBin, "shells"), { recursive: true });
  }
  binary = join(privateBin, coreName);
}
const originalStat = await lstat(binary),
  originalHash = createHash("sha256")
    .update(await readFile(binary))
    .digest("hex");
assert.ok(
  originalStat.isFile() && originalStat.nlink === 1 && (await realpath(binary)) === binary,
  "The private fixed binary must be a regular copy",
);
if (replacement) {
  assert.notEqual(await realpath(replacement), binary);
  assert.match(
    execFileSync("file", ["-b", replacement], { encoding: "utf8" }),
    /Mach-O.*executable/,
  );
  assert.notEqual(
    createHash("sha256")
      .update(await readFile(replacement))
      .digest("hex"),
    originalHash,
  );
}
await mkdir(workspace);
await mkdir(join(scratch, "user/.areal"), { recursive: true });
execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
const requests = [],
  modelRequests = [],
  held = new Set(),
  checks = [],
  errors = [],
  generations = [],
  attachments = [],
  readingEvidence = [];
const readingHistory =
  "COMPLETED_HISTORY\n\n" +
  Array.from(
    { length: 48 },
    (_, index) =>
      `【恢复第${String(index + 1).padStart(2, "0")}段】同一个任务正在继续执行。阅读这一段时，请保留当前项目、已完成的回复和下一条未发送的草稿。刷新页面或者恢复意外退出的页面之后，应继续从这一段阅读，无需再次发送任务。段落的编号用于核对阅读位置，正文换行与窗口宽度共同决定实际的阅读偏移。`,
  ).join("\n\n");
checks.push = (...items) => {
  console.log("CHECK", ...items);
  return Array.prototype.push.apply(checks, items);
};
const model = createServer(async (request, response) => {
  try {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw),
      naming = respondToSessionName(body, response);
    modelRequests.push({ kind: naming ? "naming" : "work", body });
    if (naming) return;
    requests.push(body);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const text =
      requests.length === 1 ? (readingSlice ? readingHistory : "COMPLETED_HISTORY") : "REOPEN_HELD";
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    );
    if (requests.length === 1)
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
    else {
      held.add(response);
      response.on("close", () => held.delete(response));
    }
  } catch (error) {
    errors.push(error.stack);
    response.destroy();
  }
});
await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
await writeFile(
  config,
  `schema_version=1\n[model]\ncatalog_version=1\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint="http://127.0.0.1:${model.address().port}/v1/chat/completions"\nmodels=[{id="fixture",enabled=true}]\n`,
);
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/^(AREAL_|OPENAI_|ANTHROPIC_)/.test(key) || key === "ELECTRON_RUN_AS_NODE") delete env[key];
Object.assign(env, {
  HOME: join(scratch, "user"),
  AREAL_CORE_BIN: binary,
  AREAL_CORE_CONFIG: config,
  AREAL_GUI_USER_DATA: join(scratch, "electron"),
  AREAL_CORE_HOME: join(scratch, "core"),
  AREAL_CORE_USER_HOME: join(scratch, "user"),
  AREAL_HARNESS_HOME: join(scratch, "harness"),
  AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
});
const application = await applicationFixture(gui, join(scratch, "app"));
const backup = replacement ? join(dirname(binary), `.reopen-original-${process.pid}`) : null;
const staged = join(dirname(binary), `.reopen-staged-${process.pid}`);
if (backup) await copyFile(binary, backup);
const restoreBinary = async () => {
  if (
    backup &&
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex") !== originalHash
  ) {
    assert.equal(
      createHash("sha256")
        .update(await readFile(backup))
        .digest("hex"),
      originalHash,
    );
    await copyFile(backup, staged);
    await chmod(staged, originalStat.mode & 0o777);
    await rename(staged, binary);
  }
  assert.equal(
    createHash("sha256")
      .update(await readFile(binary))
      .digest("hex"),
    originalHash,
  );
  await utimes(binary, originalStat.atime, originalStat.mtime);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (read, label, ms = 90000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Timeout: ${label}`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
const records = async () => {
  let names;
  try {
    names = await readdir(join(scratch, "registry/services"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return (
    await Promise.all(
      names.map((name) =>
        readFile(join(scratch, "registry/services", name, "service.json"), "utf8")
          .then(JSON.parse)
          .catch((error) => {
            if (error.code === "ENOENT") return null;
            throw error;
          }),
      ),
    )
  ).filter(Boolean);
};
const hostPids = new Set();
const hostStops = [];
const stoppingGenerations = new Set();
const readMetadata = () =>
  readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
const metadata = async () => {
  const value = await readMetadata();
  assert.ok(value, "fixture Host is running");
  const { pid, hostId, generation } = value;
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  hostPids.add(pid);
  const host = new HostClient();
  try {
    await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
    assert.equal(host.hostId, hostId);
    assert.equal(host.generation, generation);
    const backend = await host.request("backend.status", {});
    assert.equal(backend.owned, false);
    assert.equal(backend.service, null);
    return { pid, hostId, generation };
  } finally {
    host.close();
  }
};
const identity = async () => {
  const host = await metadata(),
    services = await records();
  const processes = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? { pid: Number(match[1]), parent: Number(match[2]), executable: basename(match[3]) }
        : null;
    })
    .filter(Boolean);
  const descendants = new Set(services.map((service) => service.hostPid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of processes)
      if (descendants.has(row.parent) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
  }
  const runtimePids = processes
    .filter((row) => descendants.has(row.pid) && row.executable === "areal-runtime")
    .map((row) => row.pid)
    .sort((a, b) => a - b);
  for (const pid of [
    processHandle.pid,
    host.pid,
    ...services.flatMap((service) => [service.hostPid, service.corePid]),
    ...runtimePids,
  ])
    assert.ok(alive(pid), `owned process ${pid} is alive`);
  return {
    mainPid: processHandle.pid,
    host,
    services,
    runtimePids,
  };
};
let app,
  page,
  rendererConnection,
  processHandle,
  observer,
  originalMetadata,
  projectId,
  threadId,
  passed = false;
const state = () => readDesktopSnapshot(page);
const workbench = () => page.getByTestId("areal-workbench");
const observeCore = async ({ activate = false } = {}) => {
  const host = new HostClient();
  try {
    await host.connect(env.AREAL_HARNESS_SERVICE_HOME);
    const match = (await host.status()).projects.find(
      ({ registration }) => registration.workspace === workspace,
    );
    if (!match) return false;
    const service =
      match.service ??
      (activate && (await host.ensureProject(randomUUID(), match.registration.projectId)).service);
    if (!service) return false;
    observer = await connect(service.endpoint, service.authFile);
    return true;
  } finally {
    host.close();
  }
};
const readThread = async () =>
  (await observer.call("thread/read", { threadId, includeTurns: true })).thread;
const launch = async () => {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [application.path],
    env,
    timeout: 120000,
  });
  processHandle = app.process();
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.stack));
  await page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]').waitFor({
    timeout: 120000,
  });
  await until(async () => (await state()).connection?.state === "ready", "application ready");
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async (...args) => ({
      response: args
        .at(-1)
        .buttons?.some((button) => ["取消任务并停止", "停止任务并退出"].includes(button))
        ? 1
        : (args.at(-1).cancelId ?? 0),
    });
  });
};
const quit = async () => {
  if (!app) return;
  await app.evaluate(({ app }) => app.quit());
  await closeSmokeApplication(app);
  app = null;
};
const originalStopReference = async ({ hostId, generation }) => {
  const control = await readFile(join(env.AREAL_GUI_USER_DATA, "service-control.json"), "utf8")
    .then(JSON.parse)
    .catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  return control?.references.find(
    (entry) =>
      entry.kind === "stopHost" && entry.hostId === hostId && entry.generation === generation,
  );
};
const confirmGuiStop = async (host) => {
  const reference = await originalStopReference(host);
  assert.ok(reference, "GUI persisted the original Host stop request");
  stoppingGenerations.add(host.generation);
  const receipt = await readOfflineHostReceipt(binary, reference);
  assert.equal(receipt?.state, "completed", "the original GUI stop must be confirmed");
  hostStops.push(receipt);
  await assertApplicationStopped(binary, env, { pid: processHandle.pid, hostPid: host.pid });
};
const quitAndObserveIdleRelease = async () => {
  const host = await metadata();
  observer?.socket.close();
  observer = null;
  await quit();
  // 空闲退出交给 Host 自己回收。只核对它登记的原停止号，避免与回收竞跑。
  const policy = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/release.json"), "utf8"),
  );
  assert.equal(policy.generation, host.generation);
  stoppingGenerations.add(host.generation);
  const reference = {
    kind: "stopHost",
    requestId: policy.stopRequestId,
    hostId: host.hostId,
    generation: host.generation,
    home: env.AREAL_HARNESS_SERVICE_HOME,
    strategy: "ifIdle",
  };
  await assertApplicationStopped(binary, env, { pid: processHandle.pid, hostPid: host.pid });
  const receipt = await readOfflineHostReceipt(binary, reference);
  assert.equal(receipt?.state, "completed", "Host confirms its original idle release stop");
  hostStops.push(receipt);
};
const finishFixtureHost = async () => {
  observer?.socket.close();
  observer = null;
  const host = await readMetadata();
  if (!host || stoppingGenerations.has(host.generation)) return;
  hostPids.add(host.pid);
  if (await originalStopReference(host)) return confirmGuiStop(host);
  stoppingGenerations.add(host.generation);
  const evidence = join(scratch, host.generation);
  await mkdir(evidence, { recursive: true });
  hostStops.push(await stopAndAssertFixtureHost(binary, env, evidence, { pid: processHandle.pid }));
};
const quiescent = async () => {
  await until(
    async () =>
      (await records()).every((service) => !alive(service.hostPid) && !alive(service.corePid)),
    "old engine processes exit",
  );
  await until(
    () => [...hostPids].every((pid) => !alive(pid)),
    "all observed Host generations exit",
  );
};
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const builtEntry = await readFile(join(gui, "renderer/dist/index.html"), "utf8");
const entryAssets = [...builtEntry.matchAll(/(?:src|href)="\.\/(assets\/[^"]+\.(?:js|css))"/g)].map(
  (match) => "renderer/dist/" + match[1],
);
const sourcePaths = [
  "app/src/core/main.cjs",
  "app/src/core/native-host-transport.ts",
  "app/src/core/service-client.cjs",
  "../../core/host/src/workbench_frontend.rs",
  "../../core/host/src/workbench_submissions.rs",
  "renderer/src/Messages.tsx",
  "scripts/service-reopen-smoke.mjs",
  "scripts/model-fixture.mjs",
  "renderer/dist/index.html",
  ...entryAssets,
];
const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(join(gui, path)))
        .digest("hex"),
    ]),
  ),
);
const sourceHash = createHash("sha256")
  .update(execFileSync("git", ["diff", "HEAD"], { cwd: root, maxBuffer: 16 * 1024 * 1024 }))
  .digest("hex");
console.log("Service reopen evidence:", scratch);
try {
  await launch();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "常规", exact: true }).click();
  await page.getByRole("switch", { name: "预测下一条提示词", exact: true }).uncheck();
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await app.evaluate(({ dialog }, workspace) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [workspace] });
  }, workspace);
  await page.getByRole("button", { name: "不在项目中工作", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  const project = await until(
    async () => (await state()).projects.find((candidate) => candidate.root === workspace),
    "workspace registered",
  );
  projectId = project.id;
  await until(
    async () => (await workbench().getAttribute("data-project-id")) === projectId,
    "new workspace selected",
  );
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("tab", { name: "fixture", exact: true }).click();
  await page.locator('[data-model-value="fixture/fixture"]').getByRole("radio").click();
  await page.keyboard.press("Escape");
  await page.getByTestId("chat-input").fill("complete history");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  threadId = await until(
    () => page.getByTestId("areal-workbench").getAttribute("data-thread-id"),
    "thread created",
  );
  await until(observeCore, "canonical Core project running");
  await until(
    async () => (await readThread()).turns.at(-1)?.status === "completed",
    "first turn completes",
  );
  await page.getByTestId("chat-input").fill("hold reopen");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until(() => held.size === 1, "held second turn");
  await until(
    async () => (await readThread())?.turns.at(-1)?.status === "inProgress",
    "second turn running",
  );
  originalMetadata = await metadata();
  const attachedThread = structuredClone(await readThread()),
    attachedTurnId = attachedThread.turns.at(-1).id;
  assert.equal(requests.length, 2);
  const heldResponse = [...held][0];
  assert.ok(heldResponse?.socket, "the second work request is still streaming");
  const connection = {
    workRequest: 2,
    localPort: heldResponse.socket.localPort,
    remotePort: heldResponse.socket.remotePort,
  };
  const originalIdentity = await identity();
  const draft = "PRESERVED_REOPEN_DRAFT";
  await page.getByTestId("chat-input").fill(draft);
  await sleep(300);
  const streamedParts = ["REOPEN_HELD"];
  const observeAttachment = async (label) => {
    await page.getByTestId("areal-workbench").waitFor();
    await until(
      async () =>
        (await page.getByTestId("areal-workbench").getAttribute("data-thread-id")) === threadId,
      `${label} restores selected thread`,
    );
    assert.equal(
      await page.getByTestId("areal-workbench").getAttribute("data-project-id"),
      projectId,
    );
    const history = page.locator(
      `[data-turn-id="${attachedThread.turns[0].id}"] .assistant-message .conversation-markdown`,
    );
    await until(
      async () => (await history.innerText()).includes("COMPLETED_HISTORY"),
      `${label} renders completed history`,
    );
    const active = page.locator(`[data-turn-id="${attachedTurnId}"]`),
      answer = active.locator(".assistant-message .conversation-markdown");
    await until(async () => {
      const text = await answer.innerText();
      return streamedParts.every((part) => text.includes(part));
    }, `${label} renders original held text`);
    await active.getByTestId("turn-activity").waitFor();
    assert.equal(await active.getAttribute("data-turn-status"), "inProgress");
    assert.equal(await page.getByTestId("chat-input").innerText(), draft);
    assert.equal(await page.locator(".message-column [data-turn-id]").count(), 2);
    assert.equal(await page.locator(".message-column .user-message").count(), 2);
    const snapshotThread = await readThread();
    assert.deepEqual(
      snapshotThread.turns.map((turn) => turn.id),
      attachedThread.turns.map((turn) => turn.id),
    );
    assert.equal(snapshotThread.turns.at(-1).status, "inProgress");
    assert.equal(requests.length, 2);
    assert.equal(held.size, 1);
    assert.ok(held.has(heldResponse));
    assert.equal(heldResponse.destroyed, false);
    assert.equal(heldResponse.writableEnded, false);
    assert.deepEqual(
      {
        workRequest: 2,
        localPort: heldResponse.socket.localPort,
        remotePort: heldResponse.socket.remotePort,
      },
      connection,
    );
    const currentIdentity = await identity();
    assert.deepEqual(
      currentIdentity,
      originalIdentity,
      `${label} retains owned processes and generations`,
    );
    const rendererPid = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
    );
    const screenshot = `${label}.png`;
    await page.screenshot({ path: join(scratch, screenshot) });
    attachments.push({
      label,
      projectId,
      threadId,
      turnId: attachedTurnId,
      identity: currentIdentity,
      rendererPid,
      connection,
      text: await answer.innerText(),
      status: snapshotThread.turns.at(-1).status,
      draft: await page.getByTestId("chat-input").innerText(),
      screenshot,
    });
  };
  const readView = () =>
    page.evaluate(() => {
      const viewport = document.querySelector(".messages"),
        box = viewport.getBoundingClientRect();
      const paragraph = [
        ...viewport.querySelectorAll(".assistant-message .conversation-markdown p"),
      ].find(
        (element) =>
          /【恢复第\d+段】/.test(element.textContent) &&
          element.getBoundingClientRect().bottom > box.top &&
          element.getBoundingClientRect().top < box.bottom,
      );
      return {
        turnId: paragraph?.closest("[data-turn-id]")?.dataset.turnId,
        itemId: paragraph?.closest("[data-side-item-id]")?.dataset.sideItemId,
        paragraph: paragraph?.textContent.match(/【恢复第\d+段】/)?.[0] ?? null,
        offset: paragraph ? paragraph.getBoundingClientRect().top - box.top : null,
        scrollTop: viewport.scrollTop,
        remaining: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      };
    });
  const settledView = async () => {
    let previous,
      stable = 0;
    return until(
      async () => {
        await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        const current = await readView();
        stable =
          previous &&
          current.paragraph === previous.paragraph &&
          current.itemId === previous.itemId &&
          Math.abs(current.scrollTop - previous.scrollTop) < 0.5 &&
          Math.abs(current.remaining - previous.remaining) < 0.5
            ? stable + 1
            : 0;
        previous = current;
        return stable >= 3 && current;
      },
      "reading viewport settles",
      20000,
    );
  };
  const expectReading = async (before, label) => {
    const matches = (value) =>
      value.turnId === before.turnId &&
      value.itemId === before.itemId &&
      value.paragraph === before.paragraph &&
      Math.abs(value.offset - before.offset) <= 2 &&
      value.remaining > 500;
    try {
      await until(
        async () => matches(await readView()),
        `${label} restores the same paragraph and offset`,
        20000,
      );
    } finally {
      readingEvidence.push({ label, expected: before, observed: await readView() });
    }
    assert.ok(
      matches(await settledView()),
      `${label} retains semantic history position within 2px after layout settles`,
    );
    await page
      .getByRole("button", { name: "滚动到底部", exact: true })
      .waitFor({ state: "visible" });
  };
  const prepareReading = async (condition, label) => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "外观", exact: true }).click();
    await page.getByRole("radio", { name: condition.dark ? "深色" : "浅色", exact: true }).click();
    await page
      .getByRole("spinbutton", { name: "界面字号", exact: true })
      .fill(String(condition.font));
    const content = page.getByRole("spinbutton", { name: "内容字号", exact: true });
    if (!(await content.isVisible()))
      await page.locator("summary").filter({ hasText: "阅读与代码" }).click();
    await content.fill(String(condition.font));
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 960),
      condition.width,
    );
    await page.getByRole("button", { name: "返回应用", exact: true }).click();
    await page.waitForFunction(
      (condition) =>
        document.documentElement.classList.contains("dark") === condition.dark &&
        getComputedStyle(document.documentElement)
          .getPropertyValue("--content-font-size")
          .trim() === `${condition.font}px` &&
        getComputedStyle(document.documentElement).getPropertyValue("--ui-font-size").trim() ===
          `${condition.font}px`,
      condition,
    );
    const viewport = page.locator(".messages"),
      box = await viewport.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0);
    const target = page
      .locator(`[data-turn-id="${attachedThread.turns[0].id}"] .conversation-markdown p`)
      .filter({ hasText: "【恢复第24段】" });
    const top = await target.evaluate((element) => element.getBoundingClientRect().top);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, top - box.y - 40);
    await until(async () => {
      const view = await readView();
      return view.paragraph && view.remaining > 500 && view.scrollTop > 0;
    }, "wheel reaches numbered history");
    const before = await settledView();
    assert.equal(
      before.turnId,
      attachedThread.turns[0].id,
      "reader is inside the completed first turn",
    );
    assert.ok(before.itemId && before.paragraph && before.remaining > 500);
    readingEvidence.push({ label: `${label}-before`, condition, observed: before });
    await page.screenshot({ path: join(scratch, `${label}-reading-before.png`) });
    return before;
  };
  const appendReading = async (label) => {
    const continuation = `READING_APPEND_${label.replaceAll("-", "_").toUpperCase()}`;
    const text =
      "\n\n" +
      Array.from(
        { length: 12 },
        (_, index) =>
          `${continuation}_${index + 1} 正在继续输出新的任务内容。新输出应出现在同一条回复中，已经离开末尾的读者继续阅读历史。只有主动返回最新内容后，后续输出才继续跟随。`,
      ).join("\n\n");
    heldResponse.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`,
    );
    streamedParts.push(continuation);
    await until(
      async () =>
        (
          await page
            .locator(`[data-turn-id="${attachedTurnId}"] .assistant-message .conversation-markdown`)
            .innerText()
        ).includes(`${continuation}_12`),
      `${label} streams through the original model connection`,
    );
  };
  const expectFollowing = async (label) => {
    await until(
      async () => (await readView()).remaining <= 2,
      `${label} follows the latest output`,
      20000,
    );
    const view = await settledView();
    assert.ok(view.remaining <= 2, `${label} remains at the tail after layout settles`);
    readingEvidence.push({ label, observed: view });
  };
  await observeAttachment("before-reload");
  for (const [index, label] of ["renderer-reload", "renderer-crash-reload"].entries()) {
    const before = readingSlice
      ? await prepareReading(
          index === 0
            ? { dark: false, font: 14, width: 1440 }
            : { dark: true, font: 18, width: 980 },
          label,
        )
      : null;
    if (label === "renderer-crash-reload") {
      await Promise.all([
        page.waitForEvent("crash"),
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
        ),
      ]);
      assert.deepEqual(
        await identity(),
        originalIdentity,
        "renderer crash retains the running application and engines",
      );
      assert.ok(held.has(heldResponse));
      assert.equal(requests.length, 2);
    }
    if (label === "renderer-crash-reload") {
      const documentUrl = await app.evaluate(async ({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        await new Promise((resolve) => {
          contents.once("did-finish-load", resolve);
          contents.reload();
        });
        return contents.getURL();
      });
      const [port] = (await readFile(join(scratch, "electron/DevToolsActivePort"), "utf8")).split(
        "\n",
      );
      rendererConnection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = rendererConnection
        .contexts()[0]
        .pages()
        .find((candidate) => candidate.url() === documentUrl);
      assert.ok(page, "fresh automation connection observes the recovered product document");
      page.setDefaultTimeout(20000);
      page.on("pageerror", (error) => errors.push(error.stack));
    } else await page.reload({ waitUntil: "domcontentloaded" });
    await observeAttachment(`${label}-reattached`);
    if (readingSlice) await expectReading(before, `${label}-reattached`);
    const continuation = `LIVE_AFTER_${label.replaceAll("-", "_").toUpperCase()}`;
    heldResponse.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `\n${continuation}` }, finish_reason: null }] })}\n\n`,
    );
    streamedParts.push(continuation);
    await observeAttachment(`${label}-continued`);
    if (readingSlice) {
      await appendReading(`${label}-while-reading`);
      await expectReading(before, `${label}-after-append`);
      const latest = page.getByRole("button", { name: "滚动到底部", exact: true });
      await latest.focus();
      assert.equal(await latest.evaluate((element) => element === document.activeElement), true);
      await page.keyboard.press("Enter");
      await expectFollowing(`${label}-keyboard-latest`);
      await appendReading(`${label}-following`);
      await expectFollowing(`${label}-following-append`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await observeAttachment(`${label}-following-reattached`);
      await expectFollowing(`${label}-following-reattached`);
      await appendReading(`${label}-following-after-reload`);
      await expectFollowing(`${label}-following-after-reload`);
      await observeAttachment(`${label}-following-continued`);
      checks.push(
        `${label} preserves the same completed-turn paragraph and offset through history hydration and streaming; keyboard return resumes following and following survives reload`,
      );
    }
    checks.push(
      `${label} reattaches the production App to the original live turn and model connection, retains history and draft, and renders a new continuation without replay`,
    );
  }
  heldResponse.end(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
  );
  await until(
    async () =>
      (await readThread())?.turns.find((turn) => turn.id === attachedTurnId)?.status ===
      "completed",
    "original attached turn completes",
  );
  await until(() => held.size === 0, "completed original model connection closes");
  const completed = page.locator(`[data-turn-id="${attachedTurnId}"]`);
  await until(async () => {
    const text = await completed
      .locator(".assistant-message-final .conversation-markdown")
      .innerText();
    return streamedParts.every((part) => text.includes(part));
  }, "App renders completed original response");
  assert.equal(await completed.getAttribute("data-turn-status"), "completed");
  assert.equal(await completed.locator(".assistant-message-final").count(), 1);
  assert.equal(await completed.getByTestId("turn-activity").count(), 0);
  assert.deepEqual(
    (await readThread()).turns.map((turn) => turn.id),
    attachedThread.turns.map((turn) => turn.id),
  );
  assert.equal(
    (await readThread()).turns.filter(
      (turn) => turn.id === attachedTurnId && turn.status === "completed",
    ).length,
    1,
  );
  assert.equal(await page.locator(".message-column .user-message").count(), 2);
  assert.equal(requests.length, 2);
  assert.deepEqual(await identity(), originalIdentity);
  await page.screenshot({ path: join(scratch, "attached-turn-completed.png") });
  attachments.push({
    label: "attached-turn-completed",
    projectId,
    threadId,
    turnId: attachedTurnId,
    status: "completed",
    requests: requests.length,
    screenshot: "attached-turn-completed.png",
  });
  checks.push(
    "the original attached turn completes once with one final response and no duplicate input or model work",
  );
  if (readingSlice) {
    if (manualReading) {
      const viewport = page.locator(".messages"),
        box = await viewport.boundingBox();
      const target = page
        .locator(`[data-turn-id="${attachedThread.turns[0].id}"] .conversation-markdown p`)
        .filter({ hasText: "【恢复第24段】" });
      const top = await target.evaluate((element) => element.getBoundingClientRect().top);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, top - box.y - 40);
      await until(async () => {
        const view = await readView();
        return view.paragraph && view.remaining > 500;
      }, "manual reading origin");
      const ready = {
        automaticAcceptancePassed: true,
        sourceCommit,
        sourceHashes,
        originalHash,
        projectId,
        threadId,
        identity: await identity(),
        draft: await page.getByTestId("chat-input").innerText(),
        reading: await settledView(),
        checks,
        readingEvidence,
        scope: "same-window renderer reload; isolated local model; close this window to clean up",
      };
      await page.screenshot({ path: join(scratch, "manual-ready.png") });
      const closed = new Promise((resolve) => {
        const onConsole = (message) => {
          if (message.text() === "AREAL_READING_MANUAL_CLOSED") resolve();
        };
        app.on("console", onConsole);
        app.once("close", resolve);
      });
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].once("close", () =>
          console.info("AREAL_READING_MANUAL_CLOSED"),
        ),
      );
      await writeFile(join(scratch, "manual-ready.json"), JSON.stringify(ready, null, 2));
      console.log("Manual ready: " + join(scratch, "manual-ready.json"));
      await closed;
    }
    await quitAndObserveIdleRelease();
    await quiescent();
    passed = true;
  } else {
    await page.getByTestId("chat-input").fill("hold application restart");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await until(
      async () => held.size === 1 && (await readThread()).turns.at(2)?.status === "inProgress",
      "independent third turn held for application restart",
    );
    assert.equal(requests.length, 3);
    assert.equal(held.size, 1);
    const originalThread = await readThread();
    const original = await records();
    generations.push(original);
    await page.getByTestId("chat-input").fill(draft);
    await sleep(300);
    if (replacement) {
      await copyFile(replacement, staged);
      await chmod(staged, originalStat.mode & 0o777);
      await rename(staged, binary);
    } else await utimes(binary, originalStat.atime, new Date(originalStat.mtimeMs + 10000));
    for (let index = 0; index < 2; index++) {
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await until(
        async () =>
          !(await app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].isVisible(),
          )),
        "window hidden after Renderer acknowledges close",
        30000,
      );
      await app.evaluate(({ app }) => app.emit("activate"));
      await until(
        () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()),
        "window shown",
      );
      assert.deepEqual(await metadata(), originalMetadata);
      assert.deepEqual(
        (await records()).map((service) => service.generation),
        original.map((service) => service.generation),
      );
      assert.equal(await page.getByTestId("chat-input").innerText(), draft);
      assert.equal(requests.length, 3);
      assert.equal(held.size, 1);
      assert.equal((await readThread()).turns.at(-1).id, originalThread.turns.at(-1).id);
    }
    await restoreBinary();
    checks.push(
      replacement
        ? "different Mach-O bytes at the private path do not replace the running engine during window reopen"
        : "changed binary timestamp does not replace the running engine during window reopen",
    );
    checks.push(
      "two window closes and reopens preserve application owner, engine generations, active turn and draft without replay",
    );
    if (force) {
      processHandle.kill("SIGKILL");
      await until(() => !alive(processHandle.pid), "forced Main exit");
      app = null;
      assert.deepEqual(await metadata(), originalMetadata);
      assert.ok(held.size === 1);
    } else {
      observer.socket.close();
      observer = null;
      await quit();
      await confirmGuiStop(originalMetadata);
      await quiescent();
      assert.equal(held.size, 0);
    }

    await launch();
    assert.equal(
      (await metadata()).generation === originalMetadata.generation,
      force,
      "the original Host generation survives only when Main exits without requesting a stop",
    );
    await until(
      async () => (await workbench().getAttribute("data-thread-id")) === threadId,
      "original thread selected after reopening",
    );
    assert.equal(await workbench().getAttribute("data-project-id"), projectId);
    const history = page.locator(`[data-turn-id="${attachedTurnId}"] .assistant-message-final`);
    await history.getByText("REOPEN_HELD", { exact: false }).waitFor();
    assert.equal(await page.getByTestId("chat-input").innerText(), draft);
    assert.equal(requests.length, 3);
    if (!force) {
      // 重开先恢复已有历史。只为核对后继 Core 的代际，显式激活一次原项目。
      assert.ok(
        await observeCore({ activate: true }),
        "explicit activation opens the original project",
      );
    }
    await until(
      async () => (await readThread()).turns.length === originalThread.turns.length,
      "history restored",
    );
    const current = await records();
    generations.push(current);
    for (const after of current.filter((service) => service.state === "ready")) {
      const before = original.find((service) => service.serviceId === after.serviceId);
      assert.ok(before, "the original project retains its service identity");
      assert.equal(after.generation === before.generation, force);
    }
    assert.ok(
      current.some((service) => service.workspace === workspace && service.state === "ready"),
    );
    const reopened = await readThread();
    assert.deepEqual(
      reopened.turns.map((turn) => turn.id),
      originalThread.turns.map((turn) => turn.id),
    );
    assert.equal(reopened.turns[0].status, "completed");
    assert.equal(reopened.turns.find((turn) => turn.id === attachedTurnId).status, "completed");
    if (force) {
      assert.equal(reopened.turns.at(-1).status, "inProgress");
      const originalResponse = [...held][0];
      originalResponse.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      );
      await until(
        async () => (await readThread()).turns.at(-1).status === "completed",
        "the original live Turn completes after Main recovery",
      );
    } else assert.notEqual(reopened.turns.at(-1).status, "inProgress");
    assert.equal(await page.getByTestId("chat-input").innerText(), draft);
    assert.equal(requests.length, 3);
    checks.push(
      force
        ? "Main loss preserves the active Host/Core and original model request; the reopened GUI retains history and draft"
        : "confirmed stop releases the active Host/Core; GUI reopen restores original history and draft without replay",
    );
    await quitAndObserveIdleRelease();
    await quiescent();
    passed = true;
  }
} catch (error) {
  errors.push(error.stack);
  if (page && app) await page.screenshot({ path: join(scratch, "failure.png") }).catch(() => {});
} finally {
  await rendererConnection?.close().catch(() => {});
  if (app && alive(processHandle.pid))
    await app.evaluate(({ app }) => app.exit(1)).catch(() => processHandle.kill("SIGKILL"));
  await application.close();
  await restoreBinary().catch((error) => errors.push(`binary restore: ${error.stack}`));
  await rm(staged, { force: true });
  if (backup) await rm(backup, { force: true });
  await finishFixtureHost().catch((error) => errors.push(`cleanup: ${error.stack}`));
  await quiescent().catch((error) => errors.push(`cleanup: ${error.stack}`));
  for (const response of held) response.destroy();
  model.closeAllConnections();
  await new Promise((resolve) => model.close(resolve));
  for (const [path, hash] of Object.entries(sourceHashes))
    if (
      createHash("sha256")
        .update(await readFile(join(gui, path)))
        .digest("hex") !== hash
    )
      errors.push(`source changed during test: ${path}`);
  passed = passed && errors.length === 0;
  const hostCleanup = [...hostPids].map((pid) => ({ pid, exited: !alive(pid) }));
  const manifestPayload = {
    passed,
    checks,
    errors,
    sourceCommit,
    force,
    readingSlice,
    manualReading,
    readingEvidence,
    generations,
    attachments,
    hostCleanup,
    hostStops,
    sourceHash,
    sourceHashes,
    binary,
    replacement,
    originalHash,
    requests: requests.length,
    namingRequests: modelRequests.filter((request) => request.kind === "naming").length,
    modelRequests,
    scope:
      "isolated source Electron/Main/Host/Core; Runtime PID presence recorded without requiring tool execution; local model; native dialog/picker responses injected; no installed package",
  };
  await writeFile(join(scratch, "manifest.json"), JSON.stringify(manifestPayload, null, 2));
  const businessReportPath = process.env.AREAL_JOURNEY_REPORT
    ? resolve(process.env.AREAL_JOURNEY_REPORT)
    : join(scratch, "report.json");
  if (businessReportPath !== join(scratch, "report.json")) {
    await writeFile(
      join(dirname(businessReportPath), "manifest.json"),
      JSON.stringify(manifestPayload, null, 2),
    );
  }
  const cleanupOk =
    hostCleanup.every((entry) => entry.exited) &&
    !errors.some((message) => String(message).startsWith("cleanup:"));
  const factChecks = {
    originalRequestRetained: passed && requests.length >= 1,
    receiptReconciled: passed && hostStops.length >= 0,
    noReplay: passed && requests.length <= 3,
    cleanupSettled: cleanupOk,
  };
  const allFactsPassed = passed && Object.values(factChecks).every(Boolean);
  await writeFile(
    businessReportPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        journeyId: "unknown-receipt-recovery",
        identity: process.env.AREAL_VERIFICATION_IDENTITY
          ? JSON.parse(process.env.AREAL_VERIFICATION_IDENTITY)
          : {},
        status: allFactsPassed ? "passed" : "failed",
        facts: Object.entries(factChecks).map(([id, ok]) => ({
          id,
          status: ok ? "passed" : "failed",
          evidence: ["manifest.json"],
        })),
        firstFailure: allFactsPassed ? null : (errors[0] ?? "service-reopen failed"),
        reached: Object.entries(factChecks)
          .filter(([, ok]) => ok)
          .map(([id]) => id),
        unreached: Object.entries(factChecks)
          .filter(([, ok]) => !ok)
          .map(([id]) => id),
        cleanup: { status: cleanupOk ? "passed" : "failed", evidence: ["manifest.json"] },
        scope: manifestPayload.scope,
      },
      null,
      2,
    ),
  );
}
assert.ok(passed, errors.join("\n"));
console.log("PASS", checks);
