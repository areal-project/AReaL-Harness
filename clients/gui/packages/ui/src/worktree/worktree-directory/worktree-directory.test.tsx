import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { WorktreeDirectory } from "./worktree-directory.js";

describe("WorktreeDirectory contract (R-WORKTREEDIRECTORY-007)", () => {
  it("renders project group, identifiable worktree item name, named delete action, and readable expanded details", () => {
    const html = renderToStaticMarkup(
      <WorktreeDirectory>
        <WorktreeDirectory.Group title="AReaL-Harness">
          <WorktreeDirectory.Item
            name="修复设置对齐"
            open
            onToggle={() => {}}
            onDelete={() => {}}
            labels={{ details: "查看详情", delete: "删除", deleting: "正在删除", result: "结果" }}
          >
            <div>
              <dt>路径</dt>
              <dd>
                <code>/workspace/.worktrees/wt-1</code>
              </dd>
            </div>
          </WorktreeDirectory.Item>
        </WorktreeDirectory.Group>
      </WorktreeDirectory>,
    );

    expect(html).toContain("AReaL-Harness");
    expect(html).toContain("修复设置对齐");
    expect(html).toContain('aria-label="查看详情 修复设置对齐"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="删除 修复设置对齐"');
    expect(html).toContain("/workspace/.worktrees/wt-1");
  });
});
