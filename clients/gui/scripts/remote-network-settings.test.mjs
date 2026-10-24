import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "../renderer/node_modules/vite/dist/node/index.js";
const require = createRequire(new URL("../renderer/package.json", import.meta.url));
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { IntlProvider } = require("react-intl");

test("Settings renders the Serve/organization consent and explicit unknown phone/policy boundary", async () => {
  const vite = await createServer({
    root: fileURLToPath(new URL("../renderer/", import.meta.url)),
    configFile: false,
    plugins: [{
      name: "static-locale-preferences",
      enforce: "pre",
      resolveId(id, importer) {
        if (id.endsWith("/settings/applicationPreferences.js") && importer?.endsWith("/i18n/IntlProvider.tsx"))
          return "\0static-locale-preferences";
      },
      load(id) {
        if (id === "\0static-locale-preferences")
          return 'export function useApplicationPreferences() { return { locale: "zh-CN" }; }';
      },
    }],
    resolve: { alias: { "@": fileURLToPath(new URL("../renderer/src/", import.meta.url)) } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null },
    appType: "custom",
    esbuild: { jsx: "automatic" },
  });
  try {
    const { MobileSettings } = await vite.ssrLoadModule("/src/settings/MobileSettings.tsx");
    const { catalogs } = await vite.ssrLoadModule("/src/i18n/messages.ts");
    const html = renderToStaticMarkup(
      React.createElement(IntlProvider, { locale: "zh-CN", messages: catalogs["zh-CN"] },
        React.createElement(MobileSettings, { action: async () => ({}), projects: [] })),
    );
    assert.match(html, /Tailscale Serve/);
    assert.match(html, /Tailscale Funnel · 公网/);
    assert.match(html, /aria-label="手机访问方式"/);
    assert.match(html, /连接详情与诊断/);
    assert.match(html, /手机连接待验证/);
    assert.match(html, /默认保持私人入口/);
    assert.match(html, /公网能力未认证/);
    assert.match(html, /disabled=""[^>]*>生成公网 Funnel 方案/);
    assert.match(html, /disabled=""[^>]*>生成恢复私人入口方案/);
    assert.match(html, /通过中继服务连接/);
    assert.match(html, /管理员一次性登记码/);
    assert.match(html, /type="password"/);
    assert.match(html, /disabled=""[^>]*>登记或启用 Relay/);
    assert.match(html, /我信任此 HTTPS 来源/);
    assert.match(html, /aria-label="配对入口"/);
    assert.match(html, /长期凭据只保存于 Host 加密设置/);
    assert.match(html, /disabled=""[^>]*>保存组织 HTTPS 来源/);
    assert.match(html, /disabled=""[^>]*>生成 Serve 方案/);
    assert.match(html, /组织 HTTPS/);
    assert.match(html, /手机.*tailnet/);
    assert.match(html, /策略.*未验证/);
    assert.match(html, /生成方案后，确认再应用/);
    assert.match(html, /配对.*过期/);
    assert.match(html, /Host.*离线/);
  } finally {
    await vite.close();
  }
});
