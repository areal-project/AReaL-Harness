import { useSettingsOperation } from "./useSettingsOperation.js";
import { useDraftBlocker, useGuardedNavigation } from "./UnsavedChanges.js";
import { useRef, useState } from "react";
import {
  BookOpen,
  Plug,
  Settings,
  Monitor,
} from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import {
  SettingsBadge,
  SettingsGroupCard,
  SettingsRow,
  SettingsSection,
} from "./SettingsPageParts.js";
import {
  EmptySettings,
  Feedback,
  SettingsDialog,
  SettingsToolbar,
  useResource,
  type SettingsProps,
} from "./common.js";
import { McpConfigEditor } from "./McpConfigEditor.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { ResourceScope, CatalogEmpty, type ScopedProps } from "./ScopedSkillsSettings.js";
import type { Data } from "../services.js";
export function McpSettings({ project, action, scope: controlledScope, onScopeChange }: ScopedProps) {
  const [localScope, setLocalScope] = useState("user");
  const scope = controlledScope ?? localScope;
  const setScope = (value: string) => { setLocalScope(value); onScopeChange?.(value); };
  const api = (operation: string, values: Data = {}) =>
    action("resources", { projectId: project?.id, scope, operation, ...values });
  const state = useResource(() => api("mcp"), `${scope}:${project?.id}`);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Data | null>(null);
  const [config, setConfig] = useState("");
  const navigate = useGuardedNavigation();
  const baseline = useRef({ id: "", config: "" });
  const operation = useSettingsOperation();
  const { busy, error, message, setError, setMessage } = operation;
  const disabled =
    busy || state.loading || (scope === "project" && (!project?.state?.connected || project?.pending?.length > 0));
  const run = (task: () => Promise<void>) => operation.run(async () => { await task(); await state.refresh(); });
  const discard = () => { setDraft(null); setError(""); };
  const save = async () => {
    if (!draft || disabled) throw new Error("当前无法保存，请稍候重试。");
    if (!draft.id.trim()) throw new Error("服务 ID 不能为空。");
    let parsed: Data;
    try { parsed = JSON.parse(config); }
    catch { throw new Error("MCP 配置不是有效的 JSON。"); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !parsed.transport)
      throw new Error("请提供包含 transport 的 MCP 配置。");
    const transport = parsed.transport;
    if (transport.type === "stdio" && !transport.command?.trim()) throw new Error("命令不能为空。");
    if (transport.type === "streamableHttp") {
      try { if (!["http:", "https:"].includes(new URL(transport.url).protocol)) throw new Error(); }
      catch { throw new Error("服务器 URL 必须是有效的 HTTP(S) 地址。"); }
    }
    const result = await api("mcpSave", {
      id: draft.id.trim(), expectedRevision: scope === "user" ? state.value?.revision : draft.revision, config: parsed,
    });
    setDraft(null);
    await state.refresh();
    setMessage(result.warning || "配置已保存");
  };
  useDraftBlocker({
    label: "MCP 配置",
    dirty: !!draft && (draft.id !== baseline.current.id || config !== baseline.current.config),
    busy,
    discard,
    save: () => operation.execute(save),
  });
  const edit = (
    item: Data = {
      id: "",
      revision: 0,
      config: { transport: { type: "stdio", command: "", args: [] } },
    },
  ) => {
    baseline.current = { id: item.id, config: JSON.stringify(item.config, null, 2) };
    setDraft(item);
    setConfig(baseline.current.config);
    setError("");
  };
  const items = (state.loading ? [] : state.value?.data ?? []).filter((item: Data) =>
    [
      item.id,
      item.config?.transport?.command,
      item.config?.transport?.url,
      ...(item.tools ?? []).map((tool: Data) => tool.name),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="resource-settings">
      {!draft && (
        <>
          <div className="resource-catalog-bar">
            <ResourceScope value={scope} onChange={v=>{setScope(v);setQuery("");setError("");setMessage("");}} project={project} disabled={busy}/>
            <strong>
              MCP <small>{state.value?.data?.length ?? 0}</small>
            </strong>
            <SettingsSearchInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onClear={() => setQuery("")}
              clearLabel="清除搜索"
              placeholder="搜索 MCP 服务器…"
              aria-label="搜索 MCP 服务器"
            />
          </div>
          <SettingsToolbar
            description={scope === "user" ? "供所有项目复用；连接开关仅影响当前项目。" : "仅用于当前项目。"}
            loading={state.loading}
            disabled={disabled}
            onRefresh={() => void state.refresh()}
            onAdd={() => edit()}
            addLabel="新增 MCP"
          />
          <Feedback
            error={state.error || (!draft ? error : "")}
            message={message}
          />
          <div className="settings-resource-list">
            {items.map((item: Data) => (
              <article key={item.id}>
                <div className="resource-title">
                  <Plug size={20} />
                  <div>
                    <strong>{item.id}</strong>
                    {/* MCP 启动命令／URL 单行截断，长命令看不到后半段；补完整值的原生 title。 */}
                    <p
                      title={`${item.config.transport?.type ?? ""} ${
                        item.config.transport?.command ?? item.config.transport?.url ?? ""
                      }`.trim()}
                    >
                      {item.config.transport?.type} ·{" "}
                      {item.config.transport?.command ??
                        item.config.transport?.url ??
                        ""}
                    </p>
                  </div>
                  <SettingsBadge>
                    {(
                      {
                        notApplied: "未应用",
                        connected: "已连接",
                        disconnected: "未连接",
                        failed: "连接失败",
                        stale: "工具目录已过期",
                        connecting: "连接中",
                      } as Data
                    )[item.state] ?? item.state}
                  </SettingsBadge>
                  <Button
                    variant="ghost"
                    aria-label={`编辑 MCP ${item.id}`}
                    disabled={
                      disabled ||
                      !["disconnected", "failed", "notApplied"].includes(item.state)
                    }
                    onClick={() => edit(item)}
                  >
                    <Settings />
                  </Button>
                  <Switch
                    checked={
                      !["disconnected", "failed", "notApplied"].includes(item.state)
                    }
                    disabled={disabled || !project || item.state === "connecting"}
                    aria-label={
                      ["disconnected", "failed", "notApplied"].includes(item.state)
                        ? `连接 ${item.id}`
                        : `断开 ${item.id}`
                    }
                    onCheckedChange={() =>
                      void run(async () => {
                        const connecting = ["disconnected", "failed", "notApplied"].includes(
                          item.state,
                        );
                        await api(connecting ? "mcpConnect" : "mcpDisconnect", {
                          id: item.id,
                          expectedRevision: item.revision,
                        });
                        setMessage(`${item.id} 连接状态已刷新`);
                      })
                    }
                  />
                </div>
                {item.error && <Feedback error={item.error} />}
                <details className="mt-3">
                  <summary>工具 · {item.tools?.length ?? 0}</summary>
                  {item.tools?.length ? (
                    item.tools.map((tool: Data) => (
                      <div className="settings-tool" key={tool.name}>
                        <strong>{tool.name}</strong>
                        <p>{tool.description}</p>
                      </div>
                    ))
                  ) : (
                    <p className="settings-muted">
                      尚无可用工具，连接成功后刷新查看。
                    </p>
                  )}
                </details>
              </article>
            ))}
          </div>
          {!state.loading && !items.length && (
            <CatalogEmpty kind="MCP 服务器" query={query} scope={scope} onAdd={()=>edit()}/>
          )}

        </>
      )}
      {draft && (
        <section className="resource-editor">
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => navigate(discard)}
          >
            ← 返回 MCP 服务器
          </Button>
          <h2>{draft.revision || draft.runtimeId ? "编辑 MCP 服务器" : "新增 MCP 服务器"}</h2>
          <p className="settings-muted">
            配置本地命令或 HTTP
            服务。保存后点击列表开关连接，查看服务器提供的工具。
          </p>
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void operation.run(save);
            }}
          >
            <fieldset disabled={disabled}>
              <label>
                服务 ID
                <Input
                  required
                  value={draft.id}
                  disabled={!!draft.revision || !!draft.runtimeId}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                />
              </label>
              <McpConfigEditor value={config} onChange={setConfig} />
            </fieldset>
            <Feedback error={error} />
            <div className="settings-form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => navigate(discard)}
              >
                取消
              </Button>
              <Button type="submit" disabled={disabled}>
                {busy ? "保存中…" : "保存 MCP 配置"}
              </Button>
            </div>
          </form>
        </section>
      )}
    </div>
  );
}
function SkillContent({
  project,
  thread,
  action,
  skill,
  resource,
  onResource,
}: SettingsProps & {
  skill: Data;
  resource: string;
  onResource: (path: string) => void;
}) {
  const read = (offset: number) =>
    action("manage", {
      projectId: project.id,
      threadId: thread!.id,
      operation: "skill",
      skill: { id: skill.id, revision: skill.revision },
      resource,
      offset,
      maxBytes: 8192,
    });
  const state = useResource(
    () => read(0),
    `${skill.id}:${skill.revision}:${resource}`,
  );
  const [extra, setExtra] = useState<Data[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const chunks = state.value ? [state.value, ...extra] : [];
  const last = chunks.at(-1);
  const bytes = chunks.flatMap((chunk) =>
    Array.from(atob(chunk.dataBase64 ?? ""), (char) => char.charCodeAt(0)),
  );
  return (
    <>
      <Feedback
        error={(state.error || error) ? `读取 ${resource} 失败：${state.error || error}` : undefined}
        message={state.loading ? "正在读取资源…" : undefined}
      />
      {state.value && (
        <>
          <p className="settings-muted">
            {resource} · {last?.sizeBytes} 字节
          </p>
          <SettingsSegmentedTabs
            items={[
              { value: "preview", label: "预览" },
              { value: "source", label: "源码" },
            ]}
            value={mode}
            onValueChange={setMode}
          />
          {mode === "preview" && /\.md$/i.test(resource) ? (
            <div className="skill-content">
              <MessageResponse
                fileLinks
                onOpenFileLink={(path) => {
                  const resolved = new URL(
                    path,
                    `https://skill.invalid/${resource}`,
                  ).pathname.slice(1);
                  onResource(decodeURIComponent(resolved));
                }}
              >
                {new TextDecoder()
                  .decode(new Uint8Array(bytes))
                  .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}
              </MessageResponse>
            </div>
          ) : (
            <pre className="skill-content">
              {new TextDecoder().decode(new Uint8Array(bytes))}
            </pre>
          )}
          {!last?.eof && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  const result = await read(last!.nextOffset);
                  setExtra((previous) => [...previous, result]);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              继续读取
            </Button>
          )}
        </>
      )}
    </>
  );
}
export function TaskSkillsSettings(props: SettingsProps) {
  const { project, thread, action } = props;
  const state = useResource(
    () =>
      thread
        ? action("manage", {
            projectId: project.id,
            threadId: thread.id,
            operation: "skills",
          })
        : Promise.resolve({ data: [] }),
    `${project.id}:${thread?.id}`,
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Data | null>(null);
  const [resource, setResource] = useState("SKILL.md");
  const [resourcePath, setResourcePath] = useState("SKILL.md");
  const items = (state.value?.data ?? []).filter((item: Data) =>
    [item.id, item.name, item.description]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="resource-settings">
      <div className="resource-catalog-bar">
        <span className="resource-scope">
          <Monitor size={16} /> 当前任务
        </span>
        <strong>
          技能 <small>{state.value?.data?.length ?? 0}</small>
        </strong>
        <SettingsSearchInput
          placeholder="搜索技能…"
          aria-label="搜索技能"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel="清除搜索"
        />
      </div>
      <SettingsToolbar
        description={`当前任务绑定 ${state.value?.data?.length ?? 0} 个技能；在会话配置中选择下一轮使用的预设允许技能。`}
        loading={state.loading}
        onRefresh={() => void state.refresh()}
      />
      <Feedback error={state.error} />
      <div className="settings-resource-list">
        {items.map((item: Data) => (
          <article
            className="skill-resource-row"
            key={`${item.id}:${item.revision}`}
          >
            <button
              className="resource-card"
              disabled={!item.available}
              aria-label={item.id}
              onClick={() => {
                setSelected(item);
                setResource("SKILL.md");
                setResourcePath("SKILL.md");
              }}
            >
              <BookOpen size={20} />
              <span>
                <strong>{item.name || item.id}</strong>
                <small title={item.description}>
                  {item.description || `版本 ${item.revision} · 查看技能内容`}
                </small>
              </span>
              <SettingsBadge>
                {!item.available
                  ? "不可用"
                  : state.value?.loaded?.[item.id]
                    ? "已读取"
                    : "可用"}
              </SettingsBadge>
            </button>
          </article>
        ))}
      </div>
      {!state.loading && !items.length && (
        <EmptySettings>
          {!thread
            ? "请先选择任务，以查看该任务权限范围内的技能。"
            : query
              ? "没有匹配的技能"
              : "当前任务没有可用技能。"}
        </EmptySettings>
      )}

      {selected && thread && (
        <SettingsDialog
          title={selected.name || selected.id}
          description={
            selected.description ||
            `版本 ${selected.revision} · 当前任务的技能资源`
          }
          onClose={() => {
            setSelected(null);
            void state.refresh();
          }}
        >
          <form
            className="skill-resource-path"
            onSubmit={(e) => {
              e.preventDefault();
              setResource(resourcePath.trim() || "SKILL.md");
            }}
          >
            <label>
              技能资源
              <Input
                aria-label="技能资源"
                value={resourcePath}
                onChange={(e) => setResourcePath(e.target.value)}
                placeholder="SKILL.md 或 references/guide.md"
              />
            </label>
            <Button type="submit" variant="outline">
              读取资源
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setResource("SKILL.md");
                setResourcePath("SKILL.md");
              }}
            >
              返回 SKILL.md
            </Button>
          </form>
          <SkillContent
            key={`${selected.id}:${selected.revision}:${resource}`}
            {...props}
            skill={selected}
            resource={resource}
            onResource={(path) => {
              setResource(path);
              setResourcePath(path);
            }}
          />
        </SettingsDialog>
      )}
    </div>
  );
}
export { SessionSettings } from "./SessionSettings.js";
export { ScopedSkillsSettings as SkillsSettings } from "./ScopedSkillsSettings.js";
