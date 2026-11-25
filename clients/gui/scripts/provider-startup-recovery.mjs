import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, transformWithOxc } from "vite-plus";

const gui = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(join(gui, "app/package.json"))("playwright-core");
const entry = String.raw`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ApplicationIntlProvider } from '/src/i18n/IntlProvider.tsx';
import { UnsavedChangesProvider } from '/src/settings/UnsavedChanges.tsx';
import { ModelSettings } from '/src/settings/ModelSettings.tsx';
import '/src/styles.css';
window.fixture = { connection: 'unavailable', calls: [] };
const action = async (name, params = {}) => {
  if ((name === 'providers' && params.operation === 'list') ||
      (name === 'chatgpt' && params.operation === 'status')) {
    window.fixture.calls.push({ name, connection: window.fixture.connection });
    if (window.fixture.connection !== 'ready')
      throw Object.assign(new Error('Fixture disconnected'), { code: 'DISCONNECTED' });
    if (name === 'chatgpt') return { authenticated: false, state: 'signed_out', models: [] };
    return {
      revision: 1,
      data: [{ id: 'fixture', name: 'Fixture Provider', enabled: true, protocol: 'responses',
        baseUrl: 'https://example.invalid/v1', authentication: 'none', models: [], parameters: {} }],
      credentialStates: {}, definitions: [], application: { kind: 'applied' },
    };
  }
  return {};
};
function Fixture() {
  const [connection, setConnection] = useState(window.fixture.connection);
  window.setConnection = (value) => { window.fixture.connection = value; setConnection(value); };
  return <ApplicationIntlProvider><UnsavedChangesProvider>
    <ModelSettings action={action} connectionState={connection} />
  </UnsavedChangesProvider></ApplicationIntlProvider>;
}
createRoot(document.getElementById('root')).render(<Fixture />);
`;
const virtual = "\0provider-startup-recovery.tsx";
const vite = await createServer({
  root: join(gui, "renderer"),
  configFile: join(gui, "renderer/vite.config.ts"),
  mode: "design-system",
  server: { host: "127.0.0.1", port: 0, hmr: false, watch: null },
  plugins: [
    {
      name: "provider-startup-recovery-fixture",
      resolveId(id) {
        if (id === "/provider-startup-recovery.tsx") return virtual;
      },
      async load(id) {
        if (id === virtual)
          return transformWithOxc(entry, "provider-startup-recovery.tsx", {
            jsx: { runtime: "automatic" },
          });
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.split("?")[0] !== "/__provider-startup-recovery.html") return next();
          res.setHeader("content-type", "text/html");
          res.end(
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/provider-startup-recovery.tsx"></script></body></html>',
          );
        });
      },
    },
  ],
});
let browser;
try {
  await vite.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.AREAL_CHROMIUM || undefined,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(
    `http://127.0.0.1:${vite.httpServer.address().port}/__provider-startup-recovery.html`,
  );
  const calls = (connection, count) =>
    page.waitForFunction(
      ({ connection, count }) => {
        const items = window.fixture.calls.filter((call) => call.connection === connection);
        return ["providers", "chatgpt"].every(
          (name) => items.filter((call) => call.name === name).length >= count,
        );
      },
      { connection, count },
    );
  await calls("unavailable", 1);
  const disconnected = "与桌面应用的连接断开了。你的内容已保留，重新连接后再试。";
  await page.getByText(disconnected, { exact: true }).first().waitFor();
  assert.equal(await page.getByText("Fixture disconnected", { exact: true }).count(), 0);
  await page.evaluate(() => window.setConnection("ready"));
  await calls("ready", 1);
  await page.getByText("Fixture Provider", { exact: true }).first().waitFor();
  await page.waitForFunction((text) => !document.body.innerText.includes(text), disconnected);
  await page.getByText("Fixture Provider", { exact: true }).first().click();
  const name = page.getByLabel("供应商名称");
  await name.fill("Edited fixture");
  await page.evaluate(() => window.setConnection("unavailable"));
  await calls("unavailable", 2);
  await page.evaluate(() => window.setConnection("ready"));
  await calls("ready", 2);
  await page.waitForFunction((text) => !document.body.innerText.includes(text), disconnected);
  assert.equal(
    await name.inputValue(),
    "Edited fixture",
    "reconnect retains the unsaved provider draft",
  );
  assert.deepEqual(errors, []);
  console.log("Provider and ChatGPT settings recover after reconnect and retain the draft.");
} finally {
  await browser?.close();
  await vite.close();
}
