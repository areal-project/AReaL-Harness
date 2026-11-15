import { describe, expect, it } from "vite-plus/test";
import { startupReadyForPresentation } from "./useStartupRecovery.js";

describe("startupReadyForPresentation", () => {
  it("releases the shell while selected history is still reading", () => {
    expect(
      startupReadyForPresentation({
        themeReady: true,
        connectionState: "ready",
        selectionReady: true,
        restorationFailed: false,
        startupLifecycleBlocked: false,
        project: { id: "project" },
        currentRestoration: { pending: true },
      }),
    ).toBe(true);
  });

  it("keeps the startup screen for a confirmed restoration failure", () => {
    expect(
      startupReadyForPresentation({
        themeReady: true,
        connectionState: "ready",
        selectionReady: true,
        restorationFailed: true,
        startupLifecycleBlocked: false,
        project: { id: "project" },
        currentRestoration: { pending: false },
      }),
    ).toBe(false);
  });
});
