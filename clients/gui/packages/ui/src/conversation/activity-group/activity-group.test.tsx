import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ActivityGroup } from "./activity-group.js";

describe("controlled activity reading", () => {
  it("passes an activity group's choice through to its accessible disclosure", () => {
    const render = (open: boolean) =>
      renderToStaticMarkup(
        createElement(ActivityGroup, {
          label: "Tools",
          open,
          children: "Tool result",
        }),
      );
    expect(render(true)).toContain('aria-expanded="true"');
    expect(render(false)).toContain('aria-expanded="false"');
    expect(render(true)).not.toContain('hidden=""');
    expect(render(false)).toContain('hidden=""');
  });

  it("renders optional duration metadata and active state without altering disclosure semantics", () => {
    const html = renderToStaticMarkup(
      createElement(ActivityGroup, {
        label: "Explored 3 files",
        duration: "4.2s",
        active: true,
        open: false,
        children: "Details",
      }),
    );
    expect(html).toContain('data-active="true"');
    expect(html).toContain("Explored 3 files");
    expect(html).toContain("4.2s");
    expect(html).toContain('aria-expanded="false"');
  });
});
