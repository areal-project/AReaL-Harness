import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";
const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { IntlProvider } = require("react-intl");

test("Phone connection settings keep the main path short and the network consent in advanced settings", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../renderer/", import.meta.url)),
    configFile: false,
    plugins: [
      {
        name: "static-locale-preferences",
        enforce: "pre",
        resolveId(id, importer) {
          if (
            id.endsWith("/settings/applicationPreferences.js") &&
            importer?.endsWith("/i18n/IntlProvider.tsx")
          )
            return "\0static-locale-preferences";
        },
        load(id) {
          if (id === "\0static-locale-preferences")
            return 'export function useApplicationPreferences() { return { locale: "zh-CN" }; }';
        },
      },
    ],
    resolve: { alias: { "@": fileURLToPath(new URL("../renderer/src/", import.meta.url)) } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null },
    appType: "custom",
    oxc: { jsx: { runtime: "automatic" } },
  });
  try {
    const { MobileSettings } = await vite.ssrLoadModule("/src/settings/MobileSettings.tsx");
    const { MobileDevices } = await vite.ssrLoadModule("/src/settings/MobileDevices.tsx");
    const { GrantReview, fingerprintGroups } = await vite.ssrLoadModule(
      "/src/settings/RemoteGrantReview.tsx",
    );
    const { catalogs } = await vite.ssrLoadModule("/src/i18n/messages.ts");
    const render = (element) =>
      renderToStaticMarkup(
        React.createElement(
          IntlProvider,
          { locale: "zh-CN", messages: catalogs["zh-CN"] },
          element,
        ),
      );
    const html = render(
      React.createElement(MobileSettings, { action: async () => ({}), projects: [] }),
    );
    // 主路径：未开启时只有状态卡和中继两项输入，没有步骤条和连接方式选择。
    assert.match(html, /还没有开启手机连接/);
    assert.match(html, /aria-label="Relay HTTPS 来源"/);
    assert.match(html, /管理员一次性登记码/);
    assert.match(html, /type="password"/);
    assert.match(html, /我信任此 HTTPS 来源/);
    assert.match(html, /disabled=""[^>]*>开启手机连接/);
    assert.doesNotMatch(html, /aria-label="配对入口"/);
    assert.doesNotMatch(html, /选择连接方式/);
    assert.doesNotMatch(html, />添加设备</, "add device needs a ready entry");
    assert.match(html, /还没有设备/);
    // 高级网络设置仍保留原有确认流程。
    assert.match(html, /高级网络设置/);
    assert.match(html, /Tailscale Serve/);
    assert.match(html, /Tailscale Funnel · 公网/);
    assert.match(html, /aria-label="手机访问方式"/);
    assert.match(html, /连接详情与诊断/);
    assert.match(html, /手机连接待验证/);
    assert.match(html, /会让入口可从互联网访问/);
    assert.match(html, /配对仍需指纹和桌面确认/);
    assert.match(html, /disabled=""[^>]*>生成公网 Funnel 方案/);
    assert.match(html, /disabled=""[^>]*>生成恢复私人入口方案/);
    assert.match(html, /disabled=""[^>]*>保存组织 HTTPS 来源/);
    assert.match(html, /disabled=""[^>]*>生成 Serve 方案/);
    assert.match(html, /组织 HTTPS/);
    assert.match(html, /手机.*tailnet/);
    assert.match(html, /本机检测成功不代表手机能连接/);
    assert.match(html, /生成方案后，确认再应用/);
    assert.match(html, /Host.*离线/);
    assert.match(html, />启用本机入口</);

    const devices = render(
      React.createElement(MobileDevices, {
        devices: [
          {
            devicePeerId: "phone",
            displayName: "我的 iPhone",
            clientKind: "ios",
            projectIds: ["a", "b"],
            capabilities: ["observe", "review", "submit"],
            revision: 1,
            status: "active",
            pushRegistered: true,
            online: true,
          },
          {
            devicePeerId: "laptop",
            displayName: "Chrome · macOS (2)",
            projectIds: ["a"],
            capabilities: ["observe", "review"],
            revision: 1,
            status: "reviewRequired",
            online: false,
            lastSeenAt: null,
          },
          {
            devicePeerId: "old",
            displayName: "Chrome · macOS",
            projectIds: [],
            capabilities: [],
            revision: 2,
            status: "revoked",
            revokedAt: Date.UTC(2026, 9, 20),
          },
        ],
        projects: [],
        busy: false,
        run: async () => ({}),
        reconnectUrl: "",
      }),
    );
    // 设备行四列；已撤销的设备不混在可用列表里。
    assert.equal(devices.match(/class="remote-device-row"/g)?.length, 3);
    assert.match(devices, /2 台可用/);
    assert.match(devices, /我的 iPhone<\/strong><small>iPhone · 2 个项目 · 在线 · 推送已开/);
    assert.match(devices, /Chrome · macOS \(2\)<\/strong><small>浏览器 · 1 个项目<\/small>/);
    assert.match(devices, /需重新确认/);
    assert.match(devices, /aria-label="我的 iPhone 的更多操作"/);
    assert.match(devices, /已撤销的设备（1）/);
    assert.match(devices, /清除记录/);
    assert.doesNotMatch(devices, /Web browser|管理权限/);
    const activeList = devices.slice(0, devices.indexOf("已撤销的设备"));
    assert.doesNotMatch(activeList, /data-status="revoked"/);

    const review = render(
      React.createElement(GrantReview, {
        device: { id: "12D3KooWAbCdEfGh", name: "Safari · iOS" },
        projects: [{ id: "only", name: "workspace" }],
        pending: true,
        busy: false,
        run: async () => ({}),
      }),
    );
    assert.deepEqual(fingerprintGroups("12D3KooWAbCdEfGh"), ["12D3", "KooW", "AbCd", "EfGh"]);
    assert.match(review, /<span>12D3<\/span><span>KooW<\/span>/);
    assert.match(review, /aria-label="确认设备 12D3KooWAbCdEfGh"/);
    assert.match(review, /type="checkbox" checked=""/, "the only project is preselected");
    assert.match(review, />允许连接</);
    assert.match(review, />拒绝</);
  } finally {
    await vite.close();
  }
});

