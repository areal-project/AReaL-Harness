import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SettingsGroupCard } from "./settings-group-card.js";

// R-SETTINGSGROUPCARD-005 / R-SETTINGSGROUPCARD-006:
// 卡片不新增角色或键盘焦点，通过 density/layout 表达密度与内容排布而不推断子控件状态。
describe("SettingsGroupCard contract (R-SETTINGSGROUPCARD-005, R-SETTINGSGROUPCARD-006)", () => {
  it("renders without inventing ARIA role or tabindex and reflects density and layout", () => {
    const html = renderToStaticMarkup(
      createElement(SettingsGroupCard, {
        density: "compact",
        layout: "grid",
        children: createElement("button", { type: "button", disabled: true }, "Action"),
      }),
    );
    expect(html).not.toContain('role="');
    expect(html).not.toContain('tabindex="');
    expect(html).toContain('data-density="compact"');
    expect(html).toContain('data-layout="grid"');
    expect(html).toContain("disabled");
  });
});
