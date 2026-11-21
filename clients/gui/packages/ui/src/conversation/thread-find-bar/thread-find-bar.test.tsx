import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ThreadFindBar } from "./thread-find-bar.js";

// R-THREADFINDBAR-002: 暴露 search 语义、匹配计数与无匹配禁用态。
describe("ThreadFindBar contract (R-THREADFINDBAR-002)", () => {
  it("renders match counter and disables navigation when no matches exist", () => {
    const matched = renderToStaticMarkup(
      createElement(ThreadFindBar, {
        value: "tokens",
        onChange: () => {},
        matchIndex: 1,
        matchCount: 5,
        onClose: () => {},
      }),
    );
    expect(matched).toContain('role="search"');
    expect(matched).toContain("2 / 5");

    const empty = renderToStaticMarkup(
      createElement(ThreadFindBar, {
        value: "none",
        onChange: () => {},
        matchCount: 0,
      }),
    );
    expect(empty).toContain("0 / 0");
    expect(empty).toContain("disabled");
  });
});
