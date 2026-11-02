import assert from "node:assert/strict";
import { test } from "node:test";
import { lintCss, motionProblem } from "./motion-lint.mjs";

test("flags literal transition durations and transition all", () => {
  for (const value of [
    "color 0.15s ease",
    "opacity 150ms",
    "transform 1s, color var(--motion-fast)",
    "all var(--motion-fast)",
  ])
    assert.ok(motionProblem("transition", value), value);
  assert.ok(motionProblem("transition-duration", ".2s"));
  assert.ok(motionProblem("transition-property", "all"));
});

test("accepts token durations, zero and var() fallbacks", () => {
  for (const value of [
    "color var(--motion-fast) var(--ease-standard)",
    "none",
    "opacity 0ms",
    "height var(--motion-normal, 160ms)",
  ])
    assert.equal(motionProblem("transition", value), null, value);
  assert.equal(motionProblem("transition-property", "color, background-color"), null);
});

test("flags infinite loops but not finite or token loops", () => {
  assert.ok(motionProblem("animation", "spin 1s linear infinite"));
  assert.ok(motionProblem("animation-iteration-count", "infinite"));
  assert.equal(motionProblem("animation", "spin 1s linear var(--motion-loop)"), null);
  assert.equal(motionProblem("animation", "toast-enter 160ms ease-out"), null);
});

test("reports multi-line declarations at their first line and honours exceptions", () => {
  const source =
    ".a {\n  transition:\n    color 0.15s ease,\n    background-color 0.15s ease;\n}\n.b { animation: turn-thinking-shimmer 1.8s linear infinite; }\n";
  assert.deepEqual(
    lintCss("x.css", source).map((item) => item.where),
    ["x.css:2", "x.css:6"],
  );
  assert.deepEqual(
    lintCss("renderer/src/workbench.css", source).map((item) => item.where),
    ["renderer/src/workbench.css:2"],
  );
});
