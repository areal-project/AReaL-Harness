import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTENT_OWNED_SELECTORS,
  hasTargetDelta,
  inspectState,
  mixedLanguage,
  overlaps,
  rawErrors,
  unsolicitedToasts,
  untruthfulStatus,
} from "./ux-checks.mjs";

test("raw errors catch protocol codes and Host wording", () => {
  assert.deepEqual(rawErrors("设置读取失败：Host command failed"), ["Host command failed"]);
  assert.deepEqual(rawErrors("失败（COMMAND_FAILED）"), ["COMMAND_FAILED"]);
  assert.deepEqual(rawErrors("API Key 未填写"), []);
  assert.deepEqual(rawErrors("读取范围 用户 · revision 0 · 11/7/2026, 9:55:41 AM"), [
    "revision 0",
    "11/7/2026, 9:55:41 AM",
  ]);
});

test("mixed language flags English chrome words only as whole words", () => {
  assert.deepEqual(mixedLanguage("改动 +1 −0 · Changes"), ["Changes"]);
  assert.deepEqual(mixedLanguage("已工作 1 分钟 · ChangesetView"), []);
  assert.deepEqual(mixedLanguage("Host · running"), ["running"]);
});

test("overlaps ignore nested layers and touching edges", () => {
  const queue = { name: "queue#0", x: 0, y: 0, width: 100, height: 40 };
  assert.deepEqual(overlaps([queue, { name: "approval#0", x: 0, y: 30, width: 100, height: 40 }]), [
    ["queue#0", "approval#0"],
  ]);
  assert.deepEqual(
    overlaps([queue, { name: "approval#0", x: 0, y: 40, width: 100, height: 40 }]),
    [],
  );
  assert.deepEqual(
    overlaps([
      { ...queue, contains: ["menu#0"] },
      { name: "menu#0", x: 10, y: 10, width: 20, height: 20 },
    ]),
    [],
  );
});

test("status words only count while an approval is pending", () => {
  assert.deepEqual(untruthfulStatus("正在运行 npm test", true), ["正在运行"]);
  assert.deepEqual(untruthfulStatus("正在运行 npm test", false), []);
});

test("only toasts long after the last user input count as unsolicited", () => {
  assert.deepEqual(
    unsolicitedToasts([
      { message: "发送失败", sinceInput: 120 },
      { message: "工作区信息不可用", sinceInput: Infinity },
      { message: "已复制", sinceInput: 2999 },
    ]),
    ["工作区信息不可用"],
  );
});

test("content-owned selectors exclude user/model bodies without hiding app alerts in messages", () => {
  assert.ok(CONTENT_OWNED_SELECTORS.includes(".user-message-content"));
  assert.ok(CONTENT_OWNED_SELECTORS.includes(".assistant-message"));
  assert.ok(!CONTENT_OWNED_SELECTORS.includes(".messages"));
  assert.ok(!CONTENT_OWNED_SELECTORS.includes(".messages-embedded-content"));
  const uuid = "5d33b33e-2bcf-4f70-96dc-8576672272d0";
  // 正例：UUID 出现在用户/模型正文里（已被剥离，不在 appText 中）应通过。
  const chatBodyOnly = inspectState({ appText: "新会话\n发送" }, "正文含 UUID");
  assert.deepEqual(chatBodyOnly.problems, []);
  // 反例：同一 UUID 出现在应用告警里（保留在 appText 中）必须失败。
  const appAlertWithUuid = inspectState({ appText: `历史读取失败：${uuid}` }, "应用告警含 UUID");
  assert.deepEqual(appAlertWithUuid.problems, [`原始错误：${uuid}`]);
});

test("hasTargetDelta requires a post-action change when the target already existed", () => {
  assert.equal(hasTargetDelta({ count: 0, lastText: "" }, { count: 1, lastText: "新排队" }), true);
  assert.equal(
    hasTargetDelta({ count: 1, lastText: "旧排队" }, { count: 1, lastText: "旧排队" }),
    false,
  );
  assert.equal(
    hasTargetDelta({ count: 1, lastText: "旧排队" }, { count: 1, lastText: "旧排队\n新排队" }),
    true,
  );
  assert.equal(
    hasTargetDelta({ count: 1, lastText: "旧排队" }, { count: 2, lastText: "新排队" }),
    true,
  );
  assert.equal(hasTargetDelta({ count: 1, lastText: "旧排队" }, { count: 0, lastText: "" }), false);
});
