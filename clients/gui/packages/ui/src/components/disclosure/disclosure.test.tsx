import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Disclosure } from "./disclosure.js";

describe("controlled reading disclosures", () => {
  it("renders the supplied open choice while preserving the default collapsed behavior", () => {
    const render = (open?: boolean) =>
      renderToStaticMarkup(
        createElement(Disclosure, {
          label: "Details",
          open,
          children: "Retained detail",
        }),
      );
    expect(render(true)).toContain("Retained detail");
    expect(render(true)).toContain('aria-expanded="true"');
    expect(render(false)).not.toContain("Retained detail");
    expect(render()).not.toContain("Retained detail");
  });
});
