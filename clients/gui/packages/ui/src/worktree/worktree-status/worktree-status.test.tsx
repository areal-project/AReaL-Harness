import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { WorktreeStatus } from "./worktree-status.js";

describe("WorktreeStatus contract (WT-PROGRESS-01, R-WORKTREESTATUS-007, WT-PROGRESS-02, R-WORKTREESTATUS-011)", () => {
  it("renders live preparation stages, named controls, and alert role on confirmed failure", () => {
    const runningHtml = renderToStaticMarkup(
      <WorktreeStatus
        state="running"
        label="正在创建 Worktree"
        regionLabel="Worktree 准备状态"
        running
        stages={[
          { id: "fetch", label: "获取上游", current: false },
          { id: "create", label: "创建目录", current: true },
        ]}
        details={<p>/tmp/wt-1</p>}
        controls={
          <>
            <button type="button">不使用 Worktree</button>
            <button type="button">取消</button>
          </>
        }
        showLabel="展开详情"
        hideLabel="收起详情"
      />,
    );

    expect(runningHtml).toContain('role="status"');
    expect(runningHtml).toContain("正在创建 Worktree");
    expect(runningHtml).toContain("创建目录");
    expect(runningHtml).toContain("展开详情");
    expect(runningHtml).toContain("不使用 Worktree");
    expect(runningHtml).toContain("取消");

    const failedHtml = renderToStaticMarkup(
      <WorktreeStatus
        state="failed"
        label="创建失败"
        regionLabel="Worktree 准备状态"
        running={false}
        message="目录冲突，保留原 Prompt"
        stages={[]}
        showLabel="展开详情"
        hideLabel="收起详情"
      />,
    );
    expect(failedHtml).toContain('role="alert"');
    expect(failedHtml).toContain("目录冲突，保留原 Prompt");
  });
});
