import { useSettingsOperation } from "./useSettingsOperation.js";
import { useDraftBlocker, useGuardedNavigation } from "./UnsavedChanges.js";
import { ModelEditor } from "./ModelEditor.js";
import { ChatGPTSubscription } from "./ChatGPTSubscription.js";
import { useState } from "react";
import { Pencil, Plus, Trash2, Unplug, ArrowUp, ArrowDown, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { DialogFooter } from "../components/ui/dialog.js";
import { EmptySettings, Feedback, SettingsDialog, useResource } from "./common.js";
import { ProviderTemplatePicker } from "./ProviderTemplatePicker.js";
import { ProviderApiKeySection, ProviderConnectionSection } from "./model-provider-section/ProviderCardSections.js";
import type { Action, Data } from "../services.js";

const CHATGPT = "chatgpt";
const credentialLabels: Record<string, string> = {
  notRequired: "",
  available: "凭据就绪",
  unavailable: "缺少凭据",
};
const credentialSourceLabels: Record<string, string> = {
  none: "无需认证",
  environment: "环境变量凭据",
  stored: "已保存凭据",
};

export function ModelSettings({ project, thread, action }: { project?: Data; thread?: Data; action: Action }) {
  const navigate = useGuardedNavigation();
  const api = (operation: string, values: Data = {}) => action("providers", { operation, ...values });
  const state = useResource(() => api("list"), "application");
  const [accountModels, setAccountModels] = useState<Data[]>([]);
  const [accountLabel, setAccountLabel] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [picker, setPicker] = useState(false);
  const [draft, setDraft] = useState<Data | null>(null);
  const [key, setKey] = useState<string | undefined>();
  const [keyVisible, setKeyVisible] = useState(false);
  const { busy, error, message, setError, setMessage, run, execute } = useSettingsOperation();
  const [remove, setRemove] = useState<Data | null>(null);
  const [modelDraft, setModelDraft] = useState<{ model: Data; index: number } | null>(null);
  const [discovered, setDiscovered] = useState<string[] | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [probe, setProbe] = useState<Data>({});
  const items: Data[] = state.value?.data ?? [];
  const provider = draft ?? items.find(p => p.id === selected);
  const authentication = provider?.authentication ?? (provider?.apiKeyEnv ? "apiKey" : "none");
  const visibleModels = (provider?.models ?? []).map((model: Data, index: number) => ({ model, index })).filter(({ model }: { model: Data }) => `${model.displayName ?? ""} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase()));
  const configuration = thread && project?.configurations?.[thread.id];
  const edit = (patch: Data) => setDraft({ ...provider, ...patch, basedOnRevision: draft?.basedOnRevision ?? state.value?.revision });
  const select = (item: Data) => { setSelected(item.id); setPicker(false); setDraft(null); setKey(undefined); setKeyVisible(false); setModelQuery(""); setError(""); setMessage(""); };
  const choose = (id: string) => navigate(() => { setSelected(id); setPicker(false); setDraft(null); setKey(undefined); setKeyVisible(false); setModelQuery(""); setError(""); setMessage(""); });
  const save = async (candidate = provider, apiKey = key) => {
    if (!candidate) throw new Error("没有可保存的供应商");
    const result = await api("save", { expectedRevision: candidate.basedOnRevision ?? state.value?.revision, provider: candidate, authentication: candidate.authentication ?? (candidate.apiKeyEnv ? "apiKey" : "none"), ...(apiKey !== undefined ? { apiKey } : {}) });
    const saved = candidate.id ? result.data.find((p: Data) => p.id === candidate.id) : result.data.at(-1);
    select(saved); await state.refresh(); setProbe({});
    setMessage(result.warning ?? (result.pendingApply ? "模型配置已保存，运行中的项目需应用后生效。" : "模型配置已保存。"));
    return saved;
  };
  const baseline = items.find(item => item.id === selected);
  // 开关与输入框是草稿；状态只投影 Core 的已保存目录和凭据诊断。
  const savedStatus = (item?: Data) => item
    ? [item.enabled ? "已启用" : "未启用", credentialSourceLabels[state.value?.credentialSources?.[item.id]] ?? "凭据来源待刷新", credentialLabels[state.value?.credentialStates?.[item.id]] ?? "凭据状态待刷新", state.value?.pendingApply ? "待应用" : ""].filter(Boolean).join(" · ")
    : "未保存";
  const modelStatus = (model: Data) => {
    const saved = baseline?.models.find((item: Data) => item.id === model.id);
    return saved ? savedStatus({ ...baseline, enabled: baseline!.enabled && saved.enabled }) : "未保存";
  };
  const dirty = key !== undefined || (draft !== null && (!baseline || Object.keys(draft).some(field => field !== "basedOnRevision" && JSON.stringify(draft[field]) !== JSON.stringify(field === "authentication" ? baseline.apiKeyEnv ? "apiKey" : "none" : baseline[field]))));
  const discard = () => { setDraft(null); setKey(undefined); setKeyVisible(false); setError(""); };
  useDraftBlocker({
    label: "供应商",
    dirty,
    busy,
    discard,
    save: () => execute(async () => { await save(); }),
  });
  const saveThen = (task: (saved: Data) => Promise<void>) => run(async () => { const saved = draft || key !== undefined ? await save() : provider; await task(saved); });
  const setDefault = (model: { providerId: string; modelId: string } | null) => void run(async () => {
    const result = await api("default", { model, expectedRevision: state.value?.revision });
    await state.refresh();
    setMessage(result.pendingApply ? "模型配置已保存，运行中的项目需应用后生效。" : "模型配置已保存。");
  });
  const canChoose = configuration && !thread?.desktop?.archived && !thread?.turns?.some((t: Data) => t.status === "inProgress");
  const current = selected ?? (accountModels.length ? CHATGPT : items.find(item => item.enabled)?.id ?? items[0]?.id ?? null);
  const refreshCatalog = () => navigate(() => { discard(); void state.refresh(); });
  const matches = (name: string) => name.toLowerCase().includes(query.trim().toLowerCase());
  const catalog = [
    { id: CHATGPT, name: "ChatGPT", enabled: accountModels.length > 0, detail: accountLabel || "未登录" },
    ...items.map(item => ({ id: item.id as string, name: item.name as string, enabled: !!item.enabled, detail: savedStatus(item) })),
  ].filter(item => matches(item.name));
  const enabled = catalog.filter(item => item.enabled);
  const disabled = catalog.filter(item => !item.enabled);
  const isDefault = (providerId: string, modelId: string) => state.value?.defaultModel?.providerId === providerId && state.value?.defaultModel?.modelId === modelId;
  const overrides = Object.entries(state.value?.effective?.sources ?? {}).filter(([field, source]) => field.startsWith("model.") && ["env", "cli"].includes((source as Data).kind));
  return <div className="model-settings">
    <Feedback error={state.error || error} message={message} />
    <div className="provider-settings" data-provider={current === CHATGPT && !picker ? CHATGPT : "custom"}>
      <aside className="provider-navigation" aria-label="供应商目录">
        <SettingsSearchInput placeholder="搜索供应商" aria-label="搜索供应商" value={query} onChange={e => setQuery(e.target.value)} onClear={() => setQuery("")} clearLabel="清除搜索" />
        <Button className="provider-catalog-add" variant="outline" disabled={busy} onClick={() => navigate(() => { discard(); setPicker(true); setSelected(null); setMessage(""); })}><Plus size={14} />添加供应商</Button>
        <div className="provider-catalog">
          {[["已启用", enabled], ["未启用", disabled]].map(([label, group]) => (group as typeof catalog).length ? <section key={label as string}>
            <p className="provider-catalog-label">{label as string}</p>
            {(group as typeof catalog).map(item => <button type="button" className="provider-catalog-row" key={item.id} aria-current={current === item.id} data-enabled={item.enabled} disabled={busy} onClick={() => choose(item.id)}>
              <span className="provider-catalog-dot" aria-hidden="true" />
              <span>{item.name}</span>
              <small>{item.detail}</small>
            </button>)}
          </section> : null)}
          {!catalog.length && <p className="settings-muted provider-list-empty">{state.loading ? "正在加载供应商…" : query ? "没有匹配的供应商" : "尚未添加供应商"}</p>}
        </div>
      </aside>
      <div className="provider-detail">
        <div className="provider-file-status">
          <p className="settings-muted" role="status" aria-label="配置应用状态">
            {state.value ? state.value.pendingApply ? "待应用：已保存的模型配置尚未应用到全部项目。" : state.value.projects?.some((item: Data) => item.connected) ? "已应用：已连接项目已加载当前模型配置。" : "未连接项目；连接时将读取已保存配置。" : "正在读取配置状态…"}
          </p>
          {overrides.length > 0 && <p className="settings-muted" role="status">命令行或环境配置覆盖了文件值；保存不会修改这些覆盖。{overrides.map(([field, source]) => `${field}：${(source as Data).name ?? (source as Data).flag}`).join(" ")}</p>}
          <div className="flex gap-2">
            <Button variant="ghost" size="icon" aria-label="刷新供应商" disabled={busy || state.loading} onClick={refreshCatalog}><RefreshCw size={16} /></Button>
            {state.value?.pendingApply && <Button disabled={busy || state.loading || dirty} onClick={() => void run(async () => { const result = await api("apply", { expectedRevision: state.value?.revision }); await state.refresh(); setMessage(result.warning ?? (result.pendingApply ? "配置在应用期间发生变化，请刷新后重新应用。" : "模型配置已应用。")); })}>应用模型配置</Button>}
          </div>
        </div>
        <div className="chatgpt-subscription-panel">
          <p className="settings-muted">ChatGPT 模型需要桌面账号授权。独立命令行暂不复用此登录，也不能写入配置文件。</p>
          <ChatGPTSubscription action={action} onModelsChange={setAccountModels} onAccountChange={setAccountLabel} />
          {accountModels.length > 0 && <div className="subscription-model-list provider-model-scroll" aria-label="ChatGPT 模型">
            {accountModels.filter(model => `${model.displayName ?? model.name ?? ""} ${model.id}`.toLowerCase().includes(modelQuery.toLowerCase())).map(model => <div key={model.id} className="provider-model-row flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1"><strong>{model.displayName || model.name || model.id}</strong><small>{model.id}</small></div>
              {isDefault("areal_openai", model.id) ? <span className="provider-model-default">默认</span> : <Button variant="ghost" size="sm" disabled={busy || dirty} onClick={() => setDefault({ providerId: "areal_openai", modelId: model.id })}>设为默认</Button>}
            </div>)}
          </div>}
          {accountModels.length > 0 && <SettingsSearchInput placeholder="搜索模型名称或 ID" aria-label="搜索模型名称或 ID" value={modelQuery} onChange={e => setModelQuery(e.target.value)} onClear={() => setModelQuery("")} clearLabel="清除模型搜索" containerClassName="provider-model-search" />}
        </div>
        {picker ? <ProviderTemplatePicker disabled={busy} onBack={() => choose(current ?? "")} onCreate={template => { if (template.subscription) { choose(CHATGPT); return; } setSelected(""); setDraft({ ...template, authentication: "apiKey", enabled: true, parameters: {}, basedOnRevision: state.value?.revision }); setKey(""); setKeyVisible(false); setPicker(false); setError(""); }} /> : current === CHATGPT ? null : provider ? <fieldset disabled={busy} className="provider-inline space-y-5">
          <div className="flex items-center gap-3">
            <Input aria-label="供应商名称" size="lg" value={provider.name} onChange={e => edit({ name: e.target.value })} className="flex-1 font-semibold" />
            <Switch disabled={busy} aria-label="启用供应商" checked={provider.enabled} onCheckedChange={enabled => edit({ enabled })} />
            {provider.id && <Button variant="ghost" size="icon" aria-label={`移除 ${provider.name}`} onClick={() => navigate(() => setRemove(provider))}><Trash2 size={16} /></Button>}
          </div>
          <p className="settings-muted" role="status" aria-label="供应商状态">{savedStatus(baseline)}</p>
          {dirty && <p className="settings-muted" role="status" aria-label="保存状态">有未保存修改；状态展示以已保存配置为准。</p>}
          <ProviderConnectionSection provider={{ config: { api: { baseUrl: provider.baseUrl, type: provider.protocol } } }} apiFormat={provider.protocol} baseUrlValue={provider.baseUrl} onApiFormatChange={protocol => edit({ protocol })} onBaseUrlChange={baseUrl => edit({ baseUrl })} onBaseUrlBlur={() => {}} />
          <div>
            <label className="mb-1 block text-ui-base text-foreground-subtle" htmlFor="provider-authentication">认证方式</label>
            <Select<"apiKey" | "none"> value={authentication} items={[{ value: "apiKey", label: "API Key" }, { value: "none", label: "无需认证" }]} onValueChange={value => { if (value !== null) { edit({ authentication: value }); setError(""); if (value === "none") setKey(undefined); } }}>
              <SelectTrigger id="provider-authentication" aria-label="认证方式" size="lg" className="w-full justify-between"><SelectValue /></SelectTrigger>
              <SelectContent align="start"><SelectItem value="apiKey">API Key</SelectItem><SelectItem value="none">无需认证</SelectItem></SelectContent>
            </Select>
          </div>
          {authentication === "apiKey" ? <>
            <ProviderApiKeySection apiKeyValue={key ?? ""} apiKeyVisible={keyVisible} onApiKeyChange={value => { setKey(value); edit({}); }} onToggleApiKeyVisibility={() => setKeyVisible(!keyVisible)} onApiKeyBlur={() => {}} />
            {provider.apiKeyEnv && <p className="settings-muted">凭据环境变量：{provider.apiKeyEnv}</p>}
            {state.value?.credentialSources?.[baseline?.id] === "environment" && <p className="settings-muted">凭据来自应用启动时的环境。终端中新设置的变量不会自动更新运行中的后台。</p>}
            {state.value?.credentialSources?.[baseline?.id] === "stored" && key === undefined && <p className="settings-muted">API Key 已安全保存。留空保持不变；填写新值替换。</p>}
          </> : <p className="settings-muted">保存后不再为该供应商配置 API Key；已连接项目需应用配置后生效。</p>}
          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
              <span className="text-ui-base text-foreground-subtle">模型 · {provider.models.length}</span>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => void saveThen(async saved => { const result = await api("discover", { id: saved.id }); setDiscovered(result.models); setChecked([]); })}>获取模型</Button>
                <Button variant="secondary" onClick={() => setModelDraft({ model: { id: "", enabled: true, parameters: {} }, index: -1 })}><Plus size={14} />添加模型</Button>
              </div>
            </div>
            {provider.models.length > 0 && <SettingsSearchInput placeholder="搜索模型名称或 ID" aria-label="搜索模型名称或 ID" value={modelQuery} onChange={e => setModelQuery(e.target.value)} onClear={() => setModelQuery("")} clearLabel="清除模型搜索" containerClassName="provider-model-search" />}
            {provider.models.length ? <div className="provider-model-scroll overflow-hidden rounded-lg border border-input-border bg-input">
              {visibleModels.map(({ model, index }: { model: Data; index: number }) => <div key={`${model.id}:${index}`} className="provider-model-row flex items-center gap-2 px-3 py-2 border-b border-input-border last:border-b-0">
                <div className="min-w-0 flex-1 provider-model-label" title={`${model.displayName || model.id}${model.displayName ? ` · ${model.id}` : ""}`}><strong>{model.displayName || model.id}</strong><small>{model.displayName ? model.id : ""}{model.parameters?.maxOutputTokens ? ` · 输出 ${model.parameters.maxOutputTokens.toLocaleString()}` : ""}{model.parameters?.reasoningEffort ? ` · 推理 ${model.parameters.reasoningEffort}` : ""}{model.parameters?.temperature != null ? ` · 温度 ${model.parameters.temperature}` : ""}</small><small role="status" aria-label={`模型 ${model.id} 状态`}>{modelStatus(model)}</small></div>
                {probe[model.id] && <small>{probe[model.id]}</small>}
                {provider.id && (isDefault(provider.id, model.id) ? <span className="provider-model-default">默认</span> : <Button size="sm" variant="ghost" disabled={!provider.enabled || !model.enabled || dirty || busy} onClick={() => setDefault({ providerId: provider.id, modelId: model.id })}>设为默认</Button>)}
                <Button size="icon" variant="ghost" aria-label={`测试模型 ${model.id}`} disabled={!provider.enabled || !model.enabled} onClick={() => void saveThen(async saved => { await api("probe", { id: saved.id, model: model.id }); setProbe(p => ({ ...p, [model.id]: "连接成功" })); setMessage(`模型 ${model.id} 连接成功`); })}><Unplug size={14} /></Button>
                <Button size="icon" variant="ghost" aria-label={`编辑模型 ${model.id}`} onClick={() => setModelDraft({ model, index })}><Pencil size={14} /></Button>
                <Button size="icon" variant="ghost" aria-label={`上移模型 ${model.id}`} disabled={index === 0} onClick={() => { const models = [...provider.models]; [models[index - 1], models[index]] = [models[index], models[index - 1]]; edit({ models }); }}><ArrowUp size={14} /></Button>
                <Button size="icon" variant="ghost" aria-label={`下移模型 ${model.id}`} disabled={index === provider.models.length - 1} onClick={() => { const models = [...provider.models]; [models[index + 1], models[index]] = [models[index], models[index + 1]]; edit({ models }); }}><ArrowDown size={14} /></Button>
                <Button size="icon" variant="ghost" aria-label={`删除模型 ${model.id}`} onClick={() => edit({ models: provider.models.filter((_: Data, i: number) => i !== index) })}><Trash2 size={14} /></Button>
                <Switch disabled={busy} size="sm" aria-label={`启用模型 ${model.id}`} checked={model.enabled} onCheckedChange={enabled => edit({ models: provider.models.map((m: Data, i: number) => i === index ? { ...m, enabled } : m) })} />
                {canChoose && <Button variant="ghost" disabled={!provider.enabled || !model.enabled || state.value?.credentialStates?.[provider.id] === "unavailable" || state.value?.pendingApply || dirty} aria-label={`使用模型 ${model.id}`} onClick={() => void saveThen(async saved => { await action("configure", { projectId: project!.id, threadId: thread!.id, expectedRevision: configuration.revision, model: { providerId: saved.id, modelId: model.id } }); setMessage("当前会话模型已更新"); })}>使用</Button>}
              </div>)}
              {!visibleModels.length && <p className="settings-muted p-3">没有匹配的模型</p>}
            </div> : <div className="mt-1 flex h-12 items-center rounded-lg border border-dashed border-border px-4 text-ui-base text-foreground-subtle">暂无模型，点击添加模型或从服务获取。</div>}
          </div>
          <details><summary className="settings-muted">高级参数</summary><div className="settings-field-pair mt-3">
            <label>默认温度<Input type="number" min={0} max={2} step={0.1} value={provider.parameters.temperature ?? ""} onChange={e => edit({ parameters: { ...provider.parameters, temperature: e.target.value === "" ? null : Number(e.target.value) } })} /></label>
            <label>最大输出 Token<Input type="number" min={1} step={1} value={provider.parameters.maxOutputTokens ?? ""} onChange={e => edit({ parameters: { ...provider.parameters, maxOutputTokens: e.target.value === "" ? null : Number(e.target.value) } })} /></label>
          </div></details>
          <div className="flex justify-end gap-2"><Button variant="outline" disabled={!dirty} onClick={() => provider.id ? navigate(discard) : choose(items[0]?.id ?? CHATGPT)}>取消修改</Button><Button disabled={!dirty} onClick={() => void run(async () => { await save(); })}>{busy ? "保存中…" : "保存供应商"}</Button></div>
        </fieldset> : <EmptySettings>{state.loading ? "正在加载供应商…" : "选择左侧供应商，或添加一个新的供应商。"}</EmptySettings>}
      </div>
    </div>
    {modelDraft && provider && <ModelEditor model={modelDraft.model} editing={modelDraft.index >= 0} ids={provider.models.filter((_: Data, i: number) => i !== modelDraft.index).map((m: Data) => m.id)} onClose={() => setModelDraft(null)} onSave={model => { const models = [...provider.models]; if (modelDraft.index < 0) models.push(model); else models[modelDraft.index] = model; edit({ models }); setModelDraft(null); }} />}

    {discovered && provider && <SettingsDialog title="选择模型" description="从服务返回的模型列表中选择添加。" onClose={() => setDiscovered(null)}><div className="max-h-80 overflow-auto">{discovered.map(id => <label key={id} className="flex gap-3 p-2"><input type="checkbox" checked={checked.includes(id)} onChange={e => setChecked(e.target.checked ? [...checked, id] : checked.filter(v => v !== id))} />{id}</label>)}</div><Button onClick={() => { edit({ models: [...provider.models, ...checked.filter(id => !provider.models.some((m: Data) => m.id === id)).map(id => ({ id, enabled: true }))] }); setDiscovered(null); }}>添加所选模型</Button></SettingsDialog>}
    {remove && <SettingsDialog className="settings-confirm-dialog" title="移除供应商？" description={`移除 ${remove.name} 后，引用该供应商的任务需要重新选择模型。历史消息保留。`} onClose={() => setRemove(null)} busy={busy}><Feedback error={error} /><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRemove(null)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void run(async () => { await api("remove", { id: remove.id, expectedRevision: state.value?.revision }); setRemove(null); setDraft(null); setKey(undefined); setSelected(items.find(item => item.id !== remove.id)?.id ?? (accountModels.length ? CHATGPT : null)); await state.refresh(); })}>{busy ? "移除中…" : "移除"}</Button></DialogFooter></SettingsDialog>}
  </div>;
}
