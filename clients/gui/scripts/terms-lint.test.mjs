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
    '  "a.b": { "zh-CN": "定时任务", en: "Scheduled" },\n  "a.c": { "zh-CN": "自动化中心", en: "Cancelled" },\n' +
    '  "settings.search.worktrees": { "zh-CN": "工作树、Worktree", en: "z" },\n';
  assert.deepEqual(
    lintTerms("m.ts", source).map((item) => `${item.where} ${item.problem}`),
    ["m.ts:2 “自动化”改用“定时任务”", "m.ts:2 “Cancelled”改用美式拼写“Canceled”"],
  );
});

test("enforces UX Writing bans for filler, bare empty states, standalone confirm, and raw Thread/Turn/Fork", () => {
  const source = [
    '  "a.filler": { "zh-CN": "温馨提示：请先保存", en: "Tip" },',
    '  "a.empty": { "zh-CN": "暂无数据", en: "No data" },',
    '  "a.confirm": { "zh-CN": "确定", en: "OK" },',
    '  "a.term": { "zh-CN": "新建 Thread 失败", en: "Failed" },',
  ].join("\n");
  const problems = lintTerms("m.ts", source).map((item) => `${item.where} ${item.problem}`);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /客套废话/);
  assert.match(problems[1], /空状态禁止/);
  assert.match(problems[2], /禁止孤立的“确定”/);
  assert.match(problems[3], /“Thread”改用“会话”/);
});
