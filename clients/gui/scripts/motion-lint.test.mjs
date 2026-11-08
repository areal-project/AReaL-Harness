import assert from "node:assert/strict";
import { test } from "node:test";
import { lintCss, lintSource, motionProblem } from "./motion-lint.mjs";

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
  assert.equal(
    motionProblem("animation", "spin var(--motion-cycle) linear var(--motion-loop)"),
    null,
  );
  assert.equal(
    motionProblem("animation", "toast-enter var(--motion-normal) var(--ease-standard)"),
    null,
  );
});

test("flags literal animation durations and literal easings", () => {
  assert.ok(motionProblem("animation", "toast-enter 160ms var(--ease-standard)"));
  assert.ok(motionProblem("animation-duration", "1.2s"));
  assert.ok(motionProblem("transition", "opacity var(--motion-fast) ease-out"));
  assert.ok(motionProblem("animation", "pop var(--motion-fast) cubic-bezier(0.3, 0, 0, 1)"));
  assert.ok(motionProblem("transition-timing-function", "ease"));
  assert.equal(
    motionProblem("animation", "spin var(--motion-cycle) linear var(--motion-loop)"),
    null,
  );
  assert.equal(motionProblem("animation", "ease-pulse var(--motion-fast) steps(4)"), null);
});

test("reports multi-line declarations at their first line", () => {
  const source =
    ".a {\n  transition:\n    color 0.15s ease,\n    background-color 0.15s ease;\n}\n.b { animation: turn-thinking-shimmer 1.8s linear infinite; }\n";
  assert.deepEqual(
    lintCss("x.css", source).map((item) => item.where),
    ["x.css:2", "x.css:6"],
  );
});

test("flags literal Tailwind motion utilities but not token ones", () => {
  const source =
    'a = "transition-opacity duration-200 ease-out";\nb = "duration-(--motion-fast) ease-(--ease-standard) duration-0";\n';
  assert.deepEqual(
    lintSource("x.tsx", source).map((item) => `${item.where} ${item.text}`),
    ["x.tsx:1 duration-200", "x.tsx:1 ease-out"],
  );
});
