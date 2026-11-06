import assert from "node:assert/strict";
import test from "node:test";
import { mixedLanguage, overlaps, rawErrors, untruthfulStatus } from "./ux-checks.mjs";

test("raw errors catch protocol codes and Host wording", () => {
  assert.deepEqual(rawErrors("设置读取失败：Host command failed"), ["Host command failed"]);
  assert.deepEqual(rawErrors("失败（COMMAND_FAILED）"), ["COMMAND_FAILED"]);
  assert.deepEqual(rawErrors("API Key 未填写"), []);
});

test("mixed language flags English chrome words only as whole words", () => {
  assert.deepEqual(mixedLanguage("改动 +1 −0 · Changes"), ["Changes"]);
  assert.deepEqual(mixedLanguage("已工作 1 分钟 · ChangesetView"), []);
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
