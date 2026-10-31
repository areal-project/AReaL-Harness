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
});
