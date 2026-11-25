import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { WorktreeSettings } from "./worktree-settings.js";

describe("WorktreeSettings contract (R-WORKTREESETTINGS-016, WT-ACTION-01)", () => {
  it("renders breadcrumb, project/environment navigation, and isolated script/action containers", () => {
    const html = renderToStaticMarkup(
      <WorktreeSettings view="environment">
        <WorktreeSettings.Breadcrumb
          label="位置"
          items={[
            { id: "root", label: "Environments", onSelect: () => {} },
            { id: "env", label: "Default" },
          ]}
        />
        <WorktreeSettings.Project
          name="AReaL-Harness"
          root="/repo"
          openLabel="打开项目"
          addLabel="新建环境"
          onOpen={() => {}}
          onAdd={() => {}}
        />
        <WorktreeSettings.Environment name="Default" label="编辑 Default" onOpen={() => {}} />
      </WorktreeSettings>,
    );

    expect(html).toContain('data-view="environment"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("AReaL-Harness");
    expect(html).toContain('aria-label="编辑 Default"');
  });
});
