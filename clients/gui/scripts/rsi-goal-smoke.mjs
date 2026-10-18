// Electron 原生输入、隔离候选、人工选择、窗口与 Core 重启验收。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rsiModel } from "../../../tests/fixtures/rsi-model.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(gui, "../..");
const require = createRequire(join(gui, "app/package.json"));
const { _electron: electron } = require("playwright-core");
const { executeCore } = require(join(gui, "app/src/core/core-process.cjs"));
const root = await mkdtemp("/private/tmp/areal-rsi-gui-");
const evidence = resolve(process.env.AREAL_RSI_EVIDENCE_DIR ?? root);
await mkdir(evidence, { recursive: true });
const workspace = join(root, "workspace");
await mkdir(workspace);
await mkdir(join(root, "user"));
await writeFile(join(workspace, "input.txt"), "immutable GUI input\n");
const model = await rsiModel();
const config = join(root, "config.toml");
await writeFile(
  config,
  `schema_version=1\n[model]\nprovider="fixture"\nname="fixture"\n[model.providers.fixture]\nprotocol="chat-completions"\nendpoint=${JSON.stringify(model.endpoint)}\n`,
);
const binary = join(repo, "target/debug/areal");
const env = {
  ...process.env,
  AREAL_GUI: "workbench",
  AREAL_BACKEND: "areal",
  AREAL_CORE_BIN: binary,
  AREAL_CORE_HOME: join(root, "core"),
  AREAL_CORE_USER_HOME: join(root, "user"),
  AREAL_HARNESS_HOME: join(root, "harness"),
  AREAL_CORE_CONFIG: config,
  AREAL_GUI_USER_DATA: join(root, "electron"),
  NO_PROXY: "127.0.0.1,localhost",
  no_proxy: "127.0.0.1,localhost",
};
for (const key of [
  "ALL_PROXY",
  "all_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "AREAL_CORE_WORKSPACE",
  "AREAL_CORE_DESKTOP_CONFIG",
])
  delete env[key];
let app, page;
const errors = [],
  receipts = [];
const state = () => page.evaluate(() => window.arealDesktop.snapshot());
const button = (name) => page.getByRole("button", { name, exact: true });
async function call(name, params) {
  const result = await page.evaluate(
    async ({ name, params }) => window.arealDesktop.command(name, params),
    { name, params },
  );
  if (!result.ok) throw Error(result.error.message);
  return result.value;
}
async function until(predicate, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const value = await state();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw Error(
    `${label}: ${JSON.stringify((await state()).projects.map((p) => ({ id: p.id, error: p.error, connected: p.state?.connected })))}`,
  );
}
async function launch() {
  app = await electron.launch({
    executablePath: require("electron"),
    args: [join(gui, "app")],
    env,
    timeout: 120000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByTestId("areal-workbench").waitFor({ timeout: 120000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
}
async function quit() {
  if (!app) return;
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 });
  });
  await app.close();
  app = null;
}
const goalFrom = (s) =>
  Object.values(s.projects[0]?.state?.threads ?? {}).find(
    (t) => t.goals?.goal?.workflow === "rsiArtifact",
  );
