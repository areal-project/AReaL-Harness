import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
import { makeTempDir } from "./support/temp.mjs";
const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(gui, "app/package.json"));
const { chromium } = require("playwright-core");
const evidence = await makeTempDir("areal-scheduled-ui-");
const vite = await createServer({
  root: join(gui, "renderer"),
  configFile: join(gui, "renderer/vite.config.ts"),
  mode: "design-system",
  server: { host: "127.0.0.1", port: 0 },
  plugins: [
    {
      name: "scheduled-fixture",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url.startsWith("/__scheduled.html")) return next();
          res.setHeader("Content-Type", "text/html");
          res.end(
            await server.transformIndexHtml(
              "/__scheduled.html",
              '<html><body style="margin:0"><div id="root"></div><script type="module" src="/test-fixtures/scheduled-workspace.tsx"></script></body></html>',
            ),
          );
        });
      },
    },
  ],
});
let browser,
  page,
  passed = false;
const errors = [],
  recoveryResults = [];
try {
  await vite.listen();
  browser = await chromium.launch({
    executablePath:
      process.env.AREAL_CHROMIUM_BIN ||
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on("pageerror", (e) => errors.push(e.message));
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/__scheduled.html`;
  await page.goto(url + "?legacy");
  await page.getByText("后台版本过旧，无法读取任务目录。", { exact: false }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.calls)).filter((call) => call.name === "tasks").length,
    0,
  );
  assert.equal(await page.getByText("尚无定时任务", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "重新加载任务", exact: true }).count(), 0);
  await page.screenshot({ path: join(evidence, "00-legacy-catalog.png") });
  await page.evaluate(() => window.publishContract(true));
  await page.getByRole("button", { name: "打开自动化 每日进展", exact: true }).waitFor();
  await page.evaluate(() => window.publishContract(false));
  await page.getByText("后台版本过旧，无法读取任务目录。", { exact: false }).waitFor();
  const readsBeforeFocus = (await page.evaluate(() => window.calls)).filter(
    (call) => call.name === "tasks",
  ).length;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  assert.equal(
    (await page.evaluate(() => window.calls)).filter((call) => call.name === "tasks").length,
    readsBeforeFocus,
  );
  assert.equal(
    await page.getByRole("button", { name: "打开自动化 每日进展", exact: true }).count(),
    1,
    "loaded tasks survive an incompatible backend",
  );
  await page.goto(url);
  await page.getByRole("button", { name: "打开自动化 每日进展", exact: true }).waitFor();
  assert.equal(await page.getByRole("combobox", { name: "运行位置筛选" }).count(), 0);
  assert.equal(await page.getByLabel("筛选任务", { exact: true }).count(), 0);
  assert.equal(await page.getByText("项目加载状态", { exact: true }).count(), 0);
  await page
    .getByRole("group", { name: "已开启", exact: true })
    .getByRole("button", { name: "打开自动化 每日进展" })
    .waitFor();
  await page
    .getByRole("group", { name: "已暂停", exact: true })
    .getByRole("button", { name: "打开自动化 每周回顾" })
    .waitFor();
  assert.equal(
    await page.locator(".scheduled-workspace").evaluate((el) => getComputedStyle(el).display),
    "flex",
  );
  assert.ok(
    !(await page.locator("body").innerText()).includes("00000000-0000-4000-a000-000000000001"),
  );
  await page.screenshot({ path: join(evidence, "01-groups.png") });
  await page.getByRole("button", { name: "搜索定时任务", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索定时任务", exact: true }).fill("每周");
  assert.equal(await page.getByRole("button", { name: "打开自动化 每日进展" }).count(), 0);
  await page.getByRole("button", { name: "打开自动化 每周回顾" }).click();
  await page.getByRole("heading", { name: "每周回顾", exact: true }).waitFor();
  await page.setViewportSize({ width: 480, height: 800 });
  await page.getByTestId("task-center-list").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByTestId("task-center-list").waitFor();
  await page.goto(url + "?empty");
  await page.getByText("尚无定时任务", { exact: true }).waitFor();
  await page.screenshot({ path: join(evidence, "02-narrow-empty.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  for (const scope of ["global", "project"]) {
    await page.goto(url + "?empty" + (scope === "project" ? "&project" : ""));
    await page.getByRole("button", { name: "整理每日计划", exact: false }).click();
    const drafts = await page.evaluate(() => window.drafts);
    assert.deepEqual(drafts, [
      {
        projectId: scope === "project" ? "00000000-0000-4000-a000-000000000001" : undefined,
        text: "帮我创建一个定时任务：回顾我提供的计划，整理当天待办和需要关注的事项。",
      },
    ]);
    assert.equal(
      (await page.evaluate(() => window.calls)).filter((call) =>
        ["create", "projectless", "reconcile"].includes(call.name),
      ).length,
      0,
    );
    assert.equal(
      await page.evaluate(() => localStorage.getItem("areal-gui:ordinary-schedule-creation")),
      null,
    );
  }
  await page.goto(url + "?fail");
  await page.getByRole("button", { name: "重新加载任务", exact: true }).waitFor();
  assert.equal(await page.getByText("尚无定时任务", { exact: true }).count(), 0);
  await page.evaluate(() => (window.fail = false));
  await page.getByRole("button", { name: "重新加载任务", exact: true }).click();
  await page.getByRole("button", { name: "打开自动化 每日进展" }).waitFor();
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(url + "?empty");
  await page.getByRole("button", { name: "整理每日计划", exact: false }).click();
  assert.deepEqual(await page.evaluate(() => window.drafts), [
    {
      projectId: "00000000-0000-4000-a000-000000000001",
      text: "帮我创建一个定时任务：回顾我提供的计划，整理当天待办和需要关注的事项。",
    },
  ]);
  assert.equal(
    (await page.evaluate(() => window.calls)).filter((call) =>
      ["create", "projectless"].includes(call.name),
    ).length,
    0,
    "new creation only stages a draft without allocating a Thread",
  );
  for (const mode of ["unresolved", "completed", "observed-completed"]) {
    const result = { mode, passed: false };
    try {
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
        // Preserve a pre-draft-flow request to exercise legacy recovery, not new creation.
        localStorage.setItem(
          "areal-gui:ordinary-schedule-creation",
          JSON.stringify({
            prepareId: crypto.randomUUID(),
            requestId: crypto.randomUUID(),
            text: "帮我创建一个定时任务：回顾我提供的计划，整理当天待办和需要关注的事项。",
          }),
        );
      });
      await page.goto(url + "?empty&recovery=" + mode);
      await page.getByRole("button", { name: "整理每日计划", exact: false }).click();
      await page.getByRole("button", { name: "检查操作状态", exact: true }).first().waitFor();
      const original = await page.evaluate(() =>
        JSON.parse(localStorage.getItem("areal-gui:ordinary-schedule-creation")),
      );
      assert.equal(original.pending, true);
      assert.equal(original.projectId, "00000000-0000-4000-a000-000000000001");
      assert.equal(
        original.text,
        "帮我创建一个定时任务：回顾我提供的计划，整理当天待办和需要关注的事项。",
      );
      if (mode === "observed-completed") {
        await page.evaluate(() => window.publishOutcome());
        await page.waitForFunction(
          () =>
            JSON.parse(localStorage.getItem("areal-gui:ordinary-schedule-creation"))?.threadId ===
            "00000000-0000-4000-a000-000000000002",
        );
        assert.deepEqual(
          await page.evaluate(() => window.opened),
          [],
          "observing a receipt does not navigate before explicit confirmation",
        );
        await page.getByRole("button", { name: "检查操作状态", exact: true }).first().click();
      } else {
        await page.getByRole("button", { name: "检查操作状态", exact: true }).first().click();
        await page.waitForFunction(() => window.calls.some((call) => call.name === "reconcile"));
      }
      if (mode === "unresolved") {
        await page.getByRole("button", { name: "检查操作状态", exact: true }).first().waitFor();
        await page.getByRole("button", { name: "新建定时任务", exact: true }).click();
        await page.waitForFunction(
          () => window.calls.filter((call) => call.name === "reconcile").length === 2,
        );
        assert.deepEqual(await page.evaluate(() => window.opened), []);
        assert.deepEqual(
          await page.evaluate(() =>
            JSON.parse(localStorage.getItem("areal-gui:ordinary-schedule-creation")),
          ),
          original,
        );
      } else {
        await page.waitForFunction(() => window.opened.length > 0, null, { timeout: 3000 });
        assert.deepEqual(await page.evaluate(() => window.opened), [
          { projectId: original.projectId, threadId: "00000000-0000-4000-a000-000000000002" },
        ]);
        assert.equal(
          await page.evaluate(() => localStorage.getItem("areal-gui:ordinary-schedule-creation")),
          null,
        );
        assert.equal(
          await page.evaluate(
            (projectId) =>
              localStorage.getItem(
                "areal-gui:draft:" + projectId + ":00000000-0000-4000-a000-000000000002",
              ),
            original.projectId,
          ),
          original.text,
        );
        assert.equal(
          await page.getByRole("button", { name: "检查操作状态", exact: true }).count(),
          0,
        );
      }
      const calls = await page.evaluate(() => window.calls);
      assert.equal(calls.filter((call) => call.name === "create").length, 1);
      assert.deepEqual(
        calls.filter((call) => call.name === "projectless").map((call) => call.params),
        [{ operation: "prepare", requestId: original.prepareId }],
      );
      assert.equal(
        calls.find((call) => call.name === "create").params.requestId,
        original.requestId,
      );
      const reads = calls.filter(
        (call) => call.name === "workspace" && call.params.operation === "worktreeRead",
      );
      assert.equal(reads.length, mode === "unresolved" ? 2 : mode === "completed" ? 1 : 0);
      assert.ok(
        reads.every(
          (call) =>
            call.params.requestId === original.requestId &&
            call.params.projectId === original.projectId,
        ),
      );
      result.passed = true;
    } catch (error) {
      result.error = error.stack ?? String(error);
    }
    result.calls = await page.evaluate(() => window.calls);
    result.opened = await page.evaluate(() => window.opened);
    result.storage = await page.evaluate(() => ({ ...localStorage }));
    result.body = await page.locator("body").innerText();
    await page.screenshot({ path: join(evidence, "recovery-" + mode + ".png") });
    recoveryResults.push(result);
  }
  assert.equal(errors.length, 0);
  assert.ok(
    recoveryResults.every((result) => result.passed),
    JSON.stringify(
      recoveryResults.map(({ mode, passed, error }) => ({ mode, passed, error })),
      null,
      2,
    ),
  );
  passed = true;
} finally {
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        passed,
        errors,
        recoveryResults,
        body: await page
          ?.locator("body")
          .innerText()
          .catch(() => ""),
        calls: await page?.evaluate(() => window.calls).catch(() => []),
      },
      null,
      2,
    ),
  );
  await browser?.close();
  await vite.close();
  console.log(JSON.stringify({ passed, evidence }));
}
