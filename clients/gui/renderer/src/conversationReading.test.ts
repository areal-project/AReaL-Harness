import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  beginReadingRestore,
  changeReadingIntent,
  createReadingState,
  readingDisclosure,
  rememberDisclosure,
  settleReadingRestore,
} from "./conversationReading.js";

const anchor = { turnId: "turn", itemId: "old", blockIndex: 0, offset: -12 };
afterEach(() => vi.unstubAllGlobals());
describe("reading disclosure checkpoint", () => {
  it("restores only each semantic object's manual choice after a renderer reload", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => storage.get(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    vi.resetModules();
    const first = await import("./conversationReading.js");
    first.rememberDisclosure("project:thread:turn:activity", true);
    first.rememberDisclosure("project:thread:turn:tool", false);
    vi.resetModules();
    const reloaded = await import("./conversationReading.js");
    expect(reloaded.readingDisclosure("project:thread:turn:activity")).toBe(true);
    expect(reloaded.readingDisclosure("project:thread:turn:tool")).toBe(false);
    expect(reloaded.readingDisclosure("other:thread:turn:activity")).toBeUndefined();
  });
  it("bounds stored choices by count and bytes while retaining the latest choice", async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => storage.get(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    vi.resetModules();
    const reading = await import("./conversationReading.js");
    for (let index = 0; index < 520; index++)
      reading.rememberDisclosure(`${"owner".repeat(100)}:${index}`, true);
    const raw = [...storage.values()][0];
    expect(raw.length).toBeLessThanOrEqual(65536);
    expect(JSON.parse(raw).length).toBeLessThanOrEqual(512);
    vi.resetModules();
    const reloaded = await import("./conversationReading.js");
    expect(reloaded.readingDisclosure(`${"owner".repeat(100)}:519`)).toBe(true);
    expect(reloaded.readingDisclosure(`${"owner".repeat(100)}:0`)).toBeUndefined();
  });
  it("keeps manual reading choices when session storage is unavailable", async () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("unavailable");
      },
    });
    vi.resetModules();
    const reading = await import("./conversationReading.js");
    reading.rememberDisclosure("unavailable-storage", true);
    expect(reading.readingDisclosure("unavailable-storage")).toBe(true);
  });
});
describe("conversation reading ownership", () => {
  it("retains manual disclosure by semantic identity without unbounded storage", () => {
    rememberDisclosure("owner:turn:tool", true);
    expect(readingDisclosure("owner:turn:tool")).toBe(true);
    expect(readingDisclosure("other:turn:tool")).toBeUndefined();
    for (let index = 0; index < 512; index++) rememberDisclosure(`other:${index}`, false);
    expect(readingDisclosure("owner:turn:tool")).toBeUndefined();
  });
  it("ignores an old restoration after wheel, keyboard or scrollbar intent", () => {
    for (const input of ["wheel", "keyboard", "scrollbar"]) {
      const restoring = beginReadingRestore(createReadingState("a", "g"), anchor);
      const holding = changeReadingIntent(restoring, {
        kind: "holding",
        anchor: { ...anchor, itemId: input },
      });
      expect(settleReadingRestore(holding, restoring, "ready")).toBe(holding);
    }
  });
  it("rejects late results after owner or generation changes", () => {
    const restoring = beginReadingRestore(createReadingState("a", "g"), anchor);
    for (const state of [createReadingState("b", "g"), createReadingState("a", "new")])
      expect(settleReadingRestore(state, restoring, "ready")).toBe(state);
  });
  it("makes failed or unsupported restoration finite rather than permanently pending", () => {
    for (const reason of ["missing", "limited", "unsupported", "layout"] as const) {
      const restoring = beginReadingRestore(createReadingState("a", "g"), anchor);
      expect(settleReadingRestore(restoring, restoring, reason)).toMatchObject({
        kind: "blocked",
        reason,
        anchor,
      });
    }
  });
  it("keeps an exact request identity until data is ready", () => {
    const restoring = beginReadingRestore(createReadingState("a", "g"), anchor);
    expect(settleReadingRestore(restoring, restoring, "ready")).toMatchObject({
      kind: "restoring",
      phase: "ready",
      anchor,
      revision: restoring.revision,
    });
    const next = beginReadingRestore(restoring, { ...anchor, itemId: "next" });
    expect(settleReadingRestore(next, restoring, "ready")).toBe(next);
  });
});
