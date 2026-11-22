// 网页业务旅程（W0–W6）：真实 Host 和 Core，外部模型是本地假模型，界面在 Chromium 里打开 Host 的本机网页。
// 网页与桌面是同一份界面、同一套 Host 协议，所以这里通过的业务旅程不必再在 Mac 上逐项点一遍。
// Electron 登记资料库来源，并保持原生附件连接直到旅程结束。
// 先构建 Core（make build）和界面（pnpm --dir clients/gui build），再运行：
//   node clients/gui/scripts/web-journeys.mjs [--out <截图目录>]
// Linux 没有显示服务时用 xvfb-run 包一层；浏览器下载不到时设 AREAL_CHROMIUM 指向已装好的 Chromium。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  coreBin,
  createScene,
  gui,
  playwright,
  reply,
  sendReady,
  startModel,
} from "./support/journey-fixture.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
import { expectFeedback, inspectPage, recordToasts } from "./ux-checks.mjs";
import {
  cleanupSyntheticHostKeychain,
  closeSmokeApplication,
  makeFixtureDirectoriesWritable,
  stopAndAssertFixtureHost,
} from "./application-cleanup.mjs";

const outIndex = process.argv.indexOf("--out");
const reportPath = process.env.AREAL_JOURNEY_REPORT
  ? resolve(process.env.AREAL_JOURNEY_REPORT)
  : null;
