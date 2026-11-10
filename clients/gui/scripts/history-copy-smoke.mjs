import { makeTempDir } from "./support/temp.mjs";
import {
  assertApplicationStopped,
  closeSmokeApplication,
  cleanupSyntheticHostKeychain,
} from "./application-cleanup.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, cp, readdir, lstat, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { captureSmokeFailure, selectConversation } from "./smoke-navigation.mjs";
import { withSmokeDeadline } from "./smoke-deadline.mjs";

// 沿用历史副本专项：只把来源作为输入，所有 Core 写入和清理均落在私有副本。
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { GuiHostProjects } = require("@areal/workbench-service/desktop/core/gui-host-projects.cjs");
const { values } = parseArgs({
  options: {
    source: { type: "string" },
    executable: { type: "string" },
    "measure-return": { type: "boolean" },
    "check-detail": { type: "boolean" },
  },
});
const source = resolve(values.source || join(gui, "scripts/fixtures/history-compat"));
const fixtureMode = source === join(gui, "scripts/fixtures/history-compat");
const executablePath = values.executable || process.env.AREAL_GUI_EXECUTABLE;
const binary = executablePath
  ? resolve(dirname(executablePath), "../Resources/areal-core/bin/areal")
  : process.env.AREAL_CORE_BIN || resolve(gui, "../../target/debug/areal");
const scratch = await makeTempDir("ahc-");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashes = new Map(),
  copyHashes = new Map(),
  sessions = new Map(),
  originals = new Map(),
  stateDirectories = new Map(),
  checks = [];
let app,
  historyOwner,
  hostPid,
  env,
  page,
  failure,
  copyUnchangedWhileOpen = false,
  sourceUnchanged = false;
let projectIndexHash;
let profiles;
let modelRequests = 0;
const server = createServer((_request, response) => {
  modelRequests++;
  response.writeHead(500).end("History observation must not invoke a model");
});

async function sourceBytes(relative) {
  const path = join(source, relative);
  assert.ok((await lstat(path)).isFile(), "History inputs must be regular files");
  const bytes = await readFile(path);
  hashes.set(relative, hash(bytes));
  copyHashes.set(relative, hash(bytes));
  return bytes;
}

function assertIdle(record) {
  const thread = record.thread,
    desktop = thread.desktop;
  assert.equal(
    thread.status.type,
    "idle",
    "Preflight requires idle history; no recovery work is executed",
  );
  assert.ok(
    thread.turns.every((turn) => ["completed", "failed", "interrupted"].includes(turn.status)),
    "History contains an unfinished turn",
  );
  assert.ok(
    !thread.goals?.goal ||
      (["completed", "failed", "budgetLimited", "paused", "blocked"].includes(
        thread.goals.goal.status,
      ) &&
        !thread.goals.goal.activeTurnId &&
        !thread.goals.goal.settling),
    "History contains an unfinished goal",
  );
  assert.ok(
    (desktop?.queue?.items ?? []).every((item) =>
      ["completed", "failed", "steered", "cancelled", "removed"].includes(item.status),
    ),
    "History contains queued work",
  );
  assert.ok(
    (desktop?.processes ?? []).every(
      (process) => process.state === "closed" && process.cleanupConfirmed === true,
    ) && !desktop?.workflowRun,
    "History contains managed execution state",
  );
  assert.ok(
    (desktop?.hookRuns ?? []).every((run) => run.delivered && run.outcome !== "running"),
    "History contains unsettled hooks",
  );
}

async function unchanged(root, expected = hashes) {
  for (const [relative, digest] of expected) {
    if (hash(await readFile(join(root, relative))) !== digest) return false;
  }
  return true;
}

