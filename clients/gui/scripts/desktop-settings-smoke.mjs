import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createLocalTlsFixture } from "./desktop-network-smoke.mjs";

const require = createRequire(import.meta.url);
const { ServiceConnection } = require("../app/src/core/service-client.cjs");
const { executeCore } = require("../app/src/core/core-process.cjs");

export function desktopSettingsSmoke(scratch, workspace) {
  const frames = [], events = [];
  return {
    model: () => false,
    frames: () => frames,
    async run({ app, page: getPage, state, call, until, button, quit, launch, received, checks }) {
      let page = getPage();
      let tlsFixture, notificationConnection;
      const notices = [];
      const terminalIds = new Set();
      const persisted = () => state().then(snapshot => snapshot.library.settings);
      const capture = async id => {
        await page.screenshot({ path: join(scratch, `${id}.png`), animations: "disabled" });
        await writeFile(join(scratch, `${id}.aria.txt`), await page.locator("body").ariaSnapshot());
        frames.push(`${id}.png`);
        events.push({ id, at: new Date().toISOString(), settings: await persisted() });
      };
      const doctor = async label => {
        await until(snapshot => snapshot.connection?.state === "ready", `${label} doctor desktop ready`);
        const identity = await app().evaluate(({ app, BrowserWindow }) => {
          const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
          return {
            pid: process.pid, electron: process.versions.electron, userData: app.getPath("userData"),
            preferences: { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration },
            env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("AREAL_") || key === "PATH")),
          };
        });
        assert.equal(identity.pid, app().process().pid);
        assert.equal(await realpath(identity.userData), await realpath(join(scratch, "electron")));
        assert.deepEqual(identity.preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false });
        const env = identity.env;
        const metadata = JSON.parse(await readFile(join(env.AREAL_CORE_HOME, "service.json"), "utf8"));
        process.kill(metadata.pid, 0);
        const connection = new ServiceConnection();
        let hello;
        try {
          await connection.connect(metadata);
          hello = await connection.request("hello", { protocol: metadata.protocol, identity: metadata.identity });
          assert.equal(hello.service.pid, metadata.pid);
          assert.equal(await realpath(hello.service.applicationOwner.profile), await realpath(identity.userData));
        } finally { connection.close(); }
        const binary = env.AREAL_CORE_BIN;
        assert.ok(binary, "source settings acceptance requires AREAL_CORE_BIN");
        const instances = JSON.parse((await executeCore(binary, ["service", "list", "--json"], { env, timeout: 20000 })).stdout);
        for (const record of instances) {
          assert.ok(record.workspace.startsWith(`${scratch}/`), "doctor rejects foreign workspace");
          assert.ok(record.dataDir.startsWith(`${env.AREAL_CORE_HOME}/`), "doctor rejects foreign Core data");
          if (record.state !== "stopped") { process.kill(record.hostPid, 0); process.kill(record.corePid, 0); }
        }
        const report = { label, passed: true, pid: identity.pid, electron: identity.electron, userData: identity.userData,
          preferences: identity.preferences, desktop: { pid: metadata.pid, identity: metadata.identity },
          instances: instances.map(({ serviceId, generation, state, hostPid, corePid }) => ({ serviceId, generation, state, hostPid, corePid })),
          coreSHA256: createHash("sha256").update(await readFile(binary)).digest("hex") };
        await writeFile(join(scratch, `settings-doctor-${label}.json`), JSON.stringify(report, null, 2));
        return report;
      };
      const textbox = label => page.getByRole("textbox", { name: label, exact: true });
      const row = label => page.locator(".settings-field-row").filter({ has: textbox(label) });
      const save = async (label, key, value) => {
        await textbox(label).fill(value);
        await row(label).getByRole("button", { name: "保存", exact: true }).click();
        await until(snapshot => snapshot.library.settings[key] === value.trim(), `Core saves ${key}`);
      };
      const toggle = async (label, key, value) => {
        const control = page.getByRole("switch", { name: label, exact: true });
        if ((await control.getAttribute("aria-checked") === "true") !== value) await control.click();
        await until(snapshot => (snapshot.library.settings[key] !== false) === value, `Core saves ${key}`);
        await page.waitForFunction(({ label, value }) => [...document.querySelectorAll('[role="switch"]')].some(element => element.getAttribute("aria-label") === label && element.getAttribute("aria-checked") === String(value)), { label, value });
        assert.equal(await control.getAttribute("aria-checked"), String(value));
      };
      const general = async () => { await button("设置").click(); await button("常规").click(); };
      const newTerminal = async () => {
        const previous = await page.locator(".terminal-pane").evaluate(element => element.querySelector("[data-terminal-id]")?.getAttribute("data-terminal-id") ?? null);
        await button("新建终端").click();
        await page.waitForFunction(previous => {
          const current = document.querySelector(".terminal-pane [data-terminal-id]")?.getAttribute("data-terminal-id");
          return current && current !== previous;
        }, previous);
        terminalIds.add(await page.locator(".terminal-pane [data-terminal-id]").getAttribute("data-terminal-id"));
      };
      const closeTerminals = async () => {
        if (!await page.locator(".terminal-pane").isVisible()) await page.keyboard.press("Control+Backquote");
        await page.locator(".terminal-pane").waitFor();
        const tabs = page.getByRole("tablist", { name: "终端实例", exact: true }).getByRole("tab");
        while (await tabs.count()) {
          const count = await tabs.count();
          await button("关闭当前终端").click();
          await page.waitForFunction(count => [...document.querySelectorAll('[role="tablist"]')].find(element => element.getAttribute("aria-label") === "终端实例")?.querySelectorAll('[role="tab"]').length < count, count);
        }
        let records;
        await until(async snapshot => {
          const project = snapshot.projects.find(project => project.root === workspace);
          records = await call("manage", { projectId: project.id, threadId: Object.keys(project.state.threads)[0], operation: "processes" });
          return [...terminalIds].every(id => records.data.find(process => process.id === id)?.cleanupConfirmed === true);
        }, "explicit terminal closes confirm Core process cleanup");
        await writeFile(join(scratch, "desktop-settings-terminal-cleanup.json"), JSON.stringify(records, null, 2));
        await button("关闭面板").click();
      };
      const sendCompleted = async text => {
        const turns = snapshot => Object.values(snapshot.projects.find(project => project.root === workspace)?.state?.threads ?? {}).flatMap(thread => thread.turns ?? []);
        const before = turns(await state()).length;
        await page.getByTestId("chat-input").fill(text);
        await button("发送").click();
        await until(snapshot => turns(snapshot).length > before && turns(snapshot).at(-1)?.status === "completed", "local fixture turn completes");
        await notificationConnection.request("snapshot");
      };
      try {
        const kitty = join(scratch, "user-home/.config/kitty");
        await mkdir(kitty, { recursive: true });
        await writeFile(join(kitty, "kitty.conf"), "font_family Georgia\n");
        tlsFixture = await createLocalTlsFixture(join(scratch, "synthetic-tls"));
        const caPath = tlsFixture.caPath;
        await until(snapshot => snapshot.connection?.state === "ready", "settings desktop ready");
        const initialDoctor = await doctor("initial");
        const metadata = JSON.parse(await readFile(join(scratch, "core/service.json"), "utf8"));
        notificationConnection = new ServiceConnection(undefined, undefined, notice => notices.push(notice));
        await notificationConnection.connect(metadata);
        await notificationConnection.request("hello", { protocol: metadata.protocol, identity: metadata.identity, notifications: true });
        await notificationConnection.request("activity", { focused: true, suspended: false, idleSeconds: 0 });
        await general();
        const permissionBefore = (await persisted()).permissionNotifications;
        await page.getByRole("switch", { name: "继承系统终端 Profile", exact: true }).waitFor();
        assert.equal(await page.getByRole("switch", { name: "继承系统终端 Profile", exact: true }).getAttribute("aria-checked"), "true");
        assert.equal(await page.getByRole("switch", { name: "任务通知", exact: true }).getAttribute("aria-checked"), "true");
        const accelerationBefore = await app().evaluate(({ app }) => app.isHardwareAccelerationEnabled());
        await toggle("继承系统终端 Profile", "terminalInheritSystemProfile", false);
        await save("终端字体", "terminalFontFamily", "  Courier New  ");
        await save("HTTP 代理", "httpProxy", "  http://127.0.0.1:9  ");
        await save("不使用代理的地址", "httpProxyNoProxy", "  localhost,127.0.0.1  ");
        await save("自定义证书", "httpProxyCaCertPath", `  ${caPath}  `);
        await textbox("HTTP 代理").fill("file:///invalid-proxy");
        await row("HTTP 代理").getByRole("button", { name: "保存", exact: true }).click();
        await row("HTTP 代理").getByRole("alert").filter({ hasText: /proxy|代理/i }).waitFor();
        assert.equal((await persisted()).httpProxy, "http://127.0.0.1:9", "invalid proxy preserves saved value");
        await textbox("HTTP 代理").fill("http://127.0.0.1:9");
        await textbox("自定义证书").fill(join(scratch, "missing-ca.pem"));
        await row("自定义证书").getByRole("button", { name: "保存", exact: true }).click();
        await row("自定义证书").getByRole("alert").filter({ hasText: /CA|certificate|证书|ENOENT/i }).waitFor();
        assert.equal((await persisted()).httpProxyCaCertPath, caPath, "unreadable CA preserves saved trust setting");
        await save("自定义证书", "httpProxyCaCertPath", "");
        await save("自定义证书", "httpProxyCaCertPath", caPath);
        await save("HTTP 代理", "httpProxy", "");
        await save("不使用代理的地址", "httpProxyNoProxy", "");
        await save("终端字体", "terminalFontFamily", "");
        await save("终端字体", "terminalFontFamily", "Courier New");
        await toggle("Chromium 硬件加速", "hardwareAcceleration", false);
        assert.equal(await app().evaluate(({ app }) => app.isHardwareAccelerationEnabled()), accelerationBefore, "GPU setting takes effect on next application launch");
        await toggle("任务通知", "taskNotifications", false);
        assert.equal((await persisted()).permissionNotifications, permissionBefore, "task notification choice does not change permission notifications");
        await page.getByRole("combobox", { name: "轮次完成通知", exact: true }).click();
        await page.getByRole("option", { name: "始终", exact: true }).click();
        await until(snapshot => snapshot.library.settings.turnNotifications === "always", "Core saves always completion policy");
        await page.getByRole("tablist", { name: "默认终端位置", exact: true }).getByRole("tab", { name: "底部", exact: true }).click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("areal-gui:application-preferences") ?? "{}").terminalLocation === "bottom");
        await page.getByRole("tablist", { name: "交互行为", exact: true }).getByRole("tab", { name: "调整方向", exact: true }).click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("areal-gui:application-preferences") ?? "{}").followUp === "steer");
        await capture("desktop-settings-saved");
        await button("返回应用").click();
        await sendCompleted("验证终端设置");
        assert.equal(notices.length, 0, "disabled master suppresses actual completed-turn notification");
        await general();
        await toggle("任务通知", "taskNotifications", true);
        await button("返回应用").click();
        await sendCompleted("验证任务通知");
        assert.equal(notices.length, 1, "enabled master routes one actual completed-turn notification");
        assert.equal(notices[0].kind, "completion");
        assert.equal(notices[0].projectId, (await state()).projects.find(project => project.root === workspace).id);
        await writeFile(join(scratch, "desktop-settings-notifications.json"), JSON.stringify({ notices, fixture: "authenticated notification observer with synthetic most-recent-focused activity; OS delivery not exercised" }, null, 2));
        await general();
        await toggle("任务通知", "taskNotifications", false);
        assert.equal((await persisted()).turnNotifications, "always", "master toggle preserves the completion suboption");
        await button("返回应用").click();
        await page.keyboard.press("Control+Backquote");
        await page.locator(".terminal-pane .xterm-screen").waitFor();
        await page.waitForFunction(() => {
          const rows = document.querySelector(".terminal-pane .xterm-rows");
          return rows && /Courier New/i.test(getComputedStyle(rows).fontFamily);
        });
        terminalIds.add(await page.locator(".terminal-pane [data-terminal-id]").getAttribute("data-terminal-id"));
        await capture("desktop-settings-terminal");
        await button("关闭面板").click();
        await general();
        await save("终端字体", "terminalFontFamily", "");
        await button("返回应用").click();
        await page.keyboard.press("Control+Backquote");
        await newTerminal();
        const fallback = await page.locator(".terminal-pane .xterm-rows").evaluate(element => getComputedStyle(element).fontFamily);
        assert.doesNotMatch(fallback, /Georgia/i, "disabled inheritance ignores isolated system terminal profile");
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
        await closeTerminals();
        await doctor("before-close");
        notificationConnection.close(); notificationConnection = null;
        await quit(); await launch(); page = getPage();
        const reopenedDoctor = await doctor("reopened");
        assert.equal(reopenedDoctor.coreSHA256, initialDoctor.coreSHA256, "Core binary unchanged during acceptance");
        assert.equal(await app().evaluate(({ app }) => app.isHardwareAccelerationEnabled()), false, "cold launch disables Chromium hardware acceleration");
        const chromium = [];
        for (const partition of ["default", "persist:areal-embedded-browser"]) {
          for (const test of tlsFixture.cases) {
            const result = await app().evaluate(async ({ session }, { partition, url }) => {
              const target = partition === "default" ? session.defaultSession : session.fromPartition(partition);
              try {
                const response = await target.fetch(url, { signal: AbortSignal.timeout(5000) });
                return { accepted: true, status: response.status, text: await response.text() };
              } catch (error) { return { accepted: false, error: error.message }; }
            }, { partition, url: test.url });
            chromium.push({ partition, name: test.name, ...result });
            await writeFile(join(scratch, "desktop-settings-chromium-tls.json"), JSON.stringify(chromium, null, 2));
            assert.equal(result.accepted, test.accepted, `${partition} Chromium verifies ${test.name} certificate`);
            if (test.accepted) assert.equal(result.text, `tls-${test.name}`);
            else assert.match(result.error, /CERT|certificate|cert|SSL|ssl/i, "TLS rejection is certificate validation, not missing network");
          }
        }
        await writeFile(join(scratch, "desktop-settings-chromium-tls.json"), JSON.stringify(chromium, null, 2));
        await general();
        for (const [label, key] of [["继承系统终端 Profile", "terminalInheritSystemProfile"], ["任务通知", "taskNotifications"], ["Chromium 硬件加速", "hardwareAcceleration"]]) {
          assert.equal(await page.getByRole("switch", { name: label, exact: true }).getAttribute("aria-checked"), "false", `${key} survives cold restart`);
        }
        assert.equal(await textbox("终端字体").inputValue(), "Courier New");
        for (const label of ["HTTP 代理", "不使用代理的地址"]) assert.equal(await textbox(label).inputValue(), "", `${label} stays cleared after restart`);
        assert.equal(await textbox("自定义证书").inputValue(), caPath, "custom CA path survives cold restart");
        assert.equal(await page.getByRole("tablist", { name: "交互行为", exact: true }).getByRole("tab", { name: "调整方向", exact: true }).getAttribute("aria-selected"), "true");
        assert.equal(received.length, requestsBefore, "restart does not submit another model request");
        await capture("desktop-settings-reopened");
        await button("返回应用").click();
        await button("更改权限").click();
        await page.getByRole("menuitemradio", { name: /^完全访问/ }).click();
        await until(snapshot => {
          const project = snapshot.projects.find(project => project.root === workspace);
          return Object.values(project.configurations ?? {}).some(configuration => configuration.permissions?.resources === "deployment");
        }, "isolated Runtime curl fixture receives supported network permission");
        await page.keyboard.press("Control+Backquote");
        await newTerminal();
        const terminalInput = page.locator(".terminal-pane .xterm-helper-textarea");
        await terminalInput.focus();
        const runtimeUrl = new URL("/runtime-curl", tlsFixture.cases.find(test => test.name === "valid").url).href;
        await terminalInput.pressSequentially(`/usr/bin/curl --silent --show-error --fail --noproxy '*' '${runtimeUrl}'`);
        await terminalInput.press("Enter");
        await until(() => tlsFixture.requests.some(request => request.name === "valid" && request.url === "/runtime-curl"), "Runtime curl trusts configured custom CA");
        await page.waitForFunction(() => document.querySelector(".terminal-pane .xterm-rows")?.textContent?.includes("tls-valid"));
        await capture("desktop-settings-runtime-ca");
        await writeFile(join(scratch, "desktop-settings-local-tls-requests.json"), JSON.stringify(tlsFixture.requests, null, 2));
        await closeTerminals();
        checks.push("desktop settings: UI/Core save, trim/clear, invalid proxy/CA preserve saved state, actual completion notification routing enabled/disabled, preserved suboptions, rendered terminal custom/inherited/fallback font, GPU next-launch effect, cold persistence, Chromium TLS policy, Runtime curl custom CA, no replay");
      } finally {
        notificationConnection?.close();
        await tlsFixture?.close();
        await writeFile(join(scratch, "desktop-settings-events.json"), JSON.stringify({ events, limits: ["isolated source macOS Electron/Core", "synthetic local model only", "native picker injected", "isolated kitty system profile fixture; no user shell startup changes", "OS notification delivery not covered", "outbound proxy/TLS behavior requires desktop-network-smoke"] }, null, 2));
      }
    },
  };
}
