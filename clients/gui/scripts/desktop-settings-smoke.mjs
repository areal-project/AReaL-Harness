import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalTlsFixture } from "./desktop-network-smoke.mjs";
import { readFixtureHost } from "./application-cleanup.mjs";
import { readCoreThread } from "./support/core-observation.mjs";
import { installHostTransportBarrier } from "./support/host-transport-barrier.mjs";

const require = createRequire(import.meta.url);
const { executeCore } = require("./support/core-process-fixture.cjs");

export function desktopSettingsSmoke(scratch, workspace) {
  const frames = [],
    events = [];
  return {
    model: () => false,
    frames: () => frames,
    async run({
      app,
      page: getPage,
      call,
      until,
      button,
      quit,
      launch,
      received,
      checks,
      binary,
      env,
      gui,
      sendReady,
    }) {
      let page = getPage();
      let tlsFixture;
      const submissions = [];
      const terminalIds = new Set();
      // Shell 的共享读模型屏蔽代理与 CA 路径；夹具只核对隔离资料库的保存值。
      const persisted = async () =>
        JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "library.json"), "utf8")).settings;
      const capture = async (id) => {
        await page.screenshot({ path: join(scratch, `${id}.png`), animations: "disabled" });
        await writeFile(join(scratch, `${id}.aria.txt`), await page.locator("body").ariaSnapshot());
        frames.push(`${id}.png`);
        events.push({ id, at: new Date().toISOString(), settings: await persisted() });
      };
      const doctor = async (label) => {
        await until(
          (snapshot) => snapshot.connection?.state === "ready",
          `${label} doctor desktop ready`,
        );
        const identity = await app().evaluate(({ app, BrowserWindow }) => {
          const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
          return {
            pid: process.pid,
            electron: process.versions.electron,
            userData: app.getPath("userData"),
            preferences: {
              sandbox: prefs.sandbox,
              contextIsolation: prefs.contextIsolation,
              nodeIntegration: prefs.nodeIntegration,
            },
          };
        });
        assert.equal(identity.pid, app().process().pid);
        assert.equal(await realpath(identity.userData), await realpath(join(scratch, "electron")));
        assert.deepEqual(identity.preferences, {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        });
        const host = await readFixtureHost(env);
        assert.ok(host?.pid > 1, "fixture Host discovery is available");
        process.kill(host.pid, 0);
        const native = await getPage().evaluate(() => window.arealDesktop.nativeState());
        assert.equal(native.connection.state, "ready");
        assert.deepEqual(native.projects, [], "Main does not own the project projection");
        const instances = JSON.parse(
          (await executeCore(binary, ["service", "list", "--json"], { env, timeout: 20000 }))
            .stdout,
        );
        for (const record of instances) {
          assert.ok(record.workspace.startsWith(`${scratch}/`), "doctor rejects foreign workspace");
          assert.ok(
            record.dataDir.startsWith(`${env.AREAL_CORE_HOME}/`),
            "doctor rejects foreign Core data",
          );
          if (record.state !== "stopped") {
            process.kill(record.hostPid, 0);
            process.kill(record.corePid, 0);
          }
        }
        const report = {
          label,
          passed: true,
          pid: identity.pid,
          electron: identity.electron,
          userData: identity.userData,
          preferences: identity.preferences,
          host: { pid: host.pid, id: host.hostId, generation: host.generation },
          instances: instances.map(({ serviceId, generation, state, hostPid, corePid }) => ({
            serviceId,
            generation,
            state,
            hostPid,
            corePid,
          })),
          coreSHA256: createHash("sha256")
            .update(await readFile(binary))
            .digest("hex"),
        };
        await writeFile(
          join(scratch, `settings-doctor-${label}.json`),
          JSON.stringify(report, null, 2),
        );
        return report;
      };
      const textbox = (label) => page.getByRole("textbox", { name: label, exact: true });
      const row = (label) => page.locator(".settings-field-row").filter({ has: textbox(label) });
      const save = async (label, key, value, expected = value.trim()) => {
        await textbox(label).fill(value);
        await row(label).getByRole("button", { name: "保存", exact: true }).click();
        await until(async () => (await persisted())[key] === expected, `Core saves ${key}`);
      };
      const toggle = async (label, key, value) => {
        const control = page.getByRole("switch", { name: label, exact: true });
        if (((await control.getAttribute("aria-checked")) === "true") !== value)
          await control.click();
        await until(
          async () => ((await persisted())[key] !== false) === value,
          `Host saves ${key}`,
        );
        await page.waitForFunction(
          ({ label, value }) =>
            [...document.querySelectorAll('[role="switch"]')].some(
              (element) =>
                element.getAttribute("aria-label") === label &&
                element.getAttribute("aria-checked") === String(value),
            ),
          { label, value },
        );
        assert.equal(await control.getAttribute("aria-checked"), String(value));
      };
      const general = async () => {
        await page.locator('[data-testid="areal-workbench"][data-startup-ready="true"]').waitFor();
        await button("设置").click();
        await button("常规").click();
      };
      const newTerminal = async () => {
        const previous = await page
          .locator(".terminal-pane")
          .evaluate(
            (element) =>
              element.querySelector("[data-terminal-id]")?.getAttribute("data-terminal-id") ?? null,
          );
        await button("新建终端").click();
        await page.waitForFunction((previous) => {
          const current = document
            .querySelector(".terminal-pane [data-terminal-id]")
            ?.getAttribute("data-terminal-id");
          return current && current !== previous;
        }, previous);
        terminalIds.add(
          await page.locator(".terminal-pane [data-terminal-id]").getAttribute("data-terminal-id"),
        );
      };
      const selectedThread = async () => {
        const threadId = await page.getByTestId("areal-workbench").getAttribute("data-thread-id");
        assert.ok(threadId, "selected Thread identity is available");
        return threadId;
      };
      const readThread = (threadId) => readCoreThread({ binary, env, gui, workspace, threadId });
      const nativeNotices = () => app().evaluate(() => globalThis.__settingsNativeNotices);
      const closeTerminals = async (label) => {
        if (!(await page.locator(".terminal-pane").isVisible()))
          await page.keyboard.press("Control+Backquote");
        await page.locator(".terminal-pane").waitFor();
        const tabs = page.getByRole("tablist", { name: "终端实例", exact: true }).getByRole("tab");
        while (await tabs.count()) {
          const count = await tabs.count();
          await button("关闭当前终端").click();
          await page.waitForFunction(
            (count) =>
              [...document.querySelectorAll('[role="tablist"]')]
                .find((element) => element.getAttribute("aria-label") === "终端实例")
                ?.querySelectorAll('[role="tab"]').length < count,
            count,
          );
        }
        let records;
        await until(async (snapshot) => {
          const project = snapshot.projects.find((project) => project.root === workspace);
          records = await call("manage", {
            projectId: project.id,
            threadId: await selectedThread(),
            operation: "processes",
          });
          return [...terminalIds].every(
            (id) => records.data.find((process) => process.id === id)?.cleanupConfirmed === true,
          );
        }, "explicit terminal closes confirm Core process cleanup");
        await writeFile(
          join(scratch, `desktop-settings-terminal-cleanup-${label}.json`),
          JSON.stringify(records, null, 2),
        );
        terminalIds.clear();
        await button("关闭面板").click();
      };
      const sendCompleted = async (text) => {
        const workbench = page.getByTestId("areal-workbench");
        const originalId = await workbench.getAttribute("data-thread-id");
        const before = originalId ? (await readThread(originalId)).turns.length : 0;
        await page.evaluate(installHostTransportBarrier);
        await page.evaluate(() => {
          globalThis.__settingsWrites = [];
          globalThis.__settingsWriteMonitor = globalThis.createHostTransportBarrier((frame) => {
            if (!["session.create", "session.send"].includes(frame.method)) return;
            const entry = { method: frame.method, commandId: frame.commandId };
            globalThis.__settingsWrites.push(entry);
            return {
              onResponse: ({ error, result }) =>
                Object.assign(entry, {
                  errorCode: error?.code,
                  admissionState: result?.admissionState,
                  resultErrorCode: result?.error?.code,
                }),
            };
          });
        });
        try {
          await page.getByTestId("chat-input").fill(text);
          await sendReady(page);
          await button("发送").click();
          await page.waitForFunction(
            () => document.querySelector('[data-testid="areal-workbench"]')?.dataset.threadId,
          );
          const threadId = await selectedThread();
          let completed;
          await until(async () => {
            const thread = await readThread(threadId);
            const turn = thread.turns.at(-1);
            if (thread.turns.length === before + 1 && turn?.status === "completed")
              completed = turn;
            return completed;
          }, "local fixture Turn completes");
          await page
            .locator(`[data-turn-id="${completed.id}"][data-turn-status="completed"]`)
            .waitFor();
          return completed;
        } finally {
          submissions.push(
            ...(await page.evaluate(() => {
              globalThis.__settingsWriteMonitor.restore();
              return globalThis.__settingsWrites;
            })),
          );
        }
      };
      try {
        const kitty = join(scratch, "user-home/.config/kitty");
        await mkdir(kitty, { recursive: true });
        await writeFile(join(kitty, "kitty.conf"), "font_family Georgia\n");
        tlsFixture = await createLocalTlsFixture(join(scratch, "synthetic-tls"));
        const caPath = tlsFixture.caPath;
        await until((snapshot) => snapshot.connection?.state === "ready", "settings desktop ready");
        const initialDoctor = await doctor("initial");
        await app().evaluate(({ Notification }) => {
          globalThis.__settingsNativeNotices = [];
          Notification.isSupported = () => true;
          Notification.prototype.show = function () {
            globalThis.__settingsNativeNotices.push({ title: this.title, body: this.body });
          };
        });
        await general();
        const permissionBefore = (await persisted()).permissionNotifications;
        await page.getByRole("switch", { name: "继承系统终端 Profile", exact: true }).waitFor();
        assert.equal(
          await page
            .getByRole("switch", { name: "继承系统终端 Profile", exact: true })
            .getAttribute("aria-checked"),
          "true",
        );
        assert.equal(
          await page
            .getByRole("switch", { name: "任务通知", exact: true })
            .getAttribute("aria-checked"),
          "true",
        );
        const accelerationBefore = await app().evaluate(({ app }) =>
          app.isHardwareAccelerationEnabled(),
        );
        await toggle("继承系统终端 Profile", "terminalInheritSystemProfile", false);
        await save("终端字体", "terminalFontFamily", "  Courier New  ");
        await save("终端字体", "terminalFontFamily", "");
        await save("终端字体", "terminalFontFamily", "Courier New");
        await toggle("Chromium 硬件加速", "hardwareAcceleration", false);
        assert.equal(
          await app().evaluate(({ app }) => app.isHardwareAccelerationEnabled()),
          accelerationBefore,
          "GPU setting takes effect on next application launch",
        );
        await toggle("任务通知", "taskNotifications", false);
        assert.equal(
          (await persisted()).permissionNotifications,
          permissionBefore,
          "task notification choice does not change permission notifications",
        );
        await page.getByRole("combobox", { name: "轮次完成通知", exact: true }).click();
        await page.getByRole("option", { name: "始终", exact: true }).click();
        await until(
          (snapshot) => snapshot.library.settings.turnNotifications === "always",
          "Core saves always completion policy",
        );
        await page
          .getByRole("tablist", { name: "默认终端位置", exact: true })
          .getByRole("tab", { name: "底部", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            JSON.parse(localStorage.getItem("areal-gui:application-preferences") ?? "{}")
              .terminalLocation === "bottom",
        );
        await page
          .getByRole("tablist", { name: "交互行为", exact: true })
          .getByRole("tab", { name: "调整方向", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            JSON.parse(localStorage.getItem("areal-gui:application-preferences") ?? "{}")
              .followUp === "steer",
        );
        await capture("desktop-settings-saved");
        await button("返回应用").click();
        const muted = await sendCompleted("验证终端设置");
        assert.deepEqual(
          await nativeNotices(),
          [],
          "disabled master suppresses completion delivery",
        );
        await general();
        await toggle("任务通知", "taskNotifications", true);
        await button("返回应用").click();
        const enabled = await sendCompleted("验证任务通知");
        await until(
          async () => (await nativeNotices()).length > 0,
          "native completion notification",
        );
        const notices = await nativeNotices();
        assert.equal(notices.length, 1);
        assert.equal(notices[0].title, "任务已完成");
        await writeFile(
          join(scratch, "desktop-settings-notifications.json"),
          JSON.stringify(
            {
              notices,
              mutedTurnId: muted.id,
              enabledTurnId: enabled.id,
              fixture:
                "Electron Notification.show sink; operating-system delivery is outside this source fixture",
            },
            null,
            2,
          ),
        );
        await general();
        await toggle("任务通知", "taskNotifications", false);
        assert.equal(
          (await persisted()).turnNotifications,
          "always",
          "master toggle preserves the completion suboption",
        );
        await button("返回应用").click();
        await page.keyboard.press("Control+Backquote");
        await page.locator(".terminal-pane .xterm-screen").waitFor();
        await page.waitForFunction(() => {
          const rows = document.querySelector(".terminal-pane .xterm-rows");
          return rows && /Courier New/i.test(getComputedStyle(rows).fontFamily);
        });
        terminalIds.add(
          await page.locator(".terminal-pane [data-terminal-id]").getAttribute("data-terminal-id"),
        );
        await capture("desktop-settings-terminal");
        await button("关闭面板").click();
        await general();
        await save("终端字体", "terminalFontFamily", "");
        await button("返回应用").click();
        await page.keyboard.press("Control+Backquote");
        await newTerminal();
        const fallback = await page
          .locator(".terminal-pane .xterm-rows")
          .evaluate((element) => getComputedStyle(element).fontFamily);
        assert.doesNotMatch(
          fallback,
          /Georgia/i,
          "disabled inheritance ignores isolated system terminal profile",
        );
        await button("关闭面板").click();
        await general();
        await toggle("继承系统终端 Profile", "terminalInheritSystemProfile", true);
        await button("返回应用").click();
        await page.keyboard.press("Control+Backquote");
        await newTerminal();
        await page.waitForFunction(() => {
          const rows = document.querySelector(".terminal-pane .xterm-rows");
          return rows && /Georgia/i.test(getComputedStyle(rows).fontFamily);
        });
        await capture("desktop-settings-inherited-profile");
        await button("关闭面板").click();
        await general();
        await toggle("继承系统终端 Profile", "terminalInheritSystemProfile", false);
        await save("终端字体", "terminalFontFamily", "Courier New");
        await button("返回应用").click();
        const requestsBefore = received.length;
        await closeTerminals("before-restart");
        await general();
        await save("HTTP 代理", "httpProxy", "  http://127.0.0.1:9  ");
        await save(
          "不使用代理的地址",
          "httpProxyNoProxy",
          "  localhost,127.0.0.1  ",
          "127.0.0.1,localhost",
        );
        await save("自定义证书", "httpProxyCaCertPath", `  ${caPath}  `);
        await textbox("HTTP 代理").fill("file:///invalid-proxy");
        await row("HTTP 代理").getByRole("button", { name: "保存", exact: true }).click();
        await row("HTTP 代理").getByRole("alert").waitFor();
        assert.equal(
          (await persisted()).httpProxy,
          "http://127.0.0.1:9",
          "invalid proxy preserves saved value",
        );
        await textbox("HTTP 代理").fill("http://127.0.0.1:9");
        await textbox("自定义证书").fill(join(scratch, "missing-ca.pem"));
        await row("自定义证书").getByRole("button", { name: "保存", exact: true }).click();
        await row("自定义证书").getByRole("alert").waitFor();
        assert.equal(
          (await persisted()).httpProxyCaCertPath,
          caPath,
          "unreadable CA preserves saved trust setting",
        );
        await save("自定义证书", "httpProxyCaCertPath", "");
        await save("自定义证书", "httpProxyCaCertPath", caPath);
        await save("HTTP 代理", "httpProxy", "");
        await save("不使用代理的地址", "httpProxyNoProxy", "");
        await button("返回应用").click();
        await doctor("before-close");
        await quit();
        await launch();
        page = getPage();
        const reopenedDoctor = await doctor("reopened");
        assert.equal(
          reopenedDoctor.coreSHA256,
          initialDoctor.coreSHA256,
          "Core binary unchanged during acceptance",
        );
        assert.equal(
          await app().evaluate(({ app }) => app.isHardwareAccelerationEnabled()),
          false,
          "cold launch disables Chromium hardware acceleration",
        );
        const chromium = [];
        for (const partition of ["default", "persist:areal-embedded-browser"]) {
          for (const test of tlsFixture.cases) {
            const result = await app().evaluate(
              async ({ session }, { partition, url }) => {
                const target =
                  partition === "default"
                    ? session.defaultSession
                    : session.fromPartition(partition);
                try {
                  const response = await target.fetch(url, { signal: AbortSignal.timeout(5000) });
                  return { accepted: true, status: response.status, text: await response.text() };
                } catch (error) {
                  return { accepted: false, error: error.message };
                }
              },
              { partition, url: test.url },
            );
            chromium.push({ partition, name: test.name, ...result });
            await writeFile(
              join(scratch, "desktop-settings-chromium-tls.json"),
              JSON.stringify(chromium, null, 2),
            );
            assert.equal(
              result.accepted,
              test.accepted,
              `${partition} Chromium verifies ${test.name} certificate`,
            );
            if (test.accepted) assert.equal(result.text, `tls-${test.name}`);
            else
              assert.match(
                result.error,
                /CERT|certificate|cert|SSL|ssl/i,
                "TLS rejection is certificate validation, not missing network",
              );
          }
        }
        await writeFile(
          join(scratch, "desktop-settings-chromium-tls.json"),
          JSON.stringify(chromium, null, 2),
        );
        await general();
        for (const [label, key] of [
          ["继承系统终端 Profile", "terminalInheritSystemProfile"],
          ["任务通知", "taskNotifications"],
          ["Chromium 硬件加速", "hardwareAcceleration"],
        ]) {
          assert.equal(
            await page
              .getByRole("switch", { name: label, exact: true })
              .getAttribute("aria-checked"),
            "false",
            `${key} survives cold restart`,
          );
        }
        assert.equal(await textbox("终端字体").inputValue(), "Courier New");
        for (const label of ["HTTP 代理", "不使用代理的地址"])
          assert.equal(
            await textbox(label).inputValue(),
            "",
            `${label} stays cleared after restart`,
          );
        assert.equal(
          await textbox("自定义证书").inputValue(),
          caPath,
          "custom CA path survives cold restart",
        );
        assert.equal(
          await page
            .getByRole("tablist", { name: "交互行为", exact: true })
            .getByRole("tab", { name: "调整方向", exact: true })
            .getAttribute("aria-selected"),
          "true",
        );
        assert.equal(
          received.length,
          requestsBefore,
          "restart does not submit another model request",
        );
        await capture("desktop-settings-reopened");
        await button("返回应用").click();
        const terminalThread = await selectedThread();
        const projectId = await page.getByTestId("areal-workbench").getAttribute("data-project-id");
        const activation = await call("connect", { projectId, threadId: terminalThread });
        assert.equal(activation.state, "ready", "explicitly activate the persisted Thread's Core");
        assert.ok(activation.serviceGeneration);
        assert.equal(received.length, requestsBefore, "Core activation does not submit a Turn");
        await button("更改权限").click();
        await page.getByRole("menuitemradio", { name: /^完全访问/ }).click();
        await until(async () => {
          const thread = await readThread(terminalThread);
          return thread.desktop?.configuration?.permissions?.resources === "deployment";
        }, "isolated Runtime curl fixture receives supported network permission");
        await page.keyboard.press("Control+Backquote");
        await newTerminal();
        const terminalInput = page.locator(".terminal-pane .xterm-helper-textarea");
        await terminalInput.focus();
        const runtimeUrl = new URL(
          "/runtime-curl",
          tlsFixture.cases.find((test) => test.name === "valid").url,
        ).href;
        await terminalInput.pressSequentially(
          `/usr/bin/curl --silent --show-error --fail --noproxy '*' '${runtimeUrl}'`,
        );
        await terminalInput.press("Enter");
        await until(
          () =>
            tlsFixture.requests.some(
              (request) => request.name === "valid" && request.url === "/runtime-curl",
            ),
          "Runtime curl trusts configured custom CA",
        );
        await page.waitForFunction(() =>
          document.querySelector(".terminal-pane .xterm-rows")?.textContent?.includes("tls-valid"),
        );
        await capture("desktop-settings-runtime-ca");
        await writeFile(
          join(scratch, "desktop-settings-local-tls-requests.json"),
          JSON.stringify(tlsFixture.requests, null, 2),
        );
        await closeTerminals("after-restart");
        checks.push(
          "desktop settings: UI/Core save, trim/clear, invalid proxy/CA preserve saved state, actual completion notification routing enabled/disabled, preserved suboptions, rendered terminal custom/inherited/fallback font, GPU next-launch effect, cold persistence, Chromium TLS policy, Runtime curl custom CA, no replay",
        );
      } finally {
        await tlsFixture?.close();
        await writeFile(
          join(scratch, "desktop-settings-events.json"),
          JSON.stringify(
            {
              events,
              submissions,
              limits: [
                "isolated source macOS Electron/Core",
                "synthetic local model only",
                "native picker injected",
                "isolated kitty system profile fixture; no user shell startup changes",
                "OS notification delivery not covered",
                "outbound proxy/TLS behavior requires desktop-network-smoke",
              ],
            },
            null,
            2,
          ),
        );
      }
    },
  };
}
