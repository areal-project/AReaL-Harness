import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ActionButton } from "./action-button.js";

// R-ACTIONBUTTON-002: pending 时保留文字、显示转动图标并禁止重复点击。
describe("ActionButton pending behavior (R-ACTIONBUTTON-002)", () => {
  it("keeps label text, renders spinner, sets aria-busy and disables while pending", () => {
    const html = renderToStaticMarkup(
      createElement(ActionButton, { pending: true, children: "Save" }),
    );
    expect(html).toContain("Save");
    expect(html).toContain("areal-visible-spin");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
  });

  it("stays enabled without spinner when idle", () => {
    const html = renderToStaticMarkup(createElement(ActionButton, { children: "Save" }));
    expect(html).toContain("Save");
    expect(html).not.toContain("areal-visible-spin");
    expect(html).not.toContain('aria-busy="true"');
  });
});
