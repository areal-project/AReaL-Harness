import test from "node:test";
import assert from "node:assert/strict";
import { projectNativeContent, contentToText, nativeContentRegistry } from "../packages/ui/dist/lib/conversation-content.js";
import { normalizeMessageSingleDollarMath } from "../packages/ui/dist/lib/math-text.js";

const fence = value => "```areal-ui\n" + JSON.stringify(value) + "\n```";
const metric = { version: 1, type: "metric", title: "构建耗时", value: "12", unit: "秒" };
test("native catalog has six data-only entries and one common text fallback", () => {
  assert.equal(Object.keys(nativeContentRegistry).length, 6);
  for (const entry of Object.values(nativeContentRegistry)) assert.deepEqual(entry.actions, []);
  const blocks = projectNativeContent("开头\n\n" + fence(metric) + "\n\n末尾");
  assert.deepEqual(blocks.map(block => block.kind), ["markdown", "native", "markdown"]);
  assert.equal(contentToText(blocks), "开头\n\n构建耗时：12 秒\n\n末尾");
});
test("unknown versions/types, extra action fields and oversized data stay readable", () => {
  for (const value of [{ ...metric, version: 2 }, { ...metric, type: "html", html: "<svg/>" }, { ...metric, onClick: "openExternal" }, { ...metric, value: "x".repeat(3000) }]) {
    const text = fence(value), blocks = projectNativeContent(text);
    assert.equal(blocks[0].kind, "unsupported"); assert.equal(contentToText(blocks), text);
  }
});
test("incomplete streaming blocks never produce an executable or native view", () => {
  const text = "before\n```areal-ui\n{\"version\":1";
  const parts = projectNativeContent(text, true);
  assert.equal(parts.at(-1).kind, "pending"); assert.equal(contentToText(parts), text);
  assert.equal(projectNativeContent(text, false).at(-1).kind, "unsupported");
});
test("literal nested fences, inline code and ordinary code remain Markdown", () => {
  for (const text of ["````md\n" + fence(metric) + "\n````", "`areal-ui`", "```js\n" + JSON.stringify(metric) + "\n```", "    " + fence(metric).replaceAll("\n", "\n    ")]) {
    assert.equal(projectNativeContent(text).every(block => block.kind === "markdown"), true);
    assert.equal(contentToText(projectNativeContent(text)), text);
  }
});
test("model labels are preserved as inert data; no component or HTML names are dispatched", () => {
  const value = { ...metric, title: '<svg onload="attack()">', value: "javascript:attack()" };
  const block = projectNativeContent(fence(value))[0];
  assert.equal(block.kind, "native"); assert.equal(block.data.title, value.title);
  const malicious = '```areal-ui\n{"version":1,"type":"metric","title":"t","value":"1","__proto__":{"polluted":true}}\n```';
  assert.equal(projectNativeContent(malicious)[0].kind, "unsupported"); assert.equal({}.polluted, undefined);
});
test("table dimensions and chart values are validated before rendering", () => {
  const table = { version: 1, type: "table", title: "T", columns: ["a", "b"], rows: [["1", "2"]] };
  assert.equal(projectNativeContent(fence(table))[0].kind, "native");
  assert.equal(projectNativeContent(fence({ ...table, rows: [["1"]] }))[0].kind, "unsupported");
  const chart = { version: 1, type: "bar-chart", title: "B", items: [{ label: "A", value: 2 }] };
  assert.equal(projectNativeContent(fence(chart))[0].kind, "native");
  assert.equal(projectNativeContent(fence({ ...chart, items: [{ label: "A", value: "2" }] }))[0].kind, "unsupported");
});
test("single-dollar math keeps formulas but protects currency, shell variables and code", () => {
  assert.equal(normalizeMessageSingleDollarMath("$x^2$ and $\\ce{H2O}$"), "$x^2$ and $\\ce{H2O}$");
  assert.equal(normalizeMessageSingleDollarMath("$5-$10"), "\\$5-\\$10");
  assert.equal(normalizeMessageSingleDollarMath("$HOME and $PATH"), "\\$HOME and \\$PATH");
  for (const text of ["`$HOME and $PATH`", "```bash\n$HOME and $PATH\n```", "$$x+y$$"]) assert.equal(normalizeMessageSingleDollarMath(text), text);
});
