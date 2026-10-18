import { useGuardedNavigation } from "./UnsavedChanges.js";
import { useState } from "react";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { McpSettings, SkillsSettings } from "./ResourceSettings.js";
import type { ScopedProps } from "./ScopedSkillsSettings.js";

/** One settings destination, with scope shared across both resource types. */
export function PluginsSettings({
  initialTab = "mcp",
  ...props
}: ScopedProps & { initialTab?: string }) {
  const navigate = useGuardedNavigation();
  const [tab, setTab] = useState(initialTab);
  const [scope, setScope] = useState("user");
  return (
    <div className="plugin-settings">
      <div className="flex items-center justify-between gap-4">
        <p className="plugin-subtitle text-foreground-subtle text-ui-sm">
          管理技能（Skills）与模型上下文协议（MCP）服务器
        </p>
        <SettingsSegmentedTabs
          ariaLabel="插件类型"
          activateOnFocus={false}
          items={[
            { label: "MCP", value: "mcp" },
            { label: "Skills", value: "skills" },
          ]}
          value={tab}
          onValueChange={(value) => navigate(() => setTab(value))}
        />
      </div>
      {tab === "mcp" ? (
        <McpSettings {...props} scope={scope} onScopeChange={setScope} />
      ) : (
        <SkillsSettings {...props} scope={scope} onScopeChange={setScope} />
      )}
    </div>
  );
}