test("relay enrollment retains failed input and invitations render QR images in a browser", async () => {
  const appRequire = createRequire(new URL("../app/package.json", import.meta.url));
  const { chromium } = appRequire("playwright-core");
  const relayQr = await appRequire("qrcode").toDataURL("https://relay.example.org/#invite=test");
  const localQr = await appRequire("qrcode").toDataURL("http://127.0.0.1:43123/#invite=test");
  const vite = await createServer({
    root: fileURLToPath(new URL("../renderer/", import.meta.url)),
    configFile: fileURLToPath(new URL("../renderer/vite.config.ts", import.meta.url)),
    plugins: [
      {
        name: "remote-settings-browser-fixture",
        configureServer(server) {
          server.middlewares.use(async (request, response, next) => {
            if (request.url !== "/remote-settings-test") return next();
            response.setHeader("Content-Type", "text/html");
            response.end(
              await server.transformIndexHtml(
                request.url,
                '<html class="dark"><body><div id="root"></div><script type="module" src="/remote-settings-fixture.jsx"></script></body></html>',
              ),
            );
          });
        },
        resolveId(id) {
          if (id === "/remote-settings-fixture.jsx") return "\0remote-settings-fixture.jsx";
        },
        load(id) {
          if (id !== "\0remote-settings-fixture.jsx") return;
          return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { IntlProvider } from 'react-intl';
          import { catalogs } from '/src/i18n/messages.ts';
          import { MobileSettings } from '/src/settings/MobileSettings.tsx';
          import '/src/styles.css';
          import '/src/workbench.css';
          let state = { deviceGrants: [], pending: [], directEnabled: true,
            directUrl: 'http://127.0.0.1:43123', directHostId: 'test-host' };
          window.requests = [];
          const action = async (_, request) => {
            window.requests.push(request);
            if (request.operation === 'enable') {
              await new Promise(resolve => { window.finishEnrollment = resolve; });
              if (!window.enrollmentSucceeds) throw new Error('Enrollment rejected');
              state = { ...state, enabled: true, connected: true, relay: request.relay };
            }
            if (request.operation === 'pair') return {
              payload: state.enabled ? 'https://relay.example.org/#invite=test' : 'http://127.0.0.1:43123/#invite=test',
              qr: state.enabled ? ${JSON.stringify(relayQr)} : ${JSON.stringify(localQr)}, expiresAt: Date.now() + 120000
            };
            return structuredClone(state);
          };
          createRoot(document.getElementById('root')).render(
            React.createElement(IntlProvider, { locale: 'zh-CN', messages: catalogs['zh-CN'] },
              React.createElement(MobileSettings, { action, projects: [] }))
          );`;
        },
      },
    ],
    resolve: { alias: { "@": fileURLToPath(new URL("../renderer/src/", import.meta.url)) } },
    server: { host: "127.0.0.1", port: 0 },
    oxc: { jsx: { runtime: "automatic" } },
  });
  let browser;
  try {
    await vite.listen();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.AREAL_GUI_TEST_BROWSER
        ? { executablePath: process.env.AREAL_GUI_TEST_BROWSER }
        : { channel: "chrome" }),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${vite.resolvedUrls.local[0]}remote-settings-test`);
    const origin = page.getByRole("textbox", { name: "Relay HTTPS 来源" });
    const code = page.getByLabel("管理员一次性登记码", { exact: true });
    const consent = page.locator(".remote-relay-consent input").first();
    await origin.fill("https://relay.example.org");
    await code.fill("test-enrollment-code");
    await consent.check();
    await page.getByRole("button", { name: "开启手机连接", exact: true }).click();
    await page.getByRole("button", { name: "正在登记中继…" }).waitFor();
    assert.equal(await code.inputValue(), "test-enrollment-code");
    await page.evaluate(() => window.finishEnrollment());
    await page.getByRole("alert").filter({ hasText: "Enrollment rejected" }).waitFor();
    assert.equal(await code.inputValue(), "test-enrollment-code");
    assert.equal(await origin.inputValue(), "https://relay.example.org");
    assert.equal(await consent.isChecked(), true);
    // 轮询后失败输入仍保留，旧本机邀请也有二维码和明确的使用限制。
    await page.waitForFunction(
      () => window.requests.filter((r) => r.operation === "status").length >= 2,
    );
    assert.equal(await code.inputValue(), "test-enrollment-code");
    await page.getByRole("button", { name: "添加设备", exact: true }).click();
    const image = page.getByRole("img", { name: "手机配对二维码" });
    await image.waitFor();
    await page.waitForFunction(
      () => document.querySelector(".remote-invitation img")?.naturalWidth > 0,
    );
    assert.match(await page.getByRole("dialog").innerText(), /仅供这台电脑的浏览器使用/);
    assert.match(await page.getByRole("dialog").innerText(), /正在等待本机浏览器/);
    await page.getByRole("button", { name: "关闭弹窗" }).click();
    await page.evaluate(() => {
      window.enrollmentSucceeds = true;
    });
    await page.getByRole("button", { name: "开启手机连接", exact: true }).click();
    await page.getByRole("button", { name: "正在登记中继…" }).waitFor();
    await page.evaluate(() => window.finishEnrollment());
    await page.getByRole("status").filter({ hasText: "已登记中继 relay.example.org" }).waitFor();
    assert.match(
      await page.locator(".remote-status-card").innerText(),
      /注册码已使用，无需再次填写/,
    );
    await page.getByRole("button", { name: "添加设备", exact: true }).click();
    await image.waitFor();
    assert.match(await page.getByRole("dialog").innerText(), /用手机扫描二维码/);
    assert.equal(
      await page.getByLabel("配对链接", { exact: true }).inputValue(),
      "https://relay.example.org/#invite=test",
    );
    if (process.env.AREAL_REMOTE_SETTINGS_SCREENSHOT)
      await page.screenshot({ path: process.env.AREAL_REMOTE_SETTINGS_SCREENSHOT, fullPage: true });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
  }
});
