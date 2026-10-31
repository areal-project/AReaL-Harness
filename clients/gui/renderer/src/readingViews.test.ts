import { afterEach, expect, test, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function fixture(unavailable = false) {
  let raw: string | null = null;
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: () => raw,
      setItem: (_key: string, value: string) => {
        if (unavailable) throw new Error("Storage unavailable");
        raw = value;
      },
    },
  });
  const views = await import("./readingViews.js");
  const owner = (index: number) => JSON.stringify(["project", `thread-${index}`, false]);
  const remember = (index: number) => {
    const key = owner(index);
    views.readingViews.delete(key);
    views.readingViews.set(key, { top: index, following: true, atTail: true });
    views.saveReadingViews();
  };
  return { ...views, owner, remember, raw: () => raw };
}

test("reading checkpoints retain only the most recent 32 contexts in memory", async () => {
  const f = await fixture();
  for (let index = 0; index < 1024; index++) f.remember(index);
  expect(f.readingViews.size).toBe(32);
  expect([...f.readingViews.keys()]).toEqual(
    Array.from({ length: 32 }, (_, index) => f.owner(index + 992)),
  );
  expect(JSON.parse(f.raw() ?? "{}").views).toHaveLength(32);
});

test("revisiting a context protects its anchor from the next eviction and reload", async () => {
  const f = await fixture();
  for (let index = 0; index < 32; index++) f.remember(index);
  const anchor = { turnId: "turn", itemId: "message", blockIndex: 4, offset: -18.5 };
  f.readingViews.delete(f.owner(0));
  f.readingViews.set(f.owner(0), {
    top: 800,
    following: false,
    atTail: false,
    anchor,
    responseSpace: { turnId: "turn", height: 200, contentHeight: 300 },
  });
  f.saveReadingViews();
  f.remember(32);
  expect(f.readingViews.has(f.owner(1))).toBe(false);
  expect(f.readingViews.get(f.owner(0))?.anchor).toEqual(anchor);
  vi.resetModules();
  const restored = await import("./readingViews.js");
  restored.hydrateReadingViews();
  expect(restored.readingViews.size).toBe(32);
  expect(restored.readingViews.get(f.owner(0))).toEqual({
    top: 0,
    following: false,
    atTail: false,
    anchor,
  });
  expect(restored.readingViews.get(f.owner(32))?.following).toBe(true);
});

test("unavailable session storage still bounds the live reading cache", async () => {
  const f = await fixture(true);
  for (let index = 0; index < 64; index++) f.remember(index);
  expect(f.readingViews.size).toBe(32);
  expect(f.raw()).toBeNull();
  expect(f.readingViews.get(f.owner(63))?.following).toBe(true);
});

test("large semantic anchors respect the checkpoint character budget", async () => {
  const f = await fixture();
  for (let index = 0; index < 32; index++) {
    const owner = JSON.stringify(["project".repeat(140), `thread-${index}`, false]);
    f.readingViews.set(owner, {
      top: 500,
      following: false,
      atTail: false,
      anchor: {
        turnId: "turn".repeat(250),
        itemId: "message".repeat(140),
        blockIndex: 1,
        offset: 3.25,
      },
    });
    f.saveReadingViews();
  }
  const raw = f.raw() ?? "";
  expect(raw.length).toBeLessThanOrEqual(65536);
  expect(JSON.parse(raw).views.length).toBeLessThan(32);
  expect(JSON.parse(raw).views[0].position.anchor.offset).toBe(3.25);
  expect(f.readingViews.size).toBe(32);
});

