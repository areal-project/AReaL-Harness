import assert from "node:assert/strict";
import test from "node:test";
import { hostOverrides, literalFindings } from "./design-verified.mjs";
import { declaredCheck } from "./design-rules.mjs";

test("component CSS literals are reported; tokens, zero and hairlines are allowed", () => {
  const css = `/* 16px in a comment is fine */
.a { gap: var(--activity-icon-gap); width: 1px; margin: 0; }
.b { height: 16px; color: #fff; transition: opacity 300ms cubic-bezier(0.4, 0, 0.2, 1); }
.c { background: rgb(0 0 0); padding: 0.5rem; }`;
  assert.deepEqual(literalFindings(css), [
    "3: 16px",
    "3: #fff",
    "3: 300ms",
    "3: cubic-bezier(",
    "4: rgb(",
    "4: 0.5rem",
  ]);
  const responsive = `@media (max-width: 600px) {
  .a { padding: var(--spacing-inline); }
}
@container dock (max-width: 620px) {
  .b { padding: 12px; }
}`;
  assert.deepEqual(literalFindings(responsive), ["5: 12px"]);
});

test("host CSS selecting component internals is reported; prefixes do not match longer names", () => {
  const css = `.turn-execution > .areal-activity-group { margin: 0; }
.areal-activity-group-like { color: red; }
@media (width < 600px) { .x .areal-activity-row:hover { color: red; } }
.tool-file-row { gap: 0; }`;
  assert.deepEqual(hostOverrides(css, [".areal-activity-group", ".areal-activity-row"]), [
    "1: .turn-execution > .areal-activity-group",
    "3: .x .areal-activity-row:hover",
  ]);
});

test("a rule declares its check as a path or as review", () => {
  assert.equal(
    declaredCheck("规则。**检查：**`clients/gui/scripts/a.test.mjs`"),
    "clients/gui/scripts/a.test.mjs",
  );
  assert.equal(declaredCheck("规则。**检查：**人工 review。"), "review");
  assert.equal(declaredCheck("规则，没有声明检查。"), undefined);
});
