import { useState } from "react";
import { Input } from "../components/ui/input.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import type { Data } from "../services.js";

/** ZCode 的表单/JSON 交互，字段严格映射到 Core ServerConfig。 */
export function McpConfigEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [mode, setMode] = useState<"form" | "json">("form");
  let config: Data | null = null;
  try {
    const parsed = JSON.parse(value);
    if (parsed?.transport && typeof parsed.transport === "object")
      config = parsed;
  } catch {}
  const update = (patch: Data) =>
    onChange(JSON.stringify({ ...config, ...patch }, null, 2));
  const transport = config?.transport ?? {};
  const updateTransport = (patch: Data) =>
    update({ transport: { ...transport, ...patch } });
  return (
    <>
      <SettingsSegmentedTabs
        items={[
          { value: "form", label: "表单" },
          { value: "json", label: "JSON" },
        ]}
        value={mode}
        onValueChange={setMode}
      />
      {mode === "json" || !config ? (
        <label>
          MCP 配置 JSON
          <textarea
            rows={12}
            spellCheck={false}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {!config && <small>请先修正 JSON，再切换到表单。</small>}
        </label>
      ) : (
        <>
          <label>
            类型
            <select
              aria-label="类型"
              value={transport.type}
              onChange={(e) =>
                update({
                  transport:
                    e.target.value === "stdio"
                      ? { type: "stdio", command: "", args: [] }
                      : { type: "streamableHttp", url: "" },
                })
              }
            >
              <option value="stdio">stdio（本地命令）</option>
              <option value="streamableHttp">HTTP（Streamable HTTP）</option>
            </select>
          </label>
          {transport.type === "stdio" ? (
            <>
              <label>
                命令
                <Input
                  required
                  value={transport.command ?? ""}
                  onChange={(e) => updateTransport({ command: e.target.value })}
                  placeholder="npx"
                />
              </label>
              <label>
                参数（每行一个）
                <textarea
                  rows={2}
                  value={(transport.args ?? []).join("\n")}
                  onChange={(e) =>
                    updateTransport({
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
                服务器 URL
                <Input
                  required
                  type="url"
                  value={transport.url ?? ""}
                  onChange={(e) => updateTransport({ url: e.target.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <label>
                认证环境变量（可选）
                <Input
                  value={transport.bearerTokenEnv ?? ""}
                  onChange={(e) =>
                    updateTransport({ bearerTokenEnv: e.target.value || null })
                  }
                  placeholder="MY_SERVICE_TOKEN"
                />
              </label>
            </>
          )}
          <details>
            <summary>高级设置</summary>
            <div className="settings-form mt-3">
              {transport.type === "stdio" && <>
              <label>
                工作目录（可选）
                <Input
                  value={transport.cwd ?? ""}
                  onChange={(e) =>
                    updateTransport({ cwd: e.target.value || null })
                  }
                />
              </label>
              <label>
                继承环境变量（每行一个名称）
                <textarea
                  rows={2}
                  value={(transport.envVars ?? []).join("\n")}
                  onChange={(e) =>
                    updateTransport({
                      envVars: e.target.value ? e.target.value.split("\n") : [],
                    })
                  }
                  placeholder="MY_SERVICE_TOKEN"
                />
                <small>填写启动环境中的变量名称，不在此处保存密钥。</small>
              </label>
              </>}
          <label>
            启动超时（毫秒）
            <Input
              type="number"
              min={1}
              placeholder="30000"
              value={config.startupTimeoutMs ?? ""}
              onChange={(e) =>
                update({
                  startupTimeoutMs: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
            />
          </label>
          <label>
            调用超时（毫秒）
            <Input
              type="number"
              min={1}
              placeholder="120000"
              value={config.callTimeoutMs ?? ""}
              onChange={(e) =>
                update({
                  callTimeoutMs: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
            />
          </label>
            </div>
          </details>
        </>
      )}
    </>
  );
}