const shots = resolve(
  reportPath
    ? dirname(reportPath)
    : outIndex > 0
      ? process.argv[outIndex + 1]
      : join(tmpdir(), "areal-web-shots"),
);
const journeyReportPath = reportPath ?? join(shots, "report.json");
const factIds = ["coldStartFirstSend", "requestAccepted", "turnSettled", "visibleResult"];
const journeyReport = {
  schemaVersion: 1,
  journeyId: "conversation-submit",
  identity: process.env.AREAL_VERIFICATION_IDENTITY
    ? JSON.parse(process.env.AREAL_VERIFICATION_IDENTITY)
    : {},
  status: "pending",
  facts: factIds.map((id) => ({ id, status: "pending", evidence: [] })),
  firstFailure: null,
  reached: [],
  unreached: [...factIds],
  cleanup: { status: "pending", evidence: [] },
  scope:
    "Source Electron owner, real Host/Core and Chromium Renderer; local model; mobile and packaged app not run",
};
let stage = "prerequisites";
await mkdir(shots, { recursive: true });
const persistEvidence = (name, value) =>
  writeFile(join(shots, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const saveJourneyReport = () =>
  writeFile(journeyReportPath, JSON.stringify(journeyReport, null, 2), { mode: 0o600 });
async function passFact(id, observations, extraFiles = []) {
  const name = `${id}.json`;
  await persistEvidence(name, observations);
  Object.assign(
    journeyReport.facts.find((fact) => fact.id === id),
    {
      status: "passed",
      evidence: [name, ...extraFiles],
      observations,
    },
  );
  journeyReport.reached.push(id);
  journeyReport.unreached = factIds.filter((item) => !journeyReport.reached.includes(item));
  await saveJourneyReport();
}
const results = [];
const record = (result) => {
  results.push(result);
  if (result.problems.length) console.log(`✗ ${result.step}: ${result.problems.join("；")}`);
  else console.log(`✓ ${result.step}`);
};
const model = await startModel();
const scene = await createScene("areal-web-");
let browser;
let page;
let desktop;
let cleanupFailure;
const shot = (step) => page.screenshot({ path: join(shots, `web-${step}.png`) });
const unknownSend = { armed: false, dropped: false, requestId: null };
const sends = [];
// 仅观察原请求身份和准入结果；不记录正文、凭据、票据或恢复请求的参数。
const commandTrace = [];

// The browser talks to the real Host loopback socket.  For one explicit
// acceptance case, discard only the response to a send that Host has already
// accepted, then close the owned proxy pair.  This produces the same UNKNOWN
// boundary as a lost browser response without replaying the command.
function dropOneAcceptedSend(socket) {
  const server = socket.connectToServer();
  const pending = new Set();
  const sendRequests = new Map();
  const commands = new Map();
  socket.onMessage((message) => {
    const envelope = JSON.parse(message.toString());
    if (
      [
        "project.activate",
        "session.create",
        "session.send",
        "desktop.command",
        "shell.subscribe",
      ].includes(envelope.method)
    ) {
      const trace = {
        method: envelope.method,
        command: envelope.method === "desktop.command" ? envelope.params?.command : undefined,
        commandId: envelope.commandId ?? null,
        projectId: envelope.context?.projectId ?? null,
        serviceGeneration: envelope.context?.serviceGeneration ?? null,
      };
      commands.set(envelope.id, trace);
      commandTrace.push(trace);
    }
    if (envelope.method === "session.send") {
      const observation = { requestId: envelope.commandId ?? envelope.params?.requestId ?? null };
      sendRequests.set(envelope.id, observation);
      sends.push(observation);
    }
    if (
      unknownSend.armed &&
      envelope.method === "session.send" &&
      envelope.params?.text === "触发 UNKNOWN 核对"
    ) {
      unknownSend.armed = false;
      unknownSend.requestId = envelope.commandId ?? envelope.params?.requestId ?? null;
      pending.add(envelope.id);
    }
    server.send(message);
  });
  server.onMessage((message) => {
    const envelope = JSON.parse(message.toString());
    const trace = commands.get(envelope.id);
    if (trace) {
      trace.admissionState = envelope.result?.admissionState ?? null;
      trace.errorCode = envelope.error?.code ?? envelope.result?.error?.code ?? null;
      trace.submissionUnknown =
        envelope.result?.submissionUnknown ?? envelope.error?.submissionUnknown ?? null;
      trace.returnedGeneration = envelope.result?.serviceGeneration ?? null;
      if (trace.method === "shell.subscribe")
        trace.projects = envelope.result?.snapshot?.projects?.map(
          ({ projectId, state, serviceGeneration }) => ({ projectId, state, serviceGeneration }),
        );
      commands.delete(envelope.id);
    }
    const observation = sendRequests.get(envelope.id);
    if (observation) {
      observation.admissionState = envelope.result?.admissionState ?? null;
      observation.errorCode = envelope.error?.code ?? envelope.result?.error?.code ?? null;
      observation.coreCode = envelope.result?.error?.coreCode ?? null;
      sendRequests.delete(envelope.id);
    }
    if (
      pending.has(envelope.id) &&
      envelope.result?.admissionState === "accepted" &&
      !envelope.error
    ) {
      pending.delete(envelope.id);
      unknownSend.dropped = true;
      void Promise.allSettled([socket.close(), server.close()]);
      return;
    }
    socket.send(message);
  });
}

// 清理隔离现场前只保存已审查的边界诊断；不复制原始日志、配置、凭据或模型正文。
async function preserveHostDiagnostics() {
  const registry =
    desktop?.env.AREAL_HARNESS_SERVICE_HOME ?? join(scene.scratch, "web", "registry");
  const diagnostics = { host: [], services: [] };
  const log = await readFile(join(registry, "host.log"), "utf8").catch(() => "");
  diagnostics.host = log
    .split("\n")
    .filter((line) =>
      /^Host (execution preparation failed:|Core attach unavailable:|workspace admission failed:|workspace admission connection:|activity unavailable:|service observation incomplete:|GUI (network|hook|resource) preparation unavailable; using history-only Core$)/.test(
        line,
      ),
    )
    .slice(-200)
    .map((line) =>
      // reason 可能来自领域错误文本；保留前面的结构化类别即可。
      line
        .split(" reason=")[0]
        .replace(/[^a-zA-Z0-9_ .:=(),{}"/+-]/g, "?")
        .slice(0, 1000),
    );
  const services = join(registry, "services");
  for (const entry of await readdir(services, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const service = await readFile(join(services, entry.name, "service.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (!service) continue;
    const { serviceId, generation, state, hostPid, corePid } = service;
    diagnostics.services.push({ serviceId, generation, state, hostPid, corePid });
  }
  await writeFile(join(shots, "host-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
}

try {
  // 桌面第一次启动时登记资料库来源和 Host 启动配置。
  desktop = await scene.launchDesktop("web", model.port);
  const env = desktop.env;
  const { port } = JSON.parse(
    await readFile(join(env.AREAL_HARNESS_SERVICE_HOME, "host/web-bind.json"), "utf8"),
  );
  console.log(`… Host 网页在 127.0.0.1:${port}，保留 Electron owner 直到网页旅程结束`);

  browser = await playwright.chromium.launch({
    executablePath: process.env.AREAL_CHROMIUM || undefined,
    args: process.getuid?.() === 0 ? ["--no-sandbox"] : [],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  });
  await context.routeWebSocket(/\/host\/socket$/, dropOneAcceptedSend);
  await context.addInitScript(recordToasts);
  page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // 旅程 W0：浏览器第一次打开要本机批准；批准后进入工作台。
  await page.goto(`http://127.0.0.1:${port}/`);
  const pending = page.getByText(/areal host web approve [0-9a-f-]{36}/);
  await pending.waitFor({ timeout: 60_000 });
  // 批准页按设计要显示带设备标识的命令，不做“无原始标识”检查。
  await shot("pairing");
  const device = (await pending.innerText()).match(/approve ([0-9a-f-]{36})/)[1];
  execFileSync(
    coreBin,
    ["host", "web", "approve", device, "--scope", "observe,submit,approve,manage"],
    { env, stdio: "ignore" },
  );
  await page.getByText("检查批准状态").click();
  await page.getByTestId("chat-input").first().waitFor({ timeout: 60_000 });
  record(await inspectPage(page, "W0 批准后进入工作台"));

  // 旅程 W1：网页里按路径打开项目，新建对话。
  page.once("dialog", (dialog) => dialog.accept(scene.project));
  const categories = page.locator('button[aria-label="项目分类"]');
  if ((await categories.getAttribute("aria-expanded")) === "false") await categories.click();
  await page.locator('button[aria-label="打开项目"]').click();
  const choice = page.getByRole("menuitem").first();
  if (await choice.isVisible().catch(() => false)) await choice.click();
  const create = page.locator('button[aria-label="在项目 demo 中新建对话"]');
  await create.waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const button = document.querySelector('button[aria-label="在项目 demo 中新建对话"]');
      return button instanceof HTMLButtonElement && !button.disabled;
    },
    { timeout: 60_000 },
  );
  await shot("project");
  record(await inspectPage(page, "W1 网页打开项目"));
  await create.click({ force: true });

  const workbench = page.getByTestId("areal-workbench");
  // 新对话先是项目草稿，首条消息被 Host 受理后才有 Thread ID。
  await workbench.waitFor();
  const projectId = await workbench.getAttribute("data-project-id");
  assert.ok(projectId, "草稿属于刚刚打开的项目");
  assert.ok(!(await workbench.getAttribute("data-thread-id")), "创建草稿不提前分配会话");
  const mainComment = {
    id: "web-main-review-comment",
    path: "src/math.ts",
    root: scene.project,
    scope: "working-tree",
    ref: "",
    token: "web-journey-review",
    head: "head",
    base: "base",
    side: "additions",
    start: 1,
    end: 1,
    snippet: "export const add = (a: number, b: number) => a + b;",
    body: "网页主会话结构化评论",
  };
  const newReviewKey = `areal-gui:review-comments:${projectId}:new`;
  await page.evaluate(
    ({ key, comment }) => {
      localStorage.setItem(key, JSON.stringify({ comments: [comment], attachedIds: [comment.id] }));
      window.dispatchEvent(new CustomEvent("areal-review-comments-change", { detail: key }));
    },
    { key: newReviewKey, comment: mainComment },
  );
  await page.getByRole("button", { name: "1 个评论", exact: true }).waitFor();

  // 旅程 W2：发送 → 审批卡出现、输入框仍在 → 审批中继续排队 → 允许 → 本轮完成。
  stage = "coldStartFirstSend";
  const input = page.getByTestId("chat-input").first();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("radio", { name: "fixture", exact: true }).click();
  await input.fill("给 src/math.ts 加一个 clamp 函数");
  await sendReady(page);
  const w2SendCheck = await expectFeedback(page, "W2 回车发送", () => input.press("Enter"), {
    until: page.locator(".messages").getByText("给 src/math.ts 加一个 clamp 函数"),
  });
  record(w2SendCheck);
  const approval = page.locator('.decision-card[data-interaction="approval"]');
  await approval.waitFor({ timeout: 60_000 });
  const threadId = await workbench.getAttribute("data-thread-id");
  assert.equal(await workbench.getAttribute("data-project-id"), projectId);
  assert.ok(threadId, "Host 受理首条消息后发布原会话身份");
  const createTraces = commandTrace.filter((entry) => entry.method === "session.create");
  assert.equal(createTraces.length, 1, "FM-CHAT-01: 冷项目首条发送应一次受理，不得重试多次创建");
  const firstCreate = createTraces[0];
  assert.equal(
    firstCreate.admissionState,
    "accepted",
    "FM-CHAT-01: 首次 session.create 必须直接受理",
  );
  assert.equal(firstCreate.errorCode, null, "FM-CHAT-01: 首次发送不得返回任何错误码");
  assert.notEqual(firstCreate.submissionUnknown, true, "FM-CHAT-01: 首次发送不得落入 UNKNOWN");
  await shot("approval");
  await passFact(
    "coldStartFirstSend",
    {
      ruleId: "FM-CHAT-01",
      projectId,
      commandId: firstCreate.commandId,
      admissionState: firstCreate.admissionState,
      errorCode: firstCreate.errorCode,
      createAttempts: createTraces.length,
      bypassedReadinessProbe: false,
    },
    ["web-approval.png"],
  );
  stage = "requestAccepted";
  await passFact("requestAccepted", {
    projectId,
    threadId,
    commandId: firstCreate.commandId,
    serviceGeneration: firstCreate.returnedGeneration ?? firstCreate.serviceGeneration ?? null,
    admissionState: firstCreate.admissionState,
  });
  stage = "turnSettled";
  const mainReviewKey = `areal-gui:review-comments:${projectId}:${threadId}`;
  assert.equal(await input.isVisible(), true, "审批时输入框仍在");
  record(await inspectPage(page, "W2 等审批"));
  await input.fill("顺便把 README 也更新");
  record(
    await expectFeedback(page, "W2 审批中排队", () => input.press("Enter"), {
      until: page.locator(".composer-queue"),
    }),
  );
  await approval
    .getByRole("button", { name: /允许/ })
    .first()
    .click();
  await page
    .getByText(reply.split("\n")[0].replace("## ", ""))
    .first()
    .waitFor({ timeout: 60_000 });
  const sentMainComment = page.getByRole("button", { name: "已发送的 1 个评论", exact: true });
  await sentMainComment.waitFor();
  await sentMainComment.click();
  await page.getByText(mainComment.body, { exact: true }).waitFor();
  const authoritative = await readCoreThread({
    binary: coreBin,
    env: desktop.env,
    gui,
    threadId,
    workspace: scene.project,
  });
  const firstTurn = authoritative.turns?.[0];
  assert.equal(authoritative.id, threadId, "权威 Core Thread ID 必须与页面一致");
  assert.ok(firstTurn?.id, "权威 Core 必须记录首条 Turn 身份");
  assert.equal(firstTurn.status, "completed", "权威 Core 首条 Turn 必须结算为 completed");
  await passFact("turnSettled", {
    threadId: authoritative.id,
    turnId: firstTurn.id,
    status: firstTurn.status,
    commandId: firstCreate.commandId,
  });
  stage = "visibleResult";
  const w2VisibleCheck = await inspectPage(page, "W2 首轮可见结果");
  record(w2VisibleCheck);
  assert.deepEqual(w2SendCheck.problems, [], "W2 首条发送交互体检无告警");
  assert.deepEqual(w2VisibleCheck.problems, [], "W2 首轮可见结果体检无告警");
  assert.deepEqual(pageErrors, [], "W2 首轮完成前无未捕获页面异常");
  await shot("first-turn-visible");
  await passFact(
    "visibleResult",
    {
      threadId,
      turnId: firstTurn.id,
      replyVisible: true,
      reviewCommentVisible: true,
      uxProblems: w2VisibleCheck.problems.length,
      pageErrors: pageErrors.length,
    },
    ["web-first-turn-visible.png"],
  );
  stage = "followUpAndOtherJourneys";

  // 先结算队列条目触发的审批，UNKNOWN 注入必须命中空闲会话的下一次发送。
  const pendingApproval = page
    .getByTestId("chat-view")
    .locator('.decision-card[data-interaction="approval"]');
  await pendingApproval
    .getByRole("button", { name: /拒绝/ })
    .first()
    .click();
  await pendingApproval.waitFor({ state: "detached", timeout: 60_000 });
  await page
    .locator('[data-turn-status="completed"][data-latest-turn="true"]')
    .filter({ hasText: "顺便把 README 也更新" })
    .waitFor({ timeout: 60_000 });

  // 旅程 W2b：真实 Host 已受理但浏览器丢失回执。自动核对原 requestId
  // 后只消费该评论，历史里的结构化 part 仍来自 Core 的权威快照。
  const unknownComment = {
    ...mainComment,
    id: "web-unknown-review-comment",
    body: "网页 UNKNOWN 后核对的评论",
  };
  await page.evaluate(
    ({ key, comment }) => {
      localStorage.setItem(key, JSON.stringify({ comments: [comment], attachedIds: [comment.id] }));
      window.dispatchEvent(new CustomEvent("areal-review-comments-change", { detail: key }));
    },
    { key: mainReviewKey, comment: unknownComment },
  );
  unknownSend.armed = true;
  await input.fill("触发 UNKNOWN 核对");
  await sendReady(page);
  await input.press("Enter");
  const originalSubmission = await page.waitForFunction(
    (key) => JSON.parse(localStorage.getItem(key) || "{}").submission?.requestId,
    mainReviewKey,
    { timeout: 60_000 },
  );
  assert.ok(unknownSend.dropped && unknownSend.requestId, "原发送的受理回执已按夹具预期丢失");
  assert.equal(
    await originalSubmission.jsonValue(),
    unknownSend.requestId,
    "草稿引用与丢失的原请求一致",
  );
  await page.reload();
  await page.getByTestId("chat-input").first().waitFor({ timeout: 60_000 });
  const unknownMessage = page.locator(".messages").getByText("触发 UNKNOWN 核对", { exact: true });
  await unknownMessage.waitFor({ timeout: 60_000 });
  await page.waitForFunction(
    (key) => {
      const value = JSON.parse(localStorage.getItem(key) || '{"comments":[]}');
      return value.comments.length === 0 && value.submission === undefined;
    },
    mainReviewKey,
    { timeout: 60_000 },
  );
  const unknownCommentButton = page
    .getByRole("button", { name: "已发送的 1 个评论", exact: true })
    .last();
  await unknownCommentButton.click();
  await page.getByText(unknownComment.body, { exact: true }).waitFor();
  record(await inspectPage(page, "W2b UNKNOWN 原请求核对"));
  await shot("done");
  record(await inspectPage(page, "W2 本轮完成"));
  await pendingApproval
    .getByRole("button", { name: /拒绝/ })
    .first()
    .click();
  await pendingApproval.waitFor({ state: "detached", timeout: 60_000 });

  // 旅程 W3：刷新后对话还在（Host 是唯一真相，不靠页面内存）。
  await page.reload();
  await page.getByText("已添加 clamp").first().waitFor({ timeout: 60_000 });
  await page.getByRole("button", { name: "已发送的 1 个评论", exact: true }).first().click();
  await page.getByText(mainComment.body, { exact: true }).waitFor();
  record(await inspectPage(page, "W3 刷新后对话仍在"));

  // 旅程 W6：侧边聊天经 Host 附加观察显示：打开、发送后右侧能看到自己的问题和回复进度，不依赖桌面后台快照。
  const sideComment = "网页 Side 结构化评论";
  await input.fill("/side");
  await page
    .getByRole("option", { name: /\/side/ })
    .first()
    .click();
  const sidePane = page.getByTestId("side-chat-pane").filter({ visible: true });
  const sideInput = sidePane.getByTestId("side-chat-input");
  await sideInput.waitFor({ timeout: 60_000 });
  const sideThreadId = await sidePane.getAttribute("data-thread-id");
  assert.match(sideThreadId ?? "", /^[0-9a-f-]{36}$/i);
  // Side 草稿在内存中，通过子会话自己的轮次审查保存评论。
  await sideInput.fill("准备一处侧边审查改动");
  await sidePane.getByTestId("side-chat-send").click();
  const sideReview = sidePane.getByRole("button", { name: "查看变更", exact: true });
  const sideApproval = sidePane.locator('.decision-card[data-interaction="approval"]');
  const reviewTurn = sidePane
    .locator('[data-turn-status="completed"][data-latest-turn="true"]')
    .filter({ hasText: "准备一处侧边审查改动" });
  await reviewTurn.or(sideApproval).first().waitFor({ timeout: 60_000 });
  if (await sideApproval.isVisible()) {
    await sideApproval
      .getByRole("button", { name: /允许/ })
      .first()
      .click();
  }
  // 历史窗口延迟读取成功工具的正文；审查入口需要原文件回执。
  await reviewTurn.getByRole("button", { name: /工作了/ }).click();
  await reviewTurn.locator("button.tool-summary-row").filter({ hasText: "side-review.ts" }).click();
  await sideReview.click();
  const reviewLine = sidePane
    .locator('[data-line][data-line-type="change-addition"]')
    .filter({ hasText: /export const sideReview/ });
  await reviewLine.click();
  await sidePane.getByRole("button", { name: "变更选项" }).click();
  await page.getByRole("menuitem", { name: "评论所选行" }).click();
  await sidePane.getByRole("textbox", { name: "审查评论" }).fill(sideComment);
  await sidePane.getByRole("button", { name: "保存评论" }).click();
  await sidePane.getByRole("button", { name: "返回聊天" }).click();
  await sidePane.getByRole("button", { name: "1 个评论", exact: true }).waitFor();
  await sideInput.fill("侧边：这个函数叫什么");
  await sidePane.getByTestId("side-chat-send").click();
  await sidePane.getByText("侧边：这个函数叫什么").first().waitFor({ timeout: 60_000 });
  await sidePane
    .locator('.decision-card, :text("添加 clamp")')
    .first()
    .waitFor({ timeout: 60_000 });
  const sentSideComment = sidePane.getByRole("button", { name: "已发送的 1 个评论", exact: true });
  const sentSideCommentBody = page
    .locator('[data-slot="popover-content"]')
    .filter({ hasText: "已发送的审查评论" })
    .getByText(sideComment, { exact: true });
  await sentSideComment.waitFor();
  await sentSideComment.click();
  await sentSideCommentBody.waitFor();
  await page.keyboard.press("Escape");
  const completedSideTurn = sidePane
    .locator('[data-turn-status="completed"][data-latest-turn="true"]')
    .filter({ hasText: "侧边：这个函数叫什么" });
  await completedSideTurn.or(sideApproval).first().waitFor({ timeout: 60_000 });
  if (await sideApproval.isVisible()) {
    await sideApproval
      .getByRole("button", { name: /拒绝/ })
      .first()
      .click();
    await sideApproval.waitFor({ state: "detached", timeout: 60_000 });
  }
  await completedSideTurn.waitFor({ timeout: 60_000 });
  // Side 标签归当前连接。通过审查面板重挂聊天，检查原子会话的结构化评论。
  await sideReview.first().click();
  await sideInput.waitFor({ state: "detached" });
  await sidePane.getByRole("button", { name: "返回聊天" }).click();
  assert.equal(await sidePane.getAttribute("data-thread-id"), sideThreadId);
  await page
    .getByTestId("side-chat-pane")
    .getByRole("button", { name: "已发送的 1 个评论", exact: true })
    .click();
  await sentSideCommentBody.waitFor();
  await shot("side-chat");
  record(await inspectPage(page, "W6 侧边聊天"));

  // 旅程 W5：待主会话与辅助会话的活动结算，再检查取消和确认归档。
  await page
    .locator('[role="img"][aria-label="运行中"]')
    .waitFor({ state: "detached", timeout: 60_000 });
  const archiveButton = page.locator('button[aria-label^="归档 "]').first();
  const archiveTitle = (await archiveButton.getAttribute("aria-label")).slice(3);
  const confirmDialog = page.getByRole("dialog").filter({ hasText: "归档此会话？" });
  await archiveButton.click({ force: true });
  await confirmDialog.waitFor();
  await shot("archive-confirm");
  await confirmDialog.getByRole("button", { name: "取消" }).click();
  await confirmDialog.waitFor({ state: "hidden" });
  assert.equal(await archiveButton.count(), 1, "取消后会话仍在");
  await archiveButton.click({ force: true });
  await confirmDialog.getByRole("button", { name: "归档", exact: true }).click();
  await page
    .locator(`button[aria-label="归档 ${archiveTitle}"]`)
    .waitFor({ state: "detached", timeout: 60_000 });
  record(await inspectPage(page, "W5 归档先确认"));

  // 旅程 W4：设置页能打开模型设置。
  await page.locator('button[aria-label*="设置"]').first().click();
  await page.locator(".settings-navigation-item").first().waitFor();
  await shot("settings");
  record(await inspectPage(page, "W4 设置页"));

  assert.deepEqual(pageErrors, [], "页面没有未捕获异常");
} catch (error) {
  console.error("旅程失败：", error);
  if (!journeyReport.firstFailure) {
    journeyReport.firstFailure = {
      stage,
      message: error instanceof Error ? error.message : String(error),
    };
    const activeFact = journeyReport.facts.find((fact) => fact.id === stage);
    if (activeFact && activeFact.status === "pending") activeFact.status = "failed";
  }
  if (page) {
    await page.screenshot({ path: join(shots, "web-failure.png") }).catch(() => {});
    const text = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    console.log(`失败时页面正文：\n${text.slice(0, 2000)}`);
  }
  throw error;
} finally {
  await preserveHostDiagnostics().catch((error) => {
    console.error("Host 诊断保存失败：", error.code ?? error.name);
  });
  await browser?.close();
  await writeFile(
    join(shots, "journey-result.json"),
    JSON.stringify({ results, unknownSend, sends, commandTrace }, null, 2),
  );
  try {
    if (desktop) {
      const pid = desktop.app.process().pid;
      await closeSmokeApplication(desktop.app);
      await writeFile(join(shots, "electron-exit.json"), JSON.stringify({ pid, code: 0 }));
      await stopAndAssertFixtureHost(coreBin, desktop.env, shots, { pid });
      await cleanupSyntheticHostKeychain(desktop.env.AREAL_HARNESS_SERVICE_HOME, scene.scratch);
      await writeFile(
        join(shots, "cleanup.json"),
        JSON.stringify({ electronPid: pid, stopped: true }),
      );
      await makeFixtureDirectoriesWritable(scene.scratch);
      await rm(scene.scratch, { recursive: true, force: true, maxRetries: 5 });
    } else {
      await scene.dispose();
      await writeFile(join(shots, "cleanup.json"), JSON.stringify({ disposed: true }));
    }
    journeyReport.cleanup = { status: "passed", evidence: ["cleanup.json"] };
  } catch (error) {
    await writeFile(join(shots, "cleanup-error.txt"), String(error)).catch(() => {});
    cleanupFailure = error;
    journeyReport.cleanup = {
      status: "failed",
      evidence: ["cleanup-error.txt"],
      message: error instanceof Error ? error.message : String(error),
    };
    if (!journeyReport.firstFailure) {
      journeyReport.firstFailure = {
        stage: "cleanup",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    console.error("旅程清理失败：", error);
  } finally {
    model.close();
  }
  const failedSteps = results.filter((result) => result.problems.length);
  if (failedSteps.length && !journeyReport.firstFailure) {
    journeyReport.firstFailure = {
      stage: failedSteps[0].step,
      message: failedSteps[0].problems.join("；"),
    };
  }
  journeyReport.unreached = factIds.filter((item) => !journeyReport.reached.includes(item));
  journeyReport.status =
    !journeyReport.firstFailure &&
    journeyReport.facts.every((fact) => fact.status === "passed") &&
    journeyReport.cleanup.status === "passed"
      ? "passed"
      : "failed";
  await saveJourneyReport();
}
if (cleanupFailure) throw cleanupFailure;
const failed = results.filter((result) => result.problems.length);
console.log(
  `${results.length - failed.length}/${results.length} 步通过；截图与业务报告在 ${shots}`,
);
process.exit(failed.length ? 1 : 0);
