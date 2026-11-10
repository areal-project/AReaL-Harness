import assert from "node:assert/strict";
import { test } from "node:test";
import { chineseMessages, lintTerms } from "./terms-lint.mjs";

test("reads multi-line and single-line Chinese messages", () => {
  const source =
    '  "a.b": { "zh-CN": "定时任务", en: "Scheduled tasks" },\n  "a.c": {\n    "zh-CN": "打开 \\"x\\"",\n    en: "Open",\n  },\n';
  assert.deepEqual(
    chineseMessages(source).map((item) => [item.id, item.text]),
    [
      ["a.b", "定时任务"],
      ["a.c", '打开 "x"'],
    ],
  );
});

test("flags retired names with the line of the message", () => {
  const source =
    '  "a.b": { "zh-CN": "定时任务", en: "x" },\n  "a.c": { "zh-CN": "自动化中心", en: "y" },\n' +
    '  "settings.search.worktrees": { "zh-CN": "工作树、Worktree", en: "z" },\n';
  assert.deepEqual(
    lintTerms("m.ts", source).map((item) => `${item.where} ${item.problem}`),
    ["m.ts:2 “自动化”改用“定时任务”"],
  );
});
