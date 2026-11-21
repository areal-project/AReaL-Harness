import test from "node:test";
import assert from "node:assert/strict";
import {
  spacingLiteralFindings,
  extractUiOwnedClasses,
  hostUiClassFindings,
  compareGuardrailCounts,
  summarizeTotals,
} from "./ui-guardrails-lint.mjs";

test("spacingLiteralFindings flags non-zero px/rem/em in padding/margin/gap and allows tokens and zero", () => {
  const css = `
    /* padding: 16px; */
    .ok {
      padding: 0;
      margin: 0px auto;
      gap: var(--spacing-sm);
      padding-inline: var(--spacing-md);
      border-width: 1px;
      width: 240px;
    }
    .bad {
      padding: 12px 0;
      margin-top: 0.5rem;
      row-gap: 6px;
      gap: calc(var(--spacing-sm) + 2px);
    }
  `;
  const findings = spacingLiteralFindings(css);
  assert.equal(findings.length, 4);
  assert.ok(findings.some((item) => item.includes("padding: 12px 0")));
  assert.ok(findings.some((item) => item.includes("margin-top: 0.5rem")));
  assert.ok(findings.some((item) => item.includes("row-gap: 6px")));
  assert.ok(findings.some((item) => item.includes("calc(var(--spacing-sm) + 2px)")));
});

test("hostUiClassFindings only flags .areal-* classes owned by @areal/ui", () => {
  const uiClasses = extractUiOwnedClasses(`
    .areal-button { display: inline-flex; }
    .areal-task-context .areal-subagent-name { font-weight: 500; }
  `);
  assert.ok(uiClasses.has(".areal-button"));
  assert.ok(uiClasses.has(".areal-task-context"));
  assert.ok(uiClasses.has(".areal-subagent-name"));

  const hostCss = `
    @media (max-width: 600px) {
      .page .areal-button { padding: 0; }
      .page .areal-local-animation { opacity: 1; }
    }
  `;
  const findings = hostUiClassFindings(hostCss, uiClasses);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /\.areal-button/);
});

test("compareGuardrailCounts detects increases and decreases per file and rule", () => {
  const baseline = {
    "renderer/src/a.css": { "spacing-literal": 3, "host-ui-class": 1 },
    "renderer/src/b.tsx": { "native-control": 2 },
  };
  const actual = {
    "renderer/src/a.css": { "spacing-literal": 2, "host-ui-class": 2 },
    "renderer/src/c.tsx": { "native-control": 1 },
  };
  const diff = compareGuardrailCounts(actual, baseline);
  assert.deepEqual(diff.increased, [
    { file: "renderer/src/a.css", rule: "host-ui-class", before: 1, after: 2 },
    { file: "renderer/src/c.tsx", rule: "native-control", before: 0, after: 1 },
  ]);
  assert.deepEqual(diff.decreased, [
    { file: "renderer/src/a.css", rule: "spacing-literal", before: 3, after: 2 },
    { file: "renderer/src/b.tsx", rule: "native-control", before: 2, after: 0 },
  ]);
  assert.deepEqual(summarizeTotals(actual), {
    "spacing-literal": 2,
    "host-ui-class": 2,
    "native-control": 1,
  });
});
