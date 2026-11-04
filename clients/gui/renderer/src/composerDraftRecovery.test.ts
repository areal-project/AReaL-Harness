import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key)),
  });
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("draft persistence", () => {
  it("coalesces typing while reads see current intent and clear prevents resurrection", async () => {
    const { composerDraftStorage: store } = await import("./composerDraftStorage.js");
    for (let i = 0; i < 20; i++) store.scheduleItem("draft", String(i));
    expect(store.getItem("draft")).toBe("19");
    expect(localStorage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    store.scheduleItem("draft", "already sent");
    store.removeItem("draft");
    vi.advanceTimersByTime(150);
    expect(store.getItem("draft")).toBeNull();
    store.scheduleItem("draft", "old");
    store.setItem("draft", "new external intent");
    vi.advanceTimersByTime(150);
    expect(store.getItem("draft")).toBe("new external intent");
  });

  it("flushes latest text on reload and keeps transient Side drafts private", async () => {
    const {
      composerDraftStorage: store,
      registerTransientComposer,
      forgetTransientComposer,
    } = await import("./composerDraftStorage.js");
    store.scheduleItem("main", "last character");
    window.dispatchEvent(new Event("beforeunload"));
    expect(localStorage.getItem("main")).toBe("last character");
    registerTransientComposer("p", "side");
    store.scheduleItem("areal-gui:draft:p:side", "private draft");
    window.dispatchEvent(new Event("pagehide"));
    expect(localStorage.getItem("areal-gui:draft:p:side")).toBeNull();
    forgetTransientComposer("p", "side");
    expect(store.getItem("areal-gui:draft:p:side")).toBeNull();
  });

  it("restores pasted text and missing-file identity without persisting file bytes", async () => {
    const { attachmentDrafts: drafts } = await import("./composerDraftAttachments.js");
    const file = new File(["private bytes"], "diagram.png", {
      type: "image/png",
      lastModified: 42,
    });
    drafts.set("a", [file, { kind: "pasted-text", text: "long\npasted\ntext" }]);
    expect(drafts.get("a")?.[0]).toBe(file);
    expect(localStorage.getItem("a:attachments")).not.toContain("private bytes");
    vi.resetModules();
    const { attachmentDrafts: restored } = await import("./composerDraftAttachments.js");
    expect(restored.get("a")).toEqual([
      { kind: "missing-file", name: "diagram.png", type: "image/png", size: 13, lastModified: 42 },
      { kind: "pasted-text", text: "long\npasted\ntext" },
    ]);
    expect(restored.get("b")).toBeUndefined();
    restored.delete("a");
    vi.resetModules();
    expect(
      (await import("./composerDraftAttachments.js")).attachmentDrafts.get("a"),
    ).toBeUndefined();
  });
});
