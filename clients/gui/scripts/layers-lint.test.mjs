import assert from "node:assert/strict";
import { test } from "node:test";
import { compareLayers, componentClasses, fingerprint, lintCss, lintSpec } from "./layers-lint.mjs";

const tokens = new Set(["radius-panel", "color-border"]);
const kinds = (findings) => findings.map((item) => item.kind);

test("flags primitive scale references and keeps purpose names", () => {
  const css = ".a { border-radius: var(--radius-xl); }\n.b { border-radius: var(--radius-panel); }";
  assert.deepEqual(
    kinds(lintCss("renderer/src/a.css", css, { tokens, classes: new Set(), isPackage: false })),
    ["primitive"],
  );
});

test("flags blur outside material definitions but not backdrop-filter none", () => {
  const css = ".a { backdrop-filter: blur(18px); }\n.b { backdrop-filter: none; }";
  assert.deepEqual(
    kinds(lintCss("renderer/src/a.css", css, { tokens, classes: new Set(), isPackage: false })),
    ["material"],
  );
});

test("flags fallbacks on generated tokens only inside the package", () => {
  const css = ".a { color: var(--color-border, #ddd); --x: var(--activity-foreground, red); }";
  const options = { tokens, classes: new Set() };
  assert.deepEqual(kinds(lintCss("packages/ui/src/a.css", css, { ...options, isPackage: true })), [
    "fallback",
  ]);
  assert.deepEqual(kinds(lintCss("renderer/src/a.css", css, { ...options, isPackage: false })), []);
});

test("flags page selectors that reach a rendered component class", () => {
  const classes = componentClasses(
    ".composer-surface { color: red; } .page-only { }",
    'className="composer-surface"',
  );
  assert.deepEqual([...classes], ["composer-surface"]);
  const css = [
    ".draft-composer .composer-surface { border-radius: 0; }",
    ".draft-composer { gap: 0; }",
    ".draft-composer .composer-surface { margin-top: 8px; }",
    ".composer-surface .page-part { color: red; }",
    ".page section:not(.composer-surface) { color: red; }",
  ].join("\n");
  assert.deepEqual(
    kinds(lintCss("renderer/src/a.css", css, { tokens, classes, isPackage: false })),
    ["restyle"],
  );
});

test("ignores theme and utility classes when collecting component classes", () => {
  assert.deepEqual(
    [...componentClasses(".dark .x, .relative { }", 'className="dark relative x"')],
    ["x"],
  );
});

test("spec files reject raw values and implementation names", () => {
  const yaml =
    "radius: radius-composer\npadding: 12px\nwhy: 由 Lexical 编辑器负责\n# 注释里的 8px 不算\n";
  assert.deepEqual(kinds(lintSpec("design/spec/a.yaml", yaml)), ["spec-number", "spec-word"]);
});

test("baseline admits known findings and reports new and fixed ones", () => {
  const [kept, fixed] = fingerprint([
    { file: "a.css", kind: "primitive", snippet: "x" },
    { file: "a.css", kind: "material", snippet: "y" },
  ]);
  const [added] = fingerprint([{ file: "b.css", kind: "primitive", snippet: "x" }]);
  const result = compareLayers([kept, added], [kept, fixed]);
  assert.deepEqual(result.added, [added]);
  assert.deepEqual(result.fixed, [fixed]);
});
