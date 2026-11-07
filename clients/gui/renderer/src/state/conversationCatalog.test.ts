import { expect, test } from "vite-plus/test";
import { conversationCatalog } from "./conversationCatalog.js";

const summaries = [
  { id: "named", preview: "读一下 README" },
  { id: "blank" },
  { id: "titled" },
];
// Host 对未启动项目给出缓存摘要，同一份也写进资料库的导航缓存。
const library = {
  threads: { "p:titled": { title: "周报" } },
  projects: { p: { navigationSummaries: summaries } },
};
const project = (connected: boolean) => ({
  id: "p",
  summaries,
  summariesLoaded: connected,
  state: { connected, threads: {}, interactions: {} },
});
const rows = (connected: boolean, open?: { projectId: string; threadId: string }) =>
  conversationCatalog([project(connected)], library, open).map((row) => ({
    id: row.summary.id,
    statePending: row.statePending,
  }));

test("sidebar rows are the same whether or not the project has started", () => {
  expect(rows(false)).toEqual(rows(true));
  expect(rows(false)).toEqual([
    { id: "named", statePending: false },
    { id: "titled", statePending: false },
  ]);
});

test("a conversation that never got a first message stays out unless it is open", () => {
  expect(rows(false, { projectId: "p", threadId: "blank" }).map((row) => row.id)).toContain(
    "blank",
  );
});

test("pending only while a started project is still loading its list", () => {
  const loading = { ...project(true), summariesLoaded: false };
  expect(conversationCatalog([loading], library).every((row) => row.statePending)).toBe(true);
});
