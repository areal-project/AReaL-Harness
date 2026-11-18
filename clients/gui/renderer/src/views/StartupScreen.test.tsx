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

it("exposes live startup stage progress and clickable Settings while loading", () => {
  const html = renderStartup({ connection: { state: "connecting", stage: "host" } });
  expect(html).toContain('data-testid="startup-loading"');
  expect(html).toContain("startup.stage.host");
  expect(html).toContain("startup.step.backend");
  expect(html).toContain("startup.openSettings");
  expect(html).toContain("startup.quit");
});

it("maps ready connection and session restoration to the project and conversation stages", () => {
  expect(renderStartup({ connection: { state: "ready" }, refreshing: false })).toContain(
    "startup.stage.project",
  );
  expect(renderStartup({ connection: { state: "ready" }, refreshing: true })).toContain(
    "startup.stage.conversation",
  );
});

it("renders settings view with back button when settingsPage is active during startup", () => {
  const html = renderStartup({
    settingsPage: createElement("div", { "data-testid": "mock-settings" }, "SettingsBody"),
  });
  expect(html).toContain("startup.back");
  expect(html).toContain("SettingsBody");
});