test("the exact character limit includes the envelope and comma and skips an oversized newest entry", async () => {
  const f = await fixture();
  f.remember(0);
  const small = { owner: f.owner(0), position: { kind: "latest" } };
  const anchor = { turnId: "turn", itemId: "", blockIndex: 0, offset: -0.25 };
  const large = { owner: f.owner(1), position: { kind: "reading", anchor } };
  const emptyLength = JSON.stringify({ version: 1, views: [large, small] }).length;
  anchor.itemId = "雪".repeat(65536 - emptyLength);
  f.readingViews.set(f.owner(1), { top: 900, following: false, atTail: false, anchor });
  f.saveReadingViews();
  const exact = f.raw() ?? "";
  expect(exact.length).toBe(65536);
  expect(new TextEncoder().encode(exact).length).toBeGreaterThan(65536);
  expect(JSON.parse(exact)).toEqual({ version: 1, views: [large, small] });
  expect(exact).toBe(JSON.stringify({ version: 1, views: [large, small] }));
  anchor.itemId += "雪";
  f.saveReadingViews();
  expect(JSON.parse(f.raw() ?? "{}").views.map((entry: { owner: string }) => entry.owner)).toEqual([
    f.owner(1),
  ]);
  anchor.itemId += "雪".repeat(JSON.stringify(small).length + 1);
  f.saveReadingViews();
  expect(JSON.parse(f.raw() ?? "{}")).toEqual({ version: 1, views: [small] });
  expect(f.readingViews.size).toBe(2);
});

test("escaped Unicode identities and anchors keep their exact JSON representation", async () => {
  const f = await fixture();
  const owner = JSON.stringify(["project", '雪🙂\n"\\', false]);
  const anchor = { turnId: "turn-🙂", itemId: 'item-雪\n"\\', blockIndex: null, offset: 1.5 };
  f.readingViews.set(owner, { top: 100, following: false, atTail: false, anchor });
  f.saveReadingViews();
  const expected = { version: 1, views: [{ owner, position: { kind: "reading", anchor } }] };
  expect(JSON.parse(f.raw() ?? "{}")).toEqual(expected);
  expect(f.raw()).toBe(JSON.stringify(expected));
  vi.resetModules();
  const restored = await import("./readingViews.js");
  restored.hydrateReadingViews();
  expect(restored.readingViews.get(owner)?.anchor).toEqual(anchor);
});

test("a failed storage write is retried for an unchanged checkpoint", async () => {
  const views = await import("./readingViews.js");
  let attempts = 0;
  let raw: string | null = null;
  vi.stubGlobal("window", {
    sessionStorage: {
      setItem: (_key: string, value: string) => {
        attempts++;
        if (attempts === 1) throw new Error("Storage temporarily unavailable");
        raw = value;
      },
    },
  });
  const owner = JSON.stringify(["project", "thread", false]);
  views.readingViews.set(owner, { top: 0, following: true, atTail: true });
  views.saveReadingViews();
  expect(raw).toBeNull();
  views.saveReadingViews();
  expect(attempts).toBe(2);
  expect(JSON.parse(raw ?? "{}")).toEqual({
    version: 1,
    views: [{ owner, position: { kind: "latest" } }],
  });
});

test("local send replaces prior holding intent only when a new user turn arrives", async () => {
  const f = await fixture();
  const owner = JSON.stringify(["project", "thread", false]);
  const anchor = { turnId: "old", itemId: "message", blockIndex: null, offset: 12 };
  f.readingViews.set(owner, { top: 80, following: false, atTail: false, anchor });
  const first = f.requestTurnStart("project", "thread", "old");
  expect(f.readingViews.get(owner)).toMatchObject({
    following: false,
    anchor,
    pendingTurnStart: first,
  });
  const next = f.requestTurnStart("project", "thread", "old");
  f.cancelTurnStart(first);
  expect(f.readingViews.get(owner)?.pendingTurnStart).toBe(next);
  f.cancelTurnStart(next);
  expect(f.readingViews.get(owner)?.pendingTurnStart).toBeUndefined();
  expect(f.readingViews.get(owner)?.anchor).toEqual(anchor);
});

test("a local send intent does not survive a cold history reload", async () => {
  const f = await fixture();
  f.requestTurnStart("project", "thread");
  f.saveReadingViews();
  expect(f.raw()).not.toContain("pendingTurnStart");
  const raw = f.raw();
  vi.resetModules();
  vi.stubGlobal("window", { sessionStorage: { getItem: () => raw } });
  const reloaded = await import("./readingViews.js");
  reloaded.hydrateReadingViews();
  expect(reloaded.readingViews.get(JSON.stringify(["project", "thread", false]))).toEqual({
    top: 0,
    following: true,
    atTail: true,
  });
});
