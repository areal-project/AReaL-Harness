import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { labsAvailable, setLabsFeature } from "./labsFeatures.js";

describe("labsFeatures", () => {
  const storage = new Map<string, string>();
  const originalWindow = globalThis.window;

  beforeEach(() => {
    storage.clear();
    const target = new EventTarget();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          setItem: (key: string, value: string) => storage.set(key, value),
          clear: () => storage.clear(),
        },
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        dispatchEvent: target.dispatchEvent.bind(target),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
  });

  it("exposes the standalone Labs entry and keeps bots disabled by default", () => {
    expect(labsAvailable).toBe(true);
    expect(window.localStorage.getItem("areal.gui.labs.v1")).toBeNull();
    setLabsFeature("bots", true);
    expect(JSON.parse(window.localStorage.getItem("areal.gui.labs.v1") || "{}")).toEqual({
      bots: true,
    });
    setLabsFeature("bots", false);
    expect(JSON.parse(window.localStorage.getItem("areal.gui.labs.v1") || "{}")).toEqual({
      bots: false,
    });
  });
});
