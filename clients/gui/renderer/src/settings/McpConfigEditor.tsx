import { Textarea } from "@areal/ui";
import { useI18n } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useState } from "react";
import { Input } from "../components/ui/input.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import type { Data } from "../services.js";

/** 表单与 JSON 两种写法，字段与插件 `.mcp.json` 里 mcpServers 的单个服务一致。 */
export function McpConfigEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<"form" | "json">("form");
  let config: Data | null = null;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
  } catch {}
  const update = (patch: Data) => {
    const next: Data = { ...config, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    onChange(JSON.stringify(next, null, 2));
  };
  const http = typeof config?.url === "string";
  return (
    <>
      <SettingsSegmentedTabs
        items={[
          { value: "form", label: t("settings.mcpConfigEditor.form") },
          { value: "json", label: "JSON" },
        ]}
        value={mode}
        onValueChange={setMode}
      />
      {mode === "json" || !config ? (
        <label>
          {t("settings.mcpConfigEditor.mcpConfigurationJSON")}
          <Textarea
            unstyled
            data-slot={undefined}
            rows={12}
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {!config && <small>{t("settings.mcpConfigEditor.fixTheJSONBeforeSwitchingToThe")}</small>}
        </label>
      ) : (
        <>
          <div className="settings-choice-field">
            {t("settings.mcpConfigEditor.type")}
            <SettingsSelect
              aria-label={t("settings.mcpConfigEditor.type")}
              value={http ? "streamableHttp" : "stdio"}
              onValueChange={(selectedValue) =>
                onChange(
                  JSON.stringify(
                    selectedValue === "stdio" ? { command: "", args: [] } : { url: "" },
                    null,
                    2,
                  ),
                )
              }
            >
              <option value="stdio">{t("settings.mcpConfigEditor.stdioLocalCommand")}</option>
              <option value="streamableHttp">{t("settings.mcpConfigEditor.streamableHttp")}</option>
            </SettingsSelect>
          </div>
          {!http ? (
            <>
              <label>
                {t("settings.mcpConfigEditor.command")}
                <Input
                  required
                  value={config.command ?? ""}
                  onChange={(e) => update({ command: e.target.value })}
                  placeholder="npx"
                />
              </label>
              <label>
                {t("settings.mcpConfigEditor.argumentsOnePerLine")}
                <Textarea
                  unstyled
                  data-slot={undefined}
                  rows={2}
                  value={(config.args ?? []).join("\n")}
                  onChange={(e) =>
                    update({
                      args: e.target.value ? e.target.value.split("\n") : [],
                    })
                  }
                  placeholder={"-y\n@modelcontextprotocol/server-memory"}
                />
              </label>
            </>
          ) : (
            <>
              <label>
                {t("settings.mcpConfigEditor.serverURL")}
                <Input
                  required
                  type="url"
                  value={config.url ?? ""}
                  onChange={(e) => update({ url: e.target.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <label>
                {t("settings.mcpConfigEditor.authenticationEnvironmentVariableOptional")}
                <Input
                  value={config.bearer_token_env_var ?? ""}
                  onChange={(e) => update({ bearer_token_env_var: e.target.value || undefined })}
                  placeholder="MY_SERVICE_TOKEN"
                />
              </label>
            </>
          )}
          <SettingsDisclosure title={<> {t("settings.mcpConfigEditor.advancedSettings")}</>}>
            <div className="settings-form mt-3">
              {!http && (
                <>
                  <label>
                    {t("settings.mcpConfigEditor.workingDirectoryOptional")}
                    <Input
                      value={config.cwd ?? ""}
                      onChange={(e) => update({ cwd: e.target.value || undefined })}
                    />
                  </label>
                  <label>
                    {t("settings.mcpConfigEditor.inheritedEnvironmentVariablesOneNamePerLine")}
                    <Textarea
                      unstyled
                      data-slot={undefined}
                      rows={2}
                      value={(config.env_vars ?? []).join("\n")}
                      onChange={(e) =>
                        update({
                          env_vars: e.target.value ? e.target.value.split("\n") : undefined,
                        })
                      }
                      placeholder="MY_SERVICE_TOKEN"
                    />
                    <small>
                      {t("settings.mcpConfigEditor.enterVariableNamesFromTheStartupEnvironment")}
                    </small>
                  </label>
                </>
              )}
              <label>
                {t("settings.mcpConfigEditor.startupTimeoutMs")}
                <Input
                  type="number"
                  min={1}
                  placeholder="30000"
                  value={config.startup_timeout_ms ?? ""}
                  onChange={(e) =>
                    update({
                      startup_timeout_ms: e.target.value ? Number(e.target.value) : undefined,
                    })
                  }
                />
              </label>
              <label>
                {t("settings.mcpConfigEditor.callTimeoutMs")}
                <Input
                  type="number"
                  min={1}
                  placeholder="120000"
                  value={
                    config.tool_timeout_sec === undefined ? "" : config.tool_timeout_sec * 1000
                  }
                  onChange={(e) =>
                    update({
                      tool_timeout_sec: e.target.value ? Number(e.target.value) / 1000 : undefined,
                    })
                  }
                />
              </label>
            </div>
          </SettingsDisclosure>
        </>
      )}
    </>
  );
}
