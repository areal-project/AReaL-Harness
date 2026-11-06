"use strict";
// Rust 差分测试调用旧实现产生期望；不读用户目录，不执行文件写入。
const { CoreLibrary } = require("@areal/workbench-service/desktop/core/library.cjs");
const projects = [{ id: "p" }, { id: "q" }, { id: "chat", projectless: true }];
const summaries = { p: ["a", "b"], q: ["c"], chat: ["d"] };
const context = { projects, summaries, readable: [] };
const requests = [
  { operation: "renameProject", projectId: "p", title: " Renamed " },
  { operation: "renameThread", projectId: "p", threadId: "a", title: " A " },
  { operation: "pinProject", projectId: "p", pinned: true },
  { operation: "pinThread", projectId: "p", threadId: "a", pinned: true },
  { operation: "moveProject", projectId: "p", sectionId: "s" },
  { operation: "moveThread", projectId: "p", threadId: "a", sectionId: "s" },
  { operation: "renameSection", sectionId: "s", title: " Group " },
  { operation: "orderSection", sectionId: "s", before: "t" },
  { operation: "orderProject", projectId: "q", before: "p" },
  { operation: "orderThread", projectId: "p", threadId: "b", before: "a" },
  { operation: "readThread", projectId: "p", threadId: "a", read: true, completionId: "old" },
  { operation: "readThread", projectId: "p", threadId: "a", read: true, completionId: "latest" },
  { operation: "readThread", projectId: "p", threadId: "a", read: false },
  { operation: "markAllRead" },
  { operation: "hideProject", projectId: "q", hidden: false },
  { operation: "settings", key: "sidebarSortChats", value: "manual", order: ["chat:d", "p:b"] },
  { operation: "settings", key: "showCompleted", value: false },
  { operation: "orderSidebarThread", projectId: "p", threadId: "a", before: "p:b" },
  {
    operation: "dropSidebar",
    source: { type: "thread", projectId: "p", id: "b", group: "project:p" },
    target: { type: "pinned" },
    edge: "inside",
    order: [],
  },
  {
    operation: "dropSidebar",
    source: { type: "project", id: "q", group: "projects" },
    target: { type: "section", id: "t" },
    edge: "inside",
    order: [],
  },
  {
    operation: "dropSidebar",
    source: { type: "section", id: "t" },
    target: { type: "section", id: "s" },
    edge: "after",
  },
  { operation: "removeSection", sectionId: "s" },
  { operation: "pinThread", projectId: "p", threadId: "missing", pinned: true },
  {
    operation: "dropSidebar",
    source: { type: "project", id: "q", group: "projects" },
    target: { type: "pinned" },
    expectedSidebarRevision: 0,
    edge: "inside",
  },
];
(async () => {
  const backend = {
    home: "unused",
    saved: projects,
    projects: new Map(
      projects.map((p) => [
        p.id,
        {
          summariesLoaded: true,
          summaries: summaries[p.id].map((id) => ({ id })),
          model: { state: {} },
        },
      ]),
    ),
    save: async () => {},
    onChange() {},
  };
  const library = new CoreLibrary(backend);
  library.value.sections = [
    { id: "s", title: "S" },
    { id: "t", title: "T" },
  ];
  library.value.settings = { httpProxy: "retained opaque setting", hardwareAcceleration: false };
  library.value.threads["p:a"] = { unread: true, completionId: "latest" };
  const cases = [];
  for (const input of requests) {
    const request = structuredClone(input);
    if (request.operation === "dropSidebar" && request.expectedSidebarRevision === undefined)
      request.expectedSidebarRevision = library.value.sidebarRevision;
    const before = structuredClone(library.value);
    let failed = false;
    const error = console.error;
    console.error = () => {};
    try {
      await library.command(request);
    } catch {
      failed = true;
    } finally {
      console.error = error;
    }
    cases.push({ request, before, after: structuredClone(library.value), failed });
  }
  process.stdout.write(JSON.stringify({ context, cases }));
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
