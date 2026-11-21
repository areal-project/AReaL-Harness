import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { WorktreePicker } from "./worktree-picker.js";

describe("WorktreePicker contract (R-WORKTREEPICKER-004, R-WORKTREEPICKER-008, R-WORKTREEPICKER-009, R-WORKTREEPICKER-010, R-WORKTREEPICKER-012, R-WORKTREEPICKER-015)", () => {
  it("renders accessible listbox options with aria-selected, roving tabIndex, disabled state, and subpage navigation", () => {
    const html = renderToStaticMarkup(
      <WorktreePicker>
        <WorktreePicker.Page
          label="分支"
          backLabel="返回配置菜单"
          onBack={() => {}}
          note="仅影响新 Worktree"
        >
          <WorktreePicker.Options
            label="分支列表"
            heading="Local branches"
            items={[
              { id: "main", label: "main", selected: true },
              { id: "feat", label: "feat/ui", selected: false },
            ]}
            onSelect={() => {}}
          />
        </WorktreePicker.Page>
      </WorktreePicker>,
    );

    expect(html).toContain('aria-label="返回配置菜单"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('tabindex="-1"');

    const emptyDisabled = renderToStaticMarkup(
      <WorktreePicker.Options
        label="分支列表"
        disabled
        items={[]}
        empty="读取失败，请重试"
        onSelect={() => {}}
      />,
    );
    expect(emptyDisabled).toContain("读取失败，请重试");
  });
});
