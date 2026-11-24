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

// WT-IDENTITY-01: 侧栏以紧凑图标标明 Worktree，不常驻第二行 UUID 分支或完整路径。
describe("Worktree identity badge (WT-IDENTITY-01)", () => {
  it("keeps conversation title primary without printing raw directory path in sidebar row", () => {
    const html = renderToStaticMarkup(
      createElement(MemoTaskItem, {
        id: "wt-thread",
        title: "Worktree task",
        worktree: { branch: "feat/demo-uuid", directory: "/Users/example/worktrees/secret-dir" },
        worktreeLabel: "在 Worktree 工作",
        worktreeTitle: "Worktree · feat/demo-uuid",
        active: false,
        pinned: false,
        running: false,
        attention: false,
        archived: false,
        disabled: false,
        onSelect() {},
        onRename() {},
        onPin() {},
      }),
    );
    expect(html).toContain("Worktree task");
    expect(html).not.toContain("/Users/example/worktrees/secret-dir");
  });

  it("keeps the leading status slot mounted for pinned idle rows to prevent horizontal jump when running", () => {
    const html = renderToStaticMarkup(
      createElement(MemoTaskItem, {
        id: "pinned-thread",
        title: "Pinned chat",
        nested: false,
        active: false,
        pinned: true,
        running: false,
        attention: false,
        archived: false,
        disabled: false,
        onSelect() {},
        onRename() {},
        onPin() {},
      }),
    );
    expect(html).toContain("size-4 shrink-0");
  });
});