async function stateEntries(root, relative) {
  try {
    assert.ok(
      (await lstat(join(root, relative))).isDirectory(),
      "State must be a directory, not a symlink",
    );
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return (await readdir(join(root, relative))).sort();
}

// 这是全新隔离项目的历史读取夹具，不声称验证旧后台的迁移或清理。
async function prepareHistorySource(owner, projects) {
  const coreHome = owner.source.coreHome;
  const staged = coreHome + "-history-staging";
  await rename(coreHome, staged);
  await mkdir(coreHome, { mode: 0o700 });
  await writeFile(join(coreHome, "projects.json"), "[]", { mode: 0o600 });
  await owner.init();
  for (const project of projects) {
    const binding = await owner.register(randomUUID(), project);
    assert.equal(binding.dataDir, join(coreHome, project.id, "state"));
    // 登记只创建归属，尚未启动 Core；复制前不得存在任何服务持锁文件。
    for (const name of ["owner.lock", "service.lock"])
      await assert.rejects(lstat(join(binding.dataDir, name)), { code: "ENOENT" });
    await cp(join(staged, project.id), join(coreHome, project.id), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  await writeFile(join(coreHome, "projects.json"), JSON.stringify(projects), { mode: 0o600 });
}

async function call(name, params) {
  const result = await withSmokeDeadline(
    `history ${name}`,
    () =>
      page.evaluate(({ name, params }) => window.arealDesktop.command(name, params), {
        name,
        params,
      }),
    120000,
  );
  assert.equal(result.ok, true, result.error?.message ?? JSON.stringify(result));
  return result.value;
}

try {
  await mkdir(join(scratch, "core"), { mode: 0o700 });
  await mkdir(join(scratch, "user/.areal"), { recursive: true, mode: 0o700 });
  assert.ok(
    (await lstat(source)).isDirectory(),
    "History source must be a directory, not a symlink",
  );
  const projects = JSON.parse(await sourceBytes("projects.json"));
  projectIndexHash = hashes.get("projects.json");
  hashes.delete("projects.json");
  copyHashes.delete("projects.json");
  if (fixtureMode) {
    profiles = JSON.parse(await sourceBytes("profiles.json"));
    assert.equal(profiles.version, 1, "Unsupported history fixture profile format");
    assert.equal(profiles.source, "synthetic");
    assert.ok(Array.isArray(profiles.profiles) && profiles.profiles.length > 0);
    assert.equal(
      new Set(profiles.profiles.map((profile) => profile.id)).size,
      profiles.profiles.length,
    );
    copyHashes.delete("profiles.json");
  }
  assert.ok(Array.isArray(projects) && projects.length > 0, "History source has no projects");
  const isolatedProjects = [];
  for (const project of projects) {
    assert.match(project.id, /^[a-f0-9]{24}$/, "Invalid project ID");
    assert.ok(!sessions.has(project.id), "Duplicate project ID");
    assert.ok(
      (await lstat(join(source, project.id))).isDirectory(),
      "Project must not be a symlink",
    );
    const state = join(project.id, "state"),
      ids = [],
      records = new Map();
    const workspace = fixtureMode ? join(scratch, "workspaces", project.id) : project.root;
    if (fixtureMode) await mkdir(workspace, { recursive: true, mode: 0o700 });
    assert.equal(typeof workspace, "string", "Project workspace is missing");
    // 项目先登记再启动 Core；首次连接失败时可能尚无状态目录。
    const entries = await stateEntries(source, state);
    stateDirectories.set(state, entries);
    await mkdir(join(scratch, "core", state), { recursive: true, mode: 0o700 });
    for (const name of entries ?? []) {
      if (!name.endsWith(".json")) continue;
      assert.match(name, /^[a-f0-9-]{36}\.json$/, "Invalid stored session filename");
      const relative = join(state, name),
        bytes = await sourceBytes(relative);
      const record = JSON.parse(bytes);
      assert.equal(record.thread.id, name.slice(0, -5), "History filename and thread ID differ");
      assertIdle(record);
      if (
        fixtureMode &&
        profiles.profiles.find((profile) => profile.id === "paged-history")?.threadId ===
          record.thread.id
      ) {
        for (const turn of record.thread.turns)
          for (const item of turn.items)
            if (item.type === "agentMessage") item.text = item.text.repeat(4);
      }
      records.set(record.thread.id, record.thread);
      originals.set(record.thread.id, structuredClone(record));
      // 受控样本的占位工作区只在副本中填充；私有历史保留全部原始字节及 cwd。
      let copied = bytes;
      if (fixtureMode) {
        record.thread.cwd = workspace;
        copied = Buffer.from(JSON.stringify(record));
        copyHashes.set(relative, hash(copied));
      }
      await writeFile(join(scratch, "core", relative), copied, { mode: 0o600 });
      ids.push(record.thread.id);
    }
    // 已完成的子会话引用是历史；只有同项目内可核对的终态目标才可观察。
    for (const thread of records.values()) {
      for (const record of thread.desktop?.executions ?? []) {
        const execution = record.execution;
        assert.equal(execution?.kind, "thread", "History contains unresolved managed execution");
        const target = records.get(execution.threadId);
        const turn = target?.turns.find((value) => value.id === execution.turnId);
        assert.ok(
          turn && ["completed", "failed", "interrupted"].includes(turn.status),
          "History execution target is missing or unfinished",
        );
      }
    }
    // 归档、附件和 Goal 计量日志仍由 Core 读取；不复制锁、凭据或部署配置。
    for (const directory of ["history", "blobs", "goals"]) {
      const relative = join(state, directory);
      try {
        await lstat(join(source, relative));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      await cp(join(source, relative), join(scratch, "core", relative), {
        recursive: true,
        filter: async (path) => {
          const stat = await lstat(path);
          assert.ok(!stat.isSymbolicLink(), "History resources must not contain symlinks");
          if (stat.isFile())
            await sourceBytes(join(relative, path.slice(join(source, relative).length + 1)));
          return true;
        },
      });
    }
    isolatedProjects.push({ id: project.id, root: workspace });
    sessions.set(project.id, ids);
  }
  // Core 校验会话工作区归属；私有副本沿用原路径，只观察、不执行任务。
  await writeFile(join(scratch, "core/projects.json"), JSON.stringify(isolatedProjects), {
    mode: 0o600,
  });
  assert.equal(
    await unchanged(join(scratch, "core"), copyHashes),
    true,
    "Source changed during history copy",
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await writeFile(
    join(scratch, "user/.areal/config.toml"),
    `schema_version=1\n[model]\ncatalog_version=1\nprovider="history-fixture"\nname="fixture"\n[model.providers.history-fixture]\nname="History fixture"\nendpoint="http://127.0.0.1:${server.address().port}/v1/chat/completions"\nprotocol="chat-completions"\napi_key_env="AREAL_HISTORY_FIXTURE_KEY"\nmodels=[{id="fixture",enabled=true}]\n`,
    { mode: 0o600 },
  );
  env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AREAL_") && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  Object.assign(env, {
    AREAL_GUI_USER_DATA: join(scratch, "electron"),
    AREAL_CORE_HOME: join(scratch, "core"),
    AREAL_CORE_USER_HOME: join(scratch, "user"),
    AREAL_HARNESS_SERVICE_HOME: join(scratch, "registry"),
    AREAL_HISTORY_FIXTURE_KEY: "fixture-key",
  });
  if (!executablePath) env.AREAL_CORE_BIN = binary;
  historyOwner = new GuiHostProjects({
    binary,
    home: env.AREAL_HARNESS_SERVICE_HOME,
    singletonHeld: true,
    source: {
      profile: env.AREAL_GUI_USER_DATA,
      coreHome: env.AREAL_CORE_HOME,
      legacyServiceHome: env.AREAL_HARNESS_SERVICE_HOME,
    },
  });
  await prepareHistorySource(historyOwner, isolatedProjects);
  hostPid = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/host.json"), "utf8"),
  ).pid;
  assert.equal(await unchanged(join(scratch, "core"), copyHashes), true);
  app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [join(gui, "app")] }),
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  for (const project of isolatedProjects) {
    await call("connect", { projectId: project.id });
    // 历史视图有界缓存；逐个确认打开结果，避免后续打开淘汰已验证的会话。
    for (const id of sessions.get(project.id)) {
      await call("open", { projectId: project.id, threadId: id });
      await page.waitForFunction(
        async ({ projectId, threadId }) =>
          Boolean(
            (await window.arealDesktop.snapshot()).projects.find((value) => value.id === projectId)
              ?.state.threads[threadId],
          ),
        { projectId: project.id, threadId: id },
      );
    }
    const snapshot = await page.evaluate(() => window.arealDesktop.snapshot());
    const restored = snapshot.projects.find((value) => value.id === project.id);
    assert.equal(restored.state.connected, true);
    assert.equal(restored.error, null);
    if (sessions.get(project.id).length === 0)
      assert.equal(
        Object.keys(restored.state.threads).length,
        0,
        "Empty project acquired sessions",
      );
    checks.push({
      projectId: project.id,
      sessions: sessions.get(project.id).length,
      sourceStatePresent: stateDirectories.get(join(project.id, "state")) !== null,
      connected: true,
    });
  }
  for (const profile of profiles?.profiles ?? []) {
    const stored = originals.get(profile.threadId);
    assert.ok(stored, `Missing profile ${profile.id}`);
    assert.equal(stored.version, profile.storedVersion, "Migration sample was rewritten");
    const original = stored.thread;
    assert.equal(original.turns.length, profile.turnCount);
    const request = {
      projectId: profile.projectId,
      threadId: profile.threadId,
      viewId: `history-compat-${profile.id}`,
    };
    await call("open", { projectId: profile.projectId, threadId: profile.threadId });
    const acquired = await call("history", { ...request, operation: "acquire" });
    assert.equal(acquired.supported, true, "Fixture profiles require bounded history");
    let pages = 0;
    const read = () =>
      page.evaluate(
        async ({ projectId, threadId }) =>
          (await window.arealDesktop.snapshot()).projects.find((value) => value.id === projectId)
            .state.threads[threadId],
        request,
      );
    let thread = await read();
    while (!thread.displayHistory.complete) {
      assert.ok(pages < profile.maxPages, "History profile did not reach its oldest page");
      const older = await call("history", { ...request, operation: "loadOlder" });
      assert.ok(older.data.length > 0, "Incomplete history returned an empty page");
      pages++;
      thread = await read();
    }
    assert.ok(pages >= profile.minPages, "Long-history fixture did not exercise paging");
    for (const field of ["name", "preview", "parentThreadId", "sessionId"])
      assert.equal(thread[field] ?? null, original[field] ?? null, `${profile.id}: ${field}`);
    const content = (value) =>
      value.turns.map((turn) => ({
        id: turn.id,
        status: turn.status,
        error: turn.error ?? null,
        items: turn.items.map(({ id, type, text, content }) => ({ id, type, text, content })),
      }));
    assert.deepEqual(
      content(thread),
      content(original),
      `${profile.id}: chronological history changed`,
    );
    for (const [turnId, status] of Object.entries(profile.terminalStates ?? {}))
      assert.equal(thread.turns.find((turn) => turn.id === turnId)?.status, status);
    if (profile.parentThreadId)
      assert.equal(thread.parentThreadId, profile.parentThreadId, "Settled child lost its parent");
    if (profile.visibleText) {
      await selectConversation(page, profile.threadId);
      await page.getByText(profile.visibleText, { exact: false }).last().waitFor();
    }
    if (profile.id === "paged-history") {
      for (const suffix of ["39", "00", "39"]) {
        const user = page.locator(`[data-side-item-id="paged-user-${suffix}"]`);
        const answer = page.locator(`[data-side-item-id="paged-item-${suffix}"]`);
        if (suffix === "00") {
          for (let attempt = 0; attempt < 10 && !(await user.count()); attempt++) {
            const before = await read();
            const first = before.turns[0]?.items[0]?.id;
            await page.locator(".messages").hover();
            await page.mouse.wheel(0, -1000000);
            await page.waitForFunction(
              async ({ projectId, threadId, first }) => {
                const thread = (await window.arealDesktop.snapshot()).projects.find(
                  (value) => value.id === projectId,
                )?.state.threads[threadId];
                return (
                  thread &&
                  !thread.displayHistory.loadingOlder &&
                  (thread.displayHistory.complete || thread.turns[0]?.items[0]?.id !== first)
                );
              },
              { ...request, first },
              { timeout: 30000 },
            );
          }
        }
        await user.scrollIntoViewIfNeeded();
        await user.getByText(`HISTORY_QUESTION_${suffix}`).waitFor();
        await answer.getByText(`HISTORY_PAGE_${suffix}`, { exact: false }).waitFor();
        assert.equal(
          await user.evaluate((node, answerId) => {
            const answerNode = document.querySelector(`[data-side-item-id="${answerId}"]`);
            return Boolean(
              answerNode &&
              node.compareDocumentPosition(answerNode) & Node.DOCUMENT_POSITION_FOLLOWING,
            );
          }, `paged-item-${suffix}`),
          true,
          `Question and answer order changed for turn ${suffix}`,
        );
      }
    }
    await call("history", { ...request, operation: "release" });
    checks.push({ profile: profile.id, turns: thread.turns.length, olderPages: pages });
  }
  // 对独立源记录建立期望，记录切换过程中每次 DOM 变更时已挂载和视口内的基本消息。
  const observations = [];
  for (const project of isolatedProjects) {
    for (const threadId of sessions.get(project.id)) {
      if (!(await page.getByTestId(`task-item-${threadId}`).count())) {
        observations.push({
          projectId: project.id,
          threadId,
          skipped: "not in conversation list",
          missingContext: [],
          orderErrors: [],
        });
        continue;
      }
      const original = originals.get(threadId).thread;
      const expected = original.turns.flatMap((turn) =>
        turn.items
          .filter((item) => item.type === "userMessage" || item.type === "agentMessage")
          .map((item) => ({ id: item.id, turnId: turn.id, type: item.type })),
      );
      await page.evaluate(
        ({ projectId, threadId, ids }) => {
          window.__historyObservation?.observer.disconnect();
          const samples = [];
          const pending = [];
          const sample = () => {
            const workbench = document.querySelector('[data-testid="areal-workbench"]');
            if (workbench?.dataset.threadId !== threadId) return;
            const reader = document.querySelector(".messages");
            if (!reader) return;
            const bounds = reader.getBoundingClientRect();
            const nodes = [...reader.querySelectorAll("[data-side-item-id]")].filter((node) =>
              ids.includes(node.dataset.sideItemId),
            );
            const entry = {
              at: performance.now(),
              mounted: nodes.map((node) => node.dataset.sideItemId),
              visible: nodes
                .filter((node) => {
                  const rect = node.getBoundingClientRect();
                  return rect.bottom > bounds.top && rect.top < bounds.bottom;
                })
                .map((node) => node.dataset.sideItemId),
            };
            samples.push(entry);
            pending.push(
              window.arealDesktop.snapshot().then((snapshot) => {
                const thread = snapshot.projects.find((value) => value.id === projectId)?.state
                  .threads[threadId];
                entry.projectionAt = performance.now();
                entry.projection =
                  thread?.turns.flatMap((turn) => turn.items.map((item) => item.id)) ?? [];
              }),
            );
          };
          const observer = new MutationObserver(sample);
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
          window.__historyObservation = {
            observer,
            samples,
            sample,
            pending,
            start: performance.now(),
          };
        },
        { projectId: project.id, threadId, ids: expected.map((item) => item.id) },
      );
      await selectConversation(page, threadId);
      if (expected.length)
        await page.waitForFunction(() =>
          Boolean(document.querySelector(".messages [data-side-item-id]")),
        );
      const projection = await page.evaluate(
        async ({ projectId, threadId }) => {
          const thread = (await window.arealDesktop.snapshot()).projects.find(
            (value) => value.id === projectId,
          )?.state.threads[threadId];
          return thread?.turns.flatMap((turn) => turn.items.map((item) => item.id)) ?? [];
        },
        { projectId: project.id, threadId },
      );
      const captured = await page.evaluate(async () => {
        const observation = window.__historyObservation;
        observation.sample();
        observation.observer.disconnect();
        await Promise.all(observation.pending);
        return { start: observation.start, samples: observation.samples };
      });
      const precedingUser = new Map();
      for (const turn of original.turns) {
        let user;
        for (const item of turn.items) {
          if (item.type === "userMessage") user = item.id;
          if (item.type === "agentMessage" && user) precedingUser.set(item.id, user);
        }
      }
      const missingContext = captured.samples.flatMap((sample) =>
        sample.mounted.flatMap((id) => {
          const user = precedingUser.get(id);
          return user && !sample.mounted.includes(user)
            ? [{ at: sample.at, response: id, user }]
            : [];
        }),
      );
      const orderErrors = captured.samples.filter((sample) => {
        const indexes = sample.mounted.map((id) => expected.findIndex((item) => item.id === id));
        return indexes.some((index, position) => position > 0 && index <= indexes[position - 1]);
      });
      observations.push({
        projectId: project.id,
        threadId,
        expected,
        projection,
        missingContext,
        orderErrors,
        ...captured,
      });
    }
  }
  await writeFile(
    join(scratch, "reading-observations.json"),
    JSON.stringify(observations, null, 2),
    { mode: 0o600 },
  );
  assert.ok(
    observations.every(
      (observation) =>
        observation.missingContext.length === 0 && observation.orderErrors.length === 0,
    ),
    "A sampled DOM had a response without its user context or changed basic message order",
  );
  if (values["check-detail"]) {
    const project = isolatedProjects.find((value) => sessions.get(value.id).length);
    const threadId = sessions.get(project.id)[0];
    await selectConversation(page, threadId);
    const group = page.locator("[data-turn-id] .turn-progress").first();
    const groupSummary = group.locator(".turn-progress-summary");
    if ((await groupSummary.getAttribute("aria-expanded")) !== "true") await groupSummary.click();
    const deferred = group.locator("[data-tool-id]").first();
    const activity = deferred
      .locator(
        'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " areal-activity-group ")][1]',
      )
      .locator(".areal-disclosure-trigger")
      .first();
    if ((await activity.getAttribute("aria-expanded")) !== "true") await activity.click();
    await deferred.waitFor();
    const itemId = await deferred.getAttribute("data-tool-id");
    await group.evaluate((node) => {
      node.dataset.historyProbe = "same-group";
    });
    await deferred.locator(".tool-summary-row").click();
    await page.waitForFunction(
      async ({ projectId, threadId, itemId }) => {
        const snapshot = await window.arealDesktop.snapshot();
        const thread = snapshot.projects.find((value) => value.id === projectId)?.state.threads[
          threadId
        ];
        return (
          thread?.turns.flatMap((turn) => turn.items).find((item) => item.id === itemId)?.type ===
          "dynamicToolCall"
        );
      },
      { projectId: project.id, threadId, itemId },
      { timeout: 30000 },
    );
    assert.equal(await deferred.getByRole("alert").count(), 0);
    assert.equal(await deferred.locator('[aria-expanded="true"]').count(), 1);
    assert.equal(
      await group.getAttribute("data-history-probe"),
      "same-group",
      "Loading detail replaced its process group",
    );
    checks.push({ detailItem: itemId, processGroupPreserved: true });
  }
  if (values["measure-return"]) {
    const project = isolatedProjects.find((value) => sessions.get(value.id).length >= 2);
    assert.ok(project, "Return timing requires two conversations in one project");
    const [target, other] = sessions.get(project.id);
    const items = originals.get(target).thread.turns.at(-1).items;
    const user = items.find((item) => item.type === "userMessage")?.id;
    const answer = items.findLast((item) => item.type === "agentMessage")?.id;
    assert.ok(user && answer, "Return timing requires a user and answer");
    const elapsed = [];
    for (let n = 0; n < 20; n++) {
      await selectConversation(page, other);
      const start = performance.now();
      await selectConversation(page, target);
      await page.waitForFunction(
        ({ user, answer }) =>
          Boolean(
            document.querySelector(`[data-side-item-id="${user}"]`) &&
            document.querySelector(`[data-side-item-id="${answer}"]`),
          ),
        { user, answer },
      );
      elapsed.push(performance.now() - start);
    }
    const sorted = [...elapsed].sort((a, b) => a - b);
    const timing = {
      scope: "preobserved, selection to mounted pair",
      elapsed,
      count: elapsed.length,
      p50: sorted[9],
      p95: sorted[18],
      max: sorted.at(-1),
      failures: 0,
    };
    await writeFile(join(scratch, "return-timing.json"), JSON.stringify(timing, null, 2), {
      mode: 0o600,
    });
  }
  copyUnchangedWhileOpen = await unchanged(join(scratch, "core"), copyHashes);
  assert.equal(
    copyUnchangedWhileOpen,
    true,
    "Opening history must not rewrite snapshots or archived resources",
  );
  assert.equal(
    hash(await readFile(join(source, "projects.json"))),
    projectIndexHash,
    "Source project index changed",
  );
  assert.equal(modelRequests, 0, "History observation replayed a model request");
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  if (page) await captureSmokeFailure(page, scratch, error);
} finally {
  const cleanup = { errors: [], applicationStopped: false };
  // 使用启动时持有的 Electron 进程，不依赖已退役的 Desktop service.json。
  const meta = app ? { pid: app.process()?.pid } : undefined;
  const serviceMetadataVerified = !app || (Number.isSafeInteger(meta?.pid) && meta.pid > 1);
  if (!serviceMetadataVerified)
    cleanup.errors.push("owned Electron process PID is missing or invalid");
  try {
    if (app) {
      await closeSmokeApplication(
        {
          process: () => app.process(),
          close: async () => {
            await app.evaluate(({ dialog }) => {
              dialog.showMessageBox = async () => ({ response: 1 });
            });
            await app.close();
          },
        },
        120000,
      );
    }
  } catch (error) {
    cleanup.errors.push(`Electron close: ${error.message}`);
  }
  // GUI 退出保留 Host；显式停止同一代际后才核对后台库存。
  try {
    if (historyOwner?.client.generation) {
      const receipt = await historyOwner.client.stop(
        randomUUID(),
        historyOwner.client.generation,
        "ifIdle",
      );
      cleanup.hostStop = { state: receipt.state };
      assert.equal(receipt.state, "completed", "isolated Host stop is not settled");
    }
  } catch (error) {
    cleanup.errors.push(`Host stop: ${error.message}`);
  }
  historyOwner?.close();
  // 精确 Electron 子进程退出不代表私有 Desktop/Core 已退出，仍独立核验库存。
  try {
    if (env) {
      await assertApplicationStopped(binary, env, meta);
      if (hostPid) await assertApplicationStopped(binary, env, { pid: hostPid });
      cleanup.applicationStopped = serviceMetadataVerified;
      if (cleanup.hostStop?.state === "completed")
        cleanup.keychain = await cleanupSyntheticHostKeychain(
          env.AREAL_HARNESS_SERVICE_HOME,
          scratch,
        );
    }
  } catch (error) {
    cleanup.errors.push(`service inventory: ${error.message}`);
  }
  await new Promise((resolve) => server.close(resolve));
  try {
    for (const [relative, entries] of stateDirectories)
      assert.deepEqual(
        await stateEntries(source, relative),
        entries,
        "Source state entries changed",
      );
    sourceUnchanged =
      (await unchanged(source)) &&
      (!projectIndexHash ||
        hash(await readFile(join(source, "projects.json"))) === projectIndexHash);
  } catch (error) {
    failure ??= { message: error.message };
  }
  if (!sourceUnchanged || modelRequests !== 0)
    failure ??= { message: "Source changed or a model request was replayed" };
  const report = {
    passed: !failure && cleanup.errors.length === 0,
    scope: "history reading in fresh isolated Host projects; not legacy ownership migration",
    sourceMode: fixtureMode ? "sanitized-fixture" : "local-copy",
    source,
    executablePath: executablePath || "development Electron",
    coreSha256: hash(await readFile(binary)),
    checks,
    historyFiles: [...sessions.values()].reduce((count, ids) => count + ids.length, 0),
    copyUnchangedWhileOpen,
    sourceUnchanged,
    modelRequests,
    cleanup,
    cleanupNote:
      cleanup.errors.length === 0 && cleanup.applicationStopped
        ? "Application quit confirmed the isolated adapter and all copied Core generations stopped; drain may update copied queue revisions after observation"
        : "Cleanup did not complete successfully; inspect cleanup errors and service inventory evidence",
    failure,
  };
  const evidence = join(scratch, "manifest.json");
  await writeFile(evidence, JSON.stringify(report, null, 2), { mode: 0o600 });
  // 证据文件留在临时目录，CI 上拿不到；失败时把原因直接打出来。
  console.log(
    JSON.stringify({
      passed: report.passed,
      evidence,
      ...(report.passed ? {} : { failure: failure?.message, cleanupErrors: cleanup.errors }),
    }),
  );
  process.exitCode = report.passed ? 0 : 1;
}
