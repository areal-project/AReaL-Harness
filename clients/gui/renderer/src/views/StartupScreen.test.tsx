import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { PlatformServices } from "../services.js";
import { StartupScreen } from "./StartupScreen.js";

vi.mock("../i18n/IntlProvider.js", () => ({ useI18n: () => ({ t: (id: string) => id }) }));

function renderStartup(delayed: boolean) {
  return renderToStaticMarkup(
    createElement(StartupScreen, {
      services: { capabilities: { native: true, mutations: true } } as unknown as PlatformServices,
      state: {
        connection: { state: "connecting" },
        lifecycle: { supported: true, operations: [] },
        lifecycleBlocked: false,
        delayed,
        restoration: { failed: false, refreshing: false, error: "" },
        backend: { pending: false, error: "" },
      },
      onCloseSettings: () => {},
      onSettings: () => {},
      onRetry: () => {},
      onBackendAction: () => {},
      onQuit: () => {},
    }),
  );
}

describe("StartupScreen", () => {
  it("keeps loading minimal before startup timeout", () => {
    const html = renderStartup(false);
    expect(html).toContain("startup.loading");
    expect(html).not.toContain("startup-actions");
    expect(html).not.toContain("startup.quit");
  });

  it("renders recovery and quit actions when startup is delayed without error", () => {
    const html = renderStartup(true);
    expect(html).toContain("startup.delayed");
    expect(html).toContain("startup-actions");
    expect(html).toContain("startup.check");
    expect(html).toContain("recovery.checkSettings");
    expect(html).toContain("startup.quit");
  });
});
