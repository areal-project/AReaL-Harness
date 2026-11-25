import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ScheduledWorkspace } from "./scheduled-workspace.js";

describe("ScheduledWorkspace contract (R-SCHEDULEDWORKSPACE-001, R-SCHEDULEDWORKSPACE-005)", () => {
  it("distinguishes status groups, task row variants, and explicit status badges without holding service state", () => {
    const html = renderToStaticMarkup(
      <ScheduledWorkspace>
        <ScheduledWorkspace.Group label="已开启">
          <ScheduledWorkspace.Item title="每日汇总" description="每天 09:00" />
        </ScheduledWorkspace.Group>
        <ScheduledWorkspace.TaskRow
          icon={<span aria-hidden="true">*</span>}
          title="每日汇总"
          summary="每天 09:00"
          state="enabled"
          stateLabel="已开启"
          variant="card"
          actions={<button type="button">暂停</button>}
        />
        <ScheduledWorkspace.Status state="attention" label="需要关注" />
      </ScheduledWorkspace>,
    );

    expect(html).toContain('aria-label="已开启"');
    expect(html).toContain('data-variant="card"');
    expect(html).toContain('data-state="enabled"');
    expect(html).toContain('data-state="attention"');
    expect(html).toContain("需要关注");
  });
});
