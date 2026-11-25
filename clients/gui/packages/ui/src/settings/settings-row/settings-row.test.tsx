import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SettingsRow } from "./settings-row.js";

describe("SettingsRow contract (R-SETTINGSROW-004, R-SETTINGSROW-005)", () => {
  it("renders label, description, control, detail, and disabled accessibility state", () => {
    const html = renderToStaticMarkup(
      <SettingsRow
        label={<label htmlFor="timeout-input">超时时间</label>}
        description="影响默认任务等待上限"
        control={<input id="timeout-input" aria-describedby="timeout-help" disabled />}
        detail={<p id="timeout-help">保存失败时保留已确认值</p>}
        disabled
      />,
    );

    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('for="timeout-input"');
    expect(html).toContain("影响默认任务等待上限");
    expect(html).toContain('aria-describedby="timeout-help"');
    expect(html).toContain("保存失败时保留已确认值");
  });
});
