import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SettingsGroupCard } from "../settings-group-card/settings-group-card.js";
import { SettingsPage } from "./settings-page.js";

describe("SettingsPage contract (R-SETTINGSPAGE-008, R-SETTINGSPAGE-015, R-SETTINGSPAGE-016, R-BASE-009)", () => {
  it("provides the single scroll owner, accessible title heading, width variants, and production SettingsGroupCard context", () => {
    const html = renderToStaticMarkup(
      <SettingsPage title="通用" subtitle="偏好设置" width="wide">
        <SettingsGroupCard>
          <p>设置项内容</p>
        </SettingsGroupCard>
      </SettingsPage>,
    );

    expect(html).toContain('class="settings-workspace"');
    expect(html).toContain('data-width="wide"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("通用");
    expect(html).toContain("偏好设置");
    expect(html).toContain("settings-group-card");
  });
});
