import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { WorktreeWorkspace } from "./worktree-workspace.js";

describe("WorktreeWorkspace contract (R-WORKTREEWORKSPACE-002, R-WORKTREEWORKSPACE-003)", () => {
  it("renders bound directory, busy status, error, and labeled output log", () => {
    const html = renderToStaticMarkup(
      <WorktreeWorkspace
        heading="feat/ui"
        directory="/workspace/.worktrees/wt-1"
        actions={
          <button type="button" disabled>
            运行脚本
          </button>
        }
        busy
        busyLabel="正在执行…"
        error="退出码 1"
        output="stdout line 1"
        outputLabel="脚本输出日志"
      />,
    );

    expect(html).toContain("feat/ui");
    expect(html).toContain("/workspace/.worktrees/wt-1");
    expect(html).toContain('role="status"');
    expect(html).toContain("正在执行…");
    expect(html).toContain("退出码 1");
    expect(html).toContain('aria-label="脚本输出日志"');
    expect(html).toContain("stdout line 1");
  });
});
