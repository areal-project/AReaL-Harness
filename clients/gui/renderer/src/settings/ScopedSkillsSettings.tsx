import { useState } from "react";
import { BookOpen, Plug, ChevronDown, Folder, Monitor } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "../components/ui/dropdown-menu.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { SettingsBadge } from "./SettingsPageParts.js";
import {
  Feedback,
  SettingsDialog,
  SettingsToolbar,
  useResource,
} from "./common.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import type { Action, Data } from "../services.js";
export type ScopedProps = {
  project?: Data;
  thread?: Data;
  action: Action;
  scope?: string;
  onScopeChange?: (scope: string) => void;
};
export function ResourceScope({
  value,
  onChange,
  project,
  task = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  project?: Data;
  task?: boolean;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="resource-scope"
            aria-label="资源范围"
            disabled={disabled}
          >
            {value === "user" ? <Monitor size={16} /> : <Folder size={16} />}
            <span>{value === "user" ? "用户" : value === "task" ? "当前任务" : "当前项目"}</span>
            <ChevronDown size={14} />
          </Button>
        }
      />
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value="user">用户</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="project" disabled={!project}>
            当前项目
          </DropdownMenuRadioItem>
          {task && <DropdownMenuRadioItem value="task">当前任务</DropdownMenuRadioItem>}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export function CatalogEmpty({
  kind,
  query,
  scope,
  onAdd,
}: {
  kind: string;
  query: string;
  scope: string;
  onAdd?: () => void;
}) {
  return (
    <div className="resource-empty">
      {kind.includes("MCP") ? (
        <Plug size={26} aria-hidden="true" />
      ) : (
        <BookOpen size={26} aria-hidden="true" />
      )}
      <strong>
        {query
          ? `没有匹配的${kind}`
          : `暂无${scope === "user" ? "用户" : "项目"}${kind}`}
      </strong>
      <p>
        {query
          ? "试试其他名称或关键词。"
          : scope === "user"
            ? `在这里添加的${kind}可供各项目复用。`
            : `在这里管理仅用于当前项目的${kind}。`}
      </p>
      {!query && onAdd && (
        <Button variant="outline" onClick={onAdd}>
          添加{kind}
        </Button>
      )}
    </div>
  );
}
export function ScopedSkillsSettings({
  project,
  action,
  scope: controlledScope,
  onScopeChange,
}: ScopedProps) {
  const [localScope, setLocalScope] = useState("user"),
    [query, setQuery] = useState(""),
    [draft, setDraft] = useState<Data | null>(null),
    [selected, setSelected] = useState<Data | null>(null),
    [content, setContent] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const scope = controlledScope ?? localScope;
  const setScope = (value: string) => {
    setLocalScope(value);
    onScopeChange?.(value);
  };
  const api = (operation: string, values: Data = {}) =>
    action("resources", {
      operation,
      scope,
      projectId: project?.id,
      ...values,
    });
  const state = useResource(() => api("skills"), `${scope}:${project?.id}`);
  const items = (state.value?.data ?? []).filter((s: Data) =>
    `${s.name} ${s.id} ${s.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
      await state.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    setError("");
    setDraft({ id: "", name: "", description: "", content: "" });
  };
  return (
    <div className="resource-settings scoped-catalog">
      <div className="resource-catalog-bar">
        <ResourceScope
          value={scope}
          project={project}
          disabled={busy}
          onChange={(v) => {
            setScope(v);
            setQuery("");
            setError("");
            setMessage("");
          }}
        />
        <strong>
          技能{" "}
          <small>
            {state.loading ? "…" : (state.value?.data?.length ?? 0)}
          </small>
        </strong>
        <SettingsSearchInput
          aria-label="搜索技能"
          placeholder="搜索技能…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          clearLabel="清除搜索"
        />
      </div>
      <SettingsToolbar
        description={
          scope === "user"
            ? "供所有项目使用；同名技能优先使用项目配置。"
            : "仅用于当前项目；保存后在新任务中生效。"
        }
        loading={state.loading}
        disabled={busy || state.loading}
        onRefresh={() => void state.refresh()}
        onAdd={add}
        addLabel="新建技能"
      />
      <Feedback error={state.error || error} message={message} />
      {state.value?.customDeployment && (
        <Feedback message="当前使用自定义部署，任务技能仍由部署文件指定。" />
      )}
      <div className="settings-resource-list">
        {!state.loading &&
          items.map((item: Data) => (
            <article className="skill-resource-row" key={item.id}>
              <button
                className="resource-card"
                aria-label={`查看技能 ${item.id}`}
                disabled={busy || !!item.error}
                onClick={() =>
                  void run(async () => {
                    const result = await api("skillRead", { id: item.id });
                    setContent(
                      result.content +
                        (result.truncated
                          ? "\n\n（内容过长，仅预览前 256 KiB）"
                          : ""),
                    );
                    setSelected(item);
                  })
                }
              >
                <BookOpen size={20} />
                <span>
                  <strong>{item.name}</strong>
                  <small title={item.description || item.error}>
                    {item.error || item.description || "查看技能内容"}
                  </small>
                </span>
              </button>
              {item.overridden && <SettingsBadge>项目已覆盖</SettingsBadge>}
              <Switch
                aria-label={`${item.enabled ? "停用" : "启用"}技能 ${item.id}`}
                checked={!!item.enabled}
                disabled={busy || !!item.error}
                onCheckedChange={() =>
                  void run(async () => {
                    await api("skillToggle", {
                      id: item.id,
                      enabled: !item.enabled,
                      expectedRevision: state.value?.revision,
                    });
                    setMessage("已保存，将在新任务中生效。");
                  })
                }
              />
            </article>
          ))}
      </div>
      {!state.loading && !items.length && !state.error && (
        <CatalogEmpty kind="技能" scope={scope} query={query} onAdd={add} />
      )}
      {selected && (
        <SettingsDialog
          title={selected.name}
          description={selected.description || "技能内容预览"}
          onClose={() => setSelected(null)}
        >
          <div className="skill-preview">
            <MessageResponse>{content}</MessageResponse>
          </div>
        </SettingsDialog>
      )}
      {draft && (
        <SettingsDialog
          title="新建技能"
          description={
            scope === "user"
              ? "保存为用户技能，所有项目均可使用。"
              : "保存为项目技能，仅用于当前项目。"
          }
          busy={busy}
          onClose={() => setDraft(null)}
        >
          <form
            className="settings-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api("skillSave", {
                  ...draft,
                  expectedRevision: state.value?.revision,
                });
                setDraft(null);
                setMessage("技能已保存，将在新任务中生效。");
              });
            }}
          >
            <fieldset disabled={busy}>
              <div className="resource-form-grid">
                <label>
                  技能 ID
                  <Input
                    required
                    value={draft.id}
                    onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  />
                </label>
                <label>
                  显示名称
                  <Input
                    required
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                  />
                </label>
              </div>
              <label>
                描述
                <Input
                  required
                  value={draft.description}
                  onChange={(e) =>
                    setDraft({ ...draft, description: e.target.value })
                  }
                />
              </label>
              <label>
                技能指令
                <textarea
                  required
                  rows={8}
                  value={draft.content}
                  onChange={(e) =>
                    setDraft({ ...draft, content: e.target.value })
                  }
                />
              </label>
            </fieldset>
            <Feedback error={error} />
            <div className="settings-form-actions">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setDraft(null)}
              >
                取消
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "保存中…" : "保存技能"}
              </Button>
            </div>
          </form>
        </SettingsDialog>
      )}
    </div>
  );
}
