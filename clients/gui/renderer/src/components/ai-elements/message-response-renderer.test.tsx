import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { MessageResponse } from "./message-response-renderer.js";

vi.mock("katex/contrib/copy-tex", () => ({}));
vi.mock("../../i18n/IntlProvider.js", () => ({
  useI18n: () => ({ t: (id: string) => id }),
}));
vi.mock("../../settings/preferences.js", () => ({
  useCodePreferences: () => ({ fontSizePx: 13 }),
}));

function reply(markdown: string) {
  const images: string[] = [];
  const cards: Array<[string, string]> = [];
  const markup = renderToStaticMarkup(
    createElement(MessageResponse, {
      children: markdown,
      preserveLineBreaks: true,
      fileLinks: true,
      onOpenFileLink: () => {},
      onRenderImage: (uri: string) => {
        images.push(uri);
        return createElement("span", { "data-image": uri });
      },
      onRenderFileCard: (path: string, label: string) => {
        cards.push([path, label]);
        return path.endsWith(".pdf") ? createElement("span", { "data-card": path }) : null;
      },
    }),
  );
  return { markup, images, cards };
}

describe("agent reply workspace media", () => {
  it("keeps relative file locations when the reply has no media renderer or root hint", () => {
    const cards: string[] = [];
    renderToStaticMarkup(
      createElement(MessageResponse, {
        children: "[line](src/a%20b.ts#L120)",
        fileLinks: true,
        onOpenFileLink: () => {},
        onRenderFileCard: (path: string) => {
          cards.push(path);
          return null;
        },
      }),
    );
    expect(cards).toEqual(["./src/a b.ts#L120"]);
  });

  it("keeps bare relative image paths instead of blocking them", () => {
    const { markup, images } = reply("![表 1](out/rsi-paper-tables/表1.png)");
    expect(markup).not.toContain("blocked");
    expect(images).toEqual(["./out/rsi-paper-tables/表1.png"]);
  });

  it("passes authored relative and absolute paths through URL hardening unchanged", () => {
    const { images } = reply("![a](./out/a.png)\n\n![b](../b.png)\n\n![c](/home/me/repo/c.png)");
    expect(images).toEqual(["./out/a.png", "../b.png", "/home/me/repo/c.png"]);
  });

  it("restores local HTML file URI links with filename escapes decoded exactly once", () => {
    const { markup, cards } = reply(
      "[页面](file:///tmp/%E4%B8%AD%E6%96%87%20%2520%23L12%3F.html)\n\n[HTM](file://localhost/tmp/page.HTM)",
    );
    expect(cards).toEqual([
      ["/tmp/中文 %20#L12?.html", "页面"],
      ["/tmp/page.HTM", "HTM"],
    ]);
    expect(markup).not.toContain("blocked");
    expect(markup).toContain("markdown-file-reference");
  });

  it("keeps nonlocal, malformed, and non-HTML file URI links blocked", () => {
    const { cards, images } = reply(
      "[remote](file://server/tmp/page.html)\n\n[bad](file:///tmp/%ZZ.html)\n\n[text](file:///tmp/a.txt)\n\n![HTML](file:///tmp/page.html)",
    );
    expect(cards).toEqual([]);
    expect(images).toEqual([]);
  });

  it("keeps Core media URIs and rejects file URLs", () => {
    const { markup, images } = reply("![a](areal://blob/abc)\n\n![b](file:///etc/passwd)");
    expect(images).toEqual(["areal://blob/abc"]);
    expect(markup).not.toContain("/etc/passwd");
  });

  it("offers a file card for a paragraph holding only one file link", () => {
    const { markup, cards } = reply("[论文表格 PDF](out/tables.pdf)");
    expect(cards).toEqual([["./out/tables.pdf", "论文表格 PDF"]]);
    expect(markup).toContain('data-card="./out/tables.pdf"');
  });

  it("keeps inline file links clickable when the host declines a card", () => {
    const { markup } = reply("查看高清 [PNG](out/a.png) · 下载 [ZIP](out/a.zip)");
    expect(markup).not.toContain("blocked");
    expect(markup).toContain("markdown-file-reference");
  });
});
