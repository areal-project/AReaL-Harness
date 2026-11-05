import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { MemoTaskItem } from "./task-list-item.js";

describe("conversation read capability", () => {
  const render = (readOnly: boolean, archive = true) =>
    renderToStaticMarkup(
      createElement(MemoTaskItem, {
        id: "thread",
        title: "Observed conversation",
        active: true,
        pinned: false,
        running: false,
        attention: false,
        archived: false,
        disabled: false,
        readOnly,
        onSelect() {},
        onRename() {},
        onPin() {},
        onArchive: archive ? () => {} : undefined,
      }),
    );
  it("allows organizing without offering an unavailable archive action", () => {
    const html = render(false, false);
    expect(html).toContain("task-row-actions");
    expect(html).toContain("置顶 Observed conversation");
    expect(html).not.toContain("归档");
  });
  it("retains navigation while omitting mutation controls for a read-only client", () => {
    const readonly = render(true);
    expect(readonly).toContain("Observed conversation");
    expect(readonly).toContain('data-thread-id="thread"');
    expect(readonly).not.toContain("task-row-actions");
    expect(readonly).not.toContain("归档");
    expect(render(false)).toContain("task-row-actions");
    expect(render(false)).toContain("归档");
  });
});
