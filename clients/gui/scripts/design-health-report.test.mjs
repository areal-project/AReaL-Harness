import test from "node:test";
import assert from "node:assert/strict";
import {
  collectDesignHealth,
  formatTerminalReport,
  renderHtmlReport,
} from "./design-health-report.mjs";

test("collectDesignHealth aggregates live tokens, components, and deterministic guardrails", async () => {
  const report = await collectDesignHealth();
  assert.ok(report.tokens.total > 0, "tokens should be counted from tokens.json");
  assert.ok(report.components.total > 0, "@areal/ui components should be discovered");
  assert.ok(report.components.verified > 0, "verified components should be counted");
  assert.ok(report.components.stable > 0, "stable components should be counted");
  assert.ok(report.components.experimental > 0, "experimental components should be counted");
  assert.equal(report.guardrails.length, 12);
  for (const id of [
    "spacing-literal",
    "host-ui-class",
    "native-control",
    "restyle",
    "ui-honesty",
  ]) {
    assert.ok(
      report.guardrails.some((item) => item.id === id),
      `guardrail ${id} must be present`,
    );
  }
  const text = formatTerminalReport(report);
  assert.match(text, /DESIGN\.md/);
  assert.match(text, /间距魔法值禁令/);

  const html = renderHtmlReport(report);
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /AReaL Harness Design System Health/);
});