try {
  await launch();
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, workspace);
  await button("不在项目中工作").click();
  await page.getByRole("menuitem", { name: "新建项目", exact: true }).click();
  await until((s) => s.projects[0]?.state?.connected, "connected");
  const pid = (await state()).projects[0].id;
  const input = () => page.getByTestId("chat-input");
  await input().fill("/rsi-goal GUI draft comparison");
  await button("发送").click();
  await page.getByTestId("rsi-goal").waitFor();
  await page.screenshot({ path: join(evidence, "gui-running.png") });
  let latest = await until(
    (s) => goalFrom(s)?.goals?.goal?.rsi?.phase === "awaitingSelection",
    "draft candidates settled",
  );
  const thread = goalFrom(latest);
  const layout = await page.getByTestId("rsi-goal").evaluate((el) => ({
    display: getComputedStyle(el.querySelector(".rsi-candidates")).display,
    border: getComputedStyle(el.querySelector(".rsi-candidate")).borderTopWidth,
  }));
  assert.equal(layout.display, "grid");
  assert.equal(layout.border, "1px");
  receipts.push({ stage: "draft", goal: thread.goals, layout });
  const winnerCard = page.getByRole("article", {
    name: "candidate-3 critic-and-revise",
    exact: true,
  });
  await winnerCard.getByRole("button", { name: "查看产物", exact: true }).click();
  await winnerCard.getByRole("button", { name: "继续读取", exact: true }).waitFor();
  while (await winnerCard.getByRole("button", { name: "继续读取", exact: true }).count()) {
    await winnerCard.getByRole("button", { name: "继续读取", exact: true }).click();
    await page.waitForTimeout(80);
  }
  assert((await winnerCard.innerText()).includes("END_candidate-3"));
  await winnerCard.getByRole("button", { name: "选择此产物", exact: true }).click();
  await until(
    (s) => goalFrom(s)?.goals?.goal?.rsi?.selectedCandidateId === "candidate-3",
    "winner persisted",
  );
  await page.getByTestId("rsi-goal").evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.screenshot({ path: join(evidence, "gui-selected.png") });
  await winnerCard.getByText("评测反馈与版本分叉", { exact: true }).click();
  await winnerCard
    .getByLabel("candidate-3 评测反馈", { exact: true })
    .fill("Improve structure while preserving output contract");
  await winnerCard.getByRole("button", { name: "记录评测", exact: true }).click();
  await until(
    (s) => goalFrom(s)?.goals?.goal?.rsi?.candidates[2]?.evaluations?.length === 1,
    "evaluation saved",
  );
  await winnerCard
    .getByLabel("candidate-3 改动假设", { exact: true })
    .fill("A shorter ordered checklist reduces omissions");
  await winnerCard
    .getByLabel("candidate-3 新版 Harness", { exact: true })
    .fill(
      "Build an ordered checklist, complete the artifact, inspect each requirement and correct omissions.",
    );
  await winnerCard.getByRole("button", { name: "从此版本分叉", exact: true }).click();
  await until(
    (s) =>
      goalFrom(s)?.goals?.goal?.rsi?.candidates.length === 4 &&
      goalFrom(s)?.goals?.goal?.rsi?.phase === "awaitingSelection",
    "evolution completed",
  );
  assert.equal(await page.getByRole("tree").getByRole("treeitem").count(), 4);
  latest = await state();
  assert.equal(goalFrom(latest).goals.goal.rsi.candidates[3].parentCandidateId, "candidate-3");
  const childCard = page.getByRole("article", { name: "candidate-4 revision-1", exact: true });
  await childCard.getByRole("button", { name: "选择此产物", exact: true }).click();
  await until(
    (s) => goalFrom(s)?.goals?.goal?.rsi?.selectedCandidateId === "candidate-4",
    "challenger promoted",
  );
  await page.getByRole("navigation", { name: "Harness 版本探索树" }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "gui-evolution-tree.png") });
  await quit();
  await launch();
  await until(
    (s) => goalFrom(s)?.goals?.goal?.rsi?.selectedCandidateId === "candidate-4",
    "GUI restart winner",
  );
  await page.getByTestId("rsi-goal").waitFor();
  await page.screenshot({ path: join(evidence, "gui-reopened.png") });
  await quit();
  // 显式关闭本测试独立 Core 服务，再用相同数据目录重开窗口。
  const instances = JSON.parse(
    (await executeCore(binary, ["service", "list", "--json"], { env, timeout: 30000 })).stdout,
  );
  const instance = instances.find(
    (instance) => instance.workspace === workspace && instance.state !== "stopped",
  );
  assert(instance, "isolated GUI Core service not found");
  await executeCore(binary, ["service", "stop", "--instance", instance.serviceId, "--json"], {
    env,
    timeout: 30000,
  });
  await launch();
  latest = await until(
    (s) => goalFrom(s)?.goals?.goal?.rsi?.selectedCandidateId === "candidate-4",
    "Core restart winner",
  );
  receipts.push({ stage: "coreRestart", goal: goalFrom(latest).goals });
  assert.equal(model.groups.size, 1);
  assert.equal(model.groups.values().next().value.starts.length, 4);
  const cleared = await call("manage", {
    projectId: pid,
    operation: "goalClear",
    threadId: thread.id,
    goalId: thread.goals.goal.id,
    expectedRevision: goalFrom(latest).goals.revision,
  });
  assert.equal(cleared.goal, null);
  await input().fill("/rsi-goal GUI existing comparison");
  await button("发送").click();
  latest = await until(
    (s) => goalFrom(s)?.goals?.goal?.rsi?.phase === "awaitingSelection",
    "existing candidates settled",
  );
  assert.equal(goalFrom(latest).id, thread.id);
  assert.equal(model.groups.size, 2);
  receipts.push({ stage: "existing", goal: goalFrom(latest).goals });
  await page
    .getByRole("article", { name: "candidate-1 baseline", exact: true })
    .getByRole("button", { name: "选择此产物", exact: true })
    .click();
  await until(
    (s) => goalFrom(s)?.goals?.goal?.rsi?.selectedCandidateId === "candidate-1",
    "existing winner selected",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(model.failures, []);
  await writeFile(
    join(evidence, "gui-receipt.json"),
    JSON.stringify(
      {
        root,
        workspace,
        binary,
        model: "scripted fixture with actual native Runtime",
        receipts,
        rendererErrors: errors,
      },
      null,
      2,
    ),
  );
  console.log(`RSI_GUI_OK ${evidence}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(evidence, "gui-failure.png") }).catch(() => {});
    await writeFile(
      join(evidence, "gui-failure-state.json"),
      JSON.stringify(await state().catch(() => null), null, 2),
    );
  }
  throw error;
} finally {
  await quit();
  try {
    const { ServiceConnection } = require(join(gui, "app/src/core/service-client.cjs"));
    const { readFile } = await import("node:fs/promises");
    const connection = new ServiceConnection();
    try {
      await connection.connect(JSON.parse(await readFile(join(root, "core/service.json"), "utf8")));
      await connection.request("stopService", { protocol: "areal.desktop-service.v1" }, true);
    } finally {
      connection.close();
    }
  } catch {
    /* 错误证据已保存；只终止本次 home 的已登记 Core。 */
    const instances = JSON.parse(
      (await executeCore(binary, ["service", "list", "--json"], { env, timeout: 30000 })).stdout,
    );
    for (const instance of instances.filter(
      (i) => i.workspace === workspace && i.state !== "stopped",
    ))
      await executeCore(
        binary,
        ["service", "stop", "--instance", instance.serviceId, "--cancel", "--json"],
        { env, timeout: 30000 },
      );
  }
  model.server.closeAllConnections();
  await new Promise((resolve) => model.server.close(resolve));
}
