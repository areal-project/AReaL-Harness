import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";

vi.mock("../i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));
vi.mock("./LazyWorkbenchSettings.js", () => ({ preloadWorkbenchSettings: () => {} }));

import { StartupScreen } from "./StartupScreen.js";

function renderStartup(overrides?: {
  connection?: { state: "connecting" | "ready" | "unavailable"; stage?: string; message?: string };
  failed?: boolean;
  refreshing?: boolean;
  delayed?: boolean;
  settingsPage?: ReturnType<typeof createElement>;
}) {
  return renderToStaticMarkup(
    createElement(StartupScreen, {
      services: { capabilities: { mutations: true, native: true, settings: [] } } as never,
      state: {
        connection: overrides?.connection ?? { state: "connecting", stage: "host" },
        lifecycle: undefined,
        lifecycleBlocked: false,
        delayed: overrides?.delayed ?? false,
        restoration: {
          failed: overrides?.failed ?? false,
          refreshing: overrides?.refreshing ?? false,
          error: "",
        },
        backend: { pending: false, error: "" },
      },
      settingsPage: overrides?.settingsPage,
      onCloseSettings: () => {},
      onSettings: () => {},
      onRetry: () => {},
      onBackendAction: () => {},
      onQuit: () => {},
    }),
  );
}

it("shows clean loading without exposing internal stages or premature actions", () => {
  const html = renderStartup({ connection: { state: "connecting", stage: "host" } });
  expect(html).toContain('data-testid="startup-loading"');
  expect(html).toContain("startup.loading");
  expect(html).toContain("startup-progress");
  expect(html).not.toContain("startup.stage.");
  expect(html).not.toContain("startup.step.");
  expect(html).not.toContain("startup.reconnect");
  expect(html).not.toContain("startup.check");
  expect(html).not.toContain("startup.openSettings");
  expect(html).not.toContain("startup.quit");
});

it("keeps project and conversation preparation as loading", () => {
  expect(renderStartup({ connection: { state: "ready" }, refreshing: false })).toContain(
    "startup.loading",
  );
  expect(renderStartup({ connection: { state: "ready" }, refreshing: true })).toContain(
    "startup.loading",
  );
});

it("reveals fallback actions when startup is delayed", () => {
  const html = renderStartup({ delayed: true });
  expect(html).toContain("startup.delayed");
  expect(html).toContain("startup.openSettings");
  expect(html).toContain("startup.quit");
  expect(html).not.toContain("startup.reconnect");
});

it("offers recovery only for a confirmed failure", () => {
  const html = renderStartup({ connection: { state: "unavailable", message: "failure detail" } });
  expect(html).toContain("startup.failed");
  expect(html).toContain("startup.reconnect");
  expect(html).toContain("recovery.checkSettings");
  expect(html).toContain("startup.quit");
  expect(html).toContain("failure detail");
  expect(html).not.toContain("startup-progress");
});

it("renders settings view with back button when settingsPage is active during startup", () => {
  const html = renderStartup({
    settingsPage: createElement("div", { "data-testid": "mock-settings" }, "SettingsBody"),
  });
  expect(html).toContain("startup.back");
  expect(html).toContain("SettingsBody");
});
