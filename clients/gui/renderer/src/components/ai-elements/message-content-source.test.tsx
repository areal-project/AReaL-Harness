import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { MessageResponse } from "./message-response-renderer.js";

const { sources } = vi.hoisted(() => ({ sources: [] as string[] }));
vi.mock("katex/contrib/copy-tex", () => ({}));
vi.mock("../../i18n/IntlProvider.js", () => ({
  useI18n: () => ({ t: (id: string) => id }),
}));
vi.mock("../../settings/preferences.js", () => ({
  useCodePreferences: () => ({ fontSizePx: 13 }),
}));
vi.mock("../ui/code-viewer.js", () => ({
  CodeViewer: ({ code }: { code: string }) => createElement("pre", null, code),
}));
// 只截获表格展示边界；Markdown 解析、流式分块和清理使用生产实现。
vi.mock("./markdown-table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./markdown-table.js")>()),
  MarkdownTable: ({
    node,
    children,
  }: {
    node: { data?: { tableMarkdown?: string } };
    children: React.ReactNode;
  }) => {
    if (node.data?.tableMarkdown) sources.push(node.data.tableMarkdown);
    return createElement("table", null, children);
  },
}));

function render(markdown: string, streaming = false) {
  sources.length = 0;
  return renderToStaticMarkup(createElement(MessageResponse, { children: markdown, streaming }));
}

describe("conversation content source", () => {
  const table =
    "| 名称 | 值 |\n| :--- | ---: |\n| **说明** [链接](https://example.com/a) | `a\\|b` |";
  it("preserves table source, alignment, links and code through the real Markdown pipeline", () => {
    render(`前文\n\n${table}\n\n后文`);
    expect(sources).toEqual([table]);
  });
  it("associates each streaming table with its own source", () => {
    const second = "| B | C |\n| --- | --- |\n| 3 | 4 |";
    render(`前文\n\n${table}\n\n中间\n\n${second}\n\n继续生成`, true);
    expect(sources).toEqual([table, second]);
  });
  it("copies a nested table without blockquote prefixes", () => {
    render(
      table
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n"),
    );
    expect(sources).toEqual([table]);
  });
  it("keeps the definition used by a reference link when copying a table", () => {
    const referenced = "| 名称 |\n| --- |\n| [文档][guide] |";
    const definition = '[guide]: https://example.com/guide "文档"';
    render(`${referenced}\n\n${definition}`);
    expect(sources).toEqual([`${referenced}\n\n${definition}`]);
  });
  it("renders a closed Mermaid fence while subsequent text is still streaming", () => {
    const markup = render("```mermaid\nflowchart LR\nA --> B\n```\n\n仍在回答", true);
    expect(markup).toContain("content.expand");
  });
  it("keeps an incomplete Mermaid fence source-only", () => {
    const markup = render("```mermaid\nflowchart LR\nA -->", true);
    expect(markup).not.toContain("content.expand");
  });
});
