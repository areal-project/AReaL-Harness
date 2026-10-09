import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import { AgentAvatar, agentName, agentStatus, agentAssignment } from "./AgentIdentity.js";
import type { Action, Data } from "./services.js";

type Result = { threadId: string; turnId: string; status: string; text: string; truncated: boolean; error?: { message?: string } | null; configuration?: { readOnly: boolean; model?: { providerId: string; modelId: string }; profile?: { id: string } } };
type Child = { id: string; preview: string; parentThreadId: string };
type Version = { id: string; revision: string };
type Options = { profile: string; model: string; instructions: string; skillMode: "inherit" | "custom"; skills: string[]; toolMode: "inherit" | "custom"; tools: string };
const defaults: Options = { profile: "inherit", model: "inherit", instructions: "", skillMode: "inherit", skills: [], toolMode: "inherit", tools: "" };
const versionKey = (value: Version) => JSON.stringify({ id: value.id, revision: value.revision });
const modelKey = (value: Data) => JSON.stringify({ providerId: value.providerId, modelId: value.modelId });
function loadOptions(key: string): Options {
  try {
    const value = JSON.parse(localStorage.getItem(`${key}:options`) ?? "null");
    if (value && [value.profile, value.model, value.instructions, value.tools].every(v => typeof v === "string") && [value.skillMode, value.toolMode].every(v => v === "inherit" || v === "custom") && Array.isArray(value.skills) && value.skills.every((s: unknown) => typeof s === "string")) return value;
  } catch { /* UI drafts are not execution facts. */ }
  return defaults;
}
const labels: Record<string, string> = { inProgress: "执行中", completed: "已完成", interrupted: "已中断", failed: "失败" };

/** Direct Core children; isolated writers and Task workers retain their own owners. */
export function AgentsPane({ project, thread, action, onOpen, compact = false, selectedAgent }: { project: Data; thread: Data; action: Action; onOpen: (id: string) => void; compact?: boolean; selectedAgent?: string }) {
  const key = `areal-gui:agent-draft:${project.id}:${thread.id}`;
  const [prompt, setPrompt] = useState(() => localStorage.getItem(key) ?? "");
  const [options, setOptions] = useState(() => loadOptions(key));
  const [unknown, setUnknown] = useState(() => !!localStorage.getItem(`${key}:pending`));
  const [recovering, setRecovering] = useState(false), [notice, setNotice] = useState("");
  const [children, setChildren] = useState<Child[]>([]), [results, setResults] = useState<Record<string, Result>>({});
  const [reading, setReading] = useState(true), [creating, setCreating] = useState(false), [more, setMore] = useState(false);
  const [readError, setReadError] = useState(""), [error, setError] = useState("");
  const [waiting, setWaiting] = useState<string | null>(null), [waitNotice, setWaitNotice] = useState<Record<string, string>>({});
  const generation = useRef(0), pages = useRef(1), locked = useRef(false), waitLock = useRef(false), mounted = useRef(true);
  const inflight = useRef<Promise<void> | null>(null);
  const connected = !!project.state?.connected;
  const active = thread.turns?.some((turn: Data) => turn.status === "inProgress");
  const pending = project.pending?.some((entry: Data) => entry.params?.threadId === thread.id);
  const parentConfig = thread.turns?.at(-1)?.configuration ?? thread.desktop?.configuration;
  const profiles: Data[] = project.profiles ?? [];
  const models: Data[] = (project.models ?? []).filter((model: Data) => model.providerId && model.available !== false);
  const selectedModel = models.find(model => modelKey(model) === options.model);
  const selectedProfile = options.profile === "inherit" ? parentConfig?.profile : profiles.find(profile => versionKey(profile as Version) === options.profile);
  const skills: Version[] = selectedProfile?.skills ?? [];
  const changeOptions = (patch: Partial<Options>) => {
    const next = { ...options, ...patch }; setOptions(next); localStorage.setItem(`${key}:options`, JSON.stringify(next));
  };
  const request = useCallback((operation: string, extra: Data = {}) => action("manage", { projectId: project.id, parentThreadId: thread.id, operation, ...extra }), [action, project.id, thread.id]);
  const read = useCallback(() => {
    if (!connected) return Promise.resolve();
    if (inflight.current) return inflight.current;
    const stamp = ++generation.current; setReading(true);
    const pending = (async () => {
      try {
        const items: Child[] = []; let cursor: string | null = null;
        for (let index = 0; index < pages.current; index++) {
          const page = await request("agents", { limit: 30, ...(cursor ? { cursor } : {}) });
          items.push(...page.data); cursor = page.nextCursor;
          if (!cursor) break;
        }
        const unique = [...new Map(items.map(item => [item.id, item])).values()];
        const values: Result[] = [];
        for (let index = 0; index < unique.length; index += 16) {
          const response = await request("agentWait", { threadIds: unique.slice(index, index + 16).map(item => item.id), timeoutMs: 0 });
          values.push(...response.data);
        }
        if (mounted.current && generation.current === stamp) {
          setChildren(unique); setMore(!!cursor); setResults(Object.fromEntries(values.map(value => [value.threadId, value]))); setReadError("");
        }
      } catch (cause) { if (mounted.current && generation.current === stamp) setReadError(`子任务刷新失败，当前结果可能已过期。${(cause as Error).message}`); }
      finally { if (mounted.current && generation.current === stamp) setReading(false); inflight.current = null; }
    })();
    inflight.current = pending; return pending;
  }, [request, connected]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current++; };
  }, []);
  useEffect(() => {
    // A request can finish in the previous mounted pane after this pane reopens.
    // Sync only its UI draft; child identity and results still come from Core.
    const sync = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key) return;
      setUnknown(!!localStorage.getItem(`${key}:pending`));
      setPrompt(localStorage.getItem(key) ?? "");
      setOptions(loadOptions(key));
    };
    document.addEventListener("areal:agent-draft-updated", sync);
    return () => document.removeEventListener("areal:agent-draft-updated", sync);
  }, [key]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await read(); if (live) timer = setTimeout(poll, 2000); };
    void poll();
    return () => { live = false; generation.current++; clearTimeout(timer); };
  }, [read]);
  const clearSubmission = (saved: string) => {
    // 旧面板的迟到响应不能清除后来建立的另一个提交或草稿。
    if (localStorage.getItem(`${key}:pending`) !== saved) return false;
    localStorage.removeItem(`${key}:pending`); localStorage.removeItem(key); localStorage.removeItem(`${key}:options`);
    document.dispatchEvent(new CustomEvent("areal:agent-draft-updated", { detail: key }));
    if (mounted.current) { setUnknown(false); setPrompt(""); setOptions(defaults); }
    return true;
  };
  const recover = async () => {
    if (locked.current || !connected) return;
    locked.current = true; setRecovering(true); setError(""); setNotice("");
    try {
      const saved = localStorage.getItem(`${key}:pending`);
      let submission: { requestId?: string } | null = null;
      try { submission = JSON.parse(saved ?? "null"); } catch { /* 旧版或损坏的记录不能据此解锁。 */ }
      if (!saved || typeof submission?.requestId !== "string") throw new Error("旧版创建记录缺少请求标识，无法精确核对；当前指令保持锁定。");
      const receipt = await request("agentSubmission", { requestId: submission.requestId });
      if (!receipt.confirmed) throw new Error("尚未找到原创建请求的确认记录；不能确定是否创建成功，不会重发。");
      if (!clearSubmission(saved)) throw new Error("当前创建记录已变化，请重新核对。");
      if (mounted.current) setNotice("已确认子任务创建，可在列表中打开结果。");
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { locked.current = false; if (mounted.current) { setRecovering(false); await read(); } }
  };
  const createDisabled = !active || !connected || pending || creating || unknown || !!readError || thread.desktop?.archived;
  const create = async () => {
    if (locked.current || createDisabled || !prompt.trim()) return;
    if (localStorage.getItem(`${key}:pending`)) { setUnknown(true); return; }
    locked.current = true; setCreating(true); setError(""); setNotice("");
    let saved: string | undefined;
    try {
      const overrides: Data = {};
      if (options.profile !== "inherit") {
        if (!selectedProfile) throw new Error("所选预设不可用，请重新选择。");
        overrides.agentProfile = { id: selectedProfile.id, revision: selectedProfile.revision };
      }
      if (options.model !== "inherit") {
        const model = models.find(item => modelKey(item) === options.model);
        if (!model) throw new Error("所选模型不可用，请重新选择。");
        overrides.model = { providerId: model.providerId, modelId: model.modelId };
      }
      if (new TextEncoder().encode(options.instructions).length > 16 * 1024) throw new Error("附加指令不能超过 16 KiB（UTF-8）。");
      if (options.instructions) overrides.instructions = options.instructions;
      if (options.skillMode === "custom") {
        if (!selectedProfile) throw new Error("选择技能需要有效预设。");
        if (options.skills.some(id => !skills.some(skill => versionKey(skill) === id))) throw new Error("所选技能不属于当前预设，请重新选择。");
        overrides.skills = skills.filter(skill => options.skills.includes(versionKey(skill)));
      }
      if (options.toolMode === "custom") {
        const names = [...new Set(options.tools.split(/\r?\n/).map(name => name.trim()).filter(Boolean))];
        if (names.length > 128) throw new Error("最多指定 128 个工具。");
        overrides.toolAllowlist = names;
      }
      // Preserve uncertainty even if this renderer closes before the response.
      const requestId = crypto.randomUUID(); saved = JSON.stringify({ requestId });
      localStorage.setItem(`${key}:pending`, saved); setUnknown(true);
      await request("agentSpawn", { prompt, requestId, ...overrides });
      clearSubmission(saved);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (!failure.submissionUnknown && saved && localStorage.getItem(`${key}:pending`) === saved) {
        localStorage.removeItem(`${key}:pending`);
        document.dispatchEvent(new CustomEvent("areal:agent-draft-updated", { detail: key }));
        if (mounted.current) setUnknown(false);
      }
      if (mounted.current) setError(failure.message);
    } finally {
      locked.current = false;
      if (mounted.current) { setCreating(false); await read(); }
    }
  };
  const waitFor = async (id: string) => {
    if (waitLock.current || !connected) return;
    waitLock.current = true; setWaiting(id); setError(""); setWaitNotice(previous => ({ ...previous, [id]: "" }));
    try {
      const response = await request("agentWait", { threadIds: [id], timeoutMs: 10000 });
      const value: Result = response.data[0];
      if (mounted.current) {
        generation.current++; setReading(false);
        setResults(previous => ({ ...previous, [id]: value }));
        setWaitNotice(previous => ({ ...previous, [id]: value.status === "inProgress" ? "等待时间已到，子任务仍在执行。" : "" }));
      }
    } catch (cause) { if (mounted.current) setError(`等待结束，但结果未确认。${(cause as Error).message}`); }
    finally { waitLock.current = false; if (mounted.current) setWaiting(null); }
  };
  if (compact) return !children.length && !readError ? null : <section className="task-resources-section task-resources-agents" aria-label="子智能体">
    <h3 className="task-resources-heading"><span>子智能体</span><span>{Object.values(results).filter(result => result.status === "inProgress").length} 个运行中</span></h3>
    {!connected && <p className="task-resource-note" role="status">连接不可用，结果可能已过期。</p>}
    {readError && <p role="alert" className="text-destructive">{readError}</p>}
    {children.map(child => <button type="button" key={child.id} className="task-resource-row" data-selected={selectedAgent === child.id || undefined} aria-label={`打开 ${child.id} 子对话`} onClick={() => onOpen(child.id)}>
      <AgentAvatar id={child.id} /><div className="task-resource-agent-body"><span>{agentName(child.id)}</span><p title={agentAssignment(thread, child.id)}>{agentAssignment(thread, child.id) || "查看任务指令"}</p></div>
      <small className="task-resource-status" data-running={results[child.id]?.status === "inProgress" || undefined}>{agentStatus(results[child.id]?.status)}</small>
    </button>)}
    {more && <Button variant="ghost" size="sm" disabled={reading} onClick={() => { pages.current++; void read(); }}>加载更多子智能体</Button>}
  </section>;
  return <section aria-label="子任务" className="flex h-full min-h-0 flex-col text-ui-base">
    <div className="panel-toolbar flex shrink-0 items-center justify-between gap-2"><span>子任务 · {children.length}</span><Button size="sm" variant="ghost" disabled={!connected || reading} onClick={() => void read()}>刷新子任务</Button></div>
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      {thread.parentThreadId && <Button size="sm" variant="outline" className="self-start" onClick={() => onOpen(thread.parentThreadId)}>返回父任务</Button>}
      <div className="flex flex-col gap-2 rounded-control border border-border p-3">
        <h3 className="font-medium">创建子任务</h3>
        <p className="text-foreground-subtle">共享当前工作区，只读分析。默认沿用父任务配置，始终遵守父轮次的权限上限。</p>
        <Textarea aria-label="子任务指令" value={prompt} disabled={creating || unknown} onChange={event => { setPrompt(event.target.value); localStorage.setItem(key, event.target.value); }} placeholder="描述子任务需要完成的分析…" />
        <details><summary>子任务配置</summary><fieldset disabled={creating || unknown} className="mt-3 flex min-w-0 flex-col gap-3">
          <label className="flex flex-col gap-1">预设<Select value={options.profile} disabled={creating || unknown} onValueChange={value => { if (value) changeOptions({ profile: value, skillMode: "inherit", skills: [] }); }}><SelectTrigger aria-label="子任务预设"><SelectValue>{options.profile === "inherit" ? "继承父任务预设" : selectedProfile ? `${selectedProfile.displayName || selectedProfile.id} · ${selectedProfile.revision}` : "预设不可用"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="inherit">继承父任务预设</SelectItem>{profiles.map(profile => <SelectItem key={versionKey(profile as Version)} value={versionKey(profile as Version)}>{profile.displayName || profile.id} · {profile.revision}</SelectItem>)}</SelectContent></Select></label>
          <label className="flex flex-col gap-1">模型<Select value={options.model} disabled={creating || unknown} onValueChange={value => { if (value) changeOptions({ model: value }); }}><SelectTrigger aria-label="子任务模型"><SelectValue>{options.model === "inherit" ? "按预设与父任务" : selectedModel?.displayName || selectedModel?.modelId || "模型不可用"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="inherit">按预设与父任务</SelectItem>{models.map(model => <SelectItem key={modelKey(model)} value={modelKey(model)}>{model.displayName || model.modelId}</SelectItem>)}</SelectContent></Select></label>
          <label className="flex flex-col gap-1">附加指令<Textarea aria-label="子任务附加指令" value={options.instructions} onChange={event => changeOptions({ instructions: event.target.value })} placeholder="补充本次子任务的要求…" /></label>
          <label className="flex flex-col gap-1">技能范围<Select value={options.skillMode} disabled={creating || unknown} onValueChange={value => { if (value === "inherit" || value === "custom") changeOptions({ skillMode: value }); }}><SelectTrigger aria-label="子任务技能范围"><SelectValue>{options.skillMode === "inherit" ? "按预设与父任务" : "选择技能"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="inherit">按预设与父任务</SelectItem><SelectItem value="custom">选择技能</SelectItem></SelectContent></Select></label>
          {options.skillMode === "custom" && <div className="flex flex-col gap-2">{skills.map(skill => <label key={versionKey(skill)} className="flex items-center gap-2"><input type="checkbox" checked={options.skills.includes(versionKey(skill))} onChange={event => changeOptions({ skills: event.target.checked ? [...options.skills, versionKey(skill)] : options.skills.filter(id => id !== versionKey(skill)) })} />{skill.id} · {skill.revision}</label>)}<p className="text-foreground-subtle">未选中技能时，本次子任务不使用技能。切换预设后需要重新选择。</p></div>}
          <label className="flex flex-col gap-1">工具范围<Select value={options.toolMode} disabled={creating || unknown} onValueChange={value => { if (value === "inherit" || value === "custom") changeOptions({ toolMode: value }); }}><SelectTrigger aria-label="子任务工具范围"><SelectValue>{options.toolMode === "inherit" ? "按预设与父任务" : "指定工具"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="inherit">按预设与父任务</SelectItem><SelectItem value="custom">指定工具</SelectItem></SelectContent></Select></label>
          {options.toolMode === "custom" && <label className="flex flex-col gap-1">每行一个工具名<Textarea aria-label="子任务工具列表" value={options.tools} onChange={event => changeOptions({ tools: event.target.value })} placeholder="fs_read" /><span className="text-foreground-subtle">只能收窄父任务范围；留空表示不使用工具。</span></label>}
        </fieldset></details>
        {!active && <p role="status">父任务正在执行时才能创建子任务。</p>}
        {unknown && !creating && <div className="flex flex-col gap-2"><p role="alert">创建结果待确认。请核对原创建请求；刷新不会重发，当前指令保持锁定。</p><Button size="sm" variant="outline" className="self-start" disabled={!connected || recovering} onClick={() => void recover()}>{recovering ? "核对中…" : "核对子任务创建"}</Button></div>}
        {notice && <p role="status">{notice}</p>}
        <Button size="sm" className="self-start" disabled={createDisabled || !prompt.trim()} onClick={() => void create()}>{creating ? "创建中…" : "创建子任务"}</Button>
      </div>
      {!connected && <p role="status">连接不可用，结果可能已过期。</p>}
      {readError && <p role="alert" className="text-destructive">{readError}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {!reading && !readError && !children.length && <p className="text-foreground-subtle">此任务尚无子任务。</p>}
      {children.map(child => { const result = results[child.id]; return <article key={child.id} data-testid={`agent-${child.id}`} className="flex flex-col gap-2 rounded-control border border-border p-3">
        <h3 className="flex items-center gap-2 font-medium"><AgentAvatar id={child.id} />{agentName(child.id)}</h3><p className="break-words">{child.preview || "子任务"}</p>
        <p role="status">{labels[result?.status] ?? "状态待确认"}</p>
        {result?.configuration && <p className="text-foreground-subtle">{result.configuration.readOnly ? "只读" : "按任务权限执行"}{result.configuration.profile ? ` · ${result.configuration.profile.id}` : ""}{result.configuration.model?.modelId ? ` · ${result.configuration.model.modelId}` : ""}</p>}
        {result?.error && <p className="text-destructive">{result.error.message || "执行失败"}</p>}
        {result?.text && <p className="whitespace-pre-wrap break-words">{result.text}</p>}
        {result?.truncated && <p className="text-foreground-subtle">结果已截断，打开子任务查看完整内容。</p>}
        {waitNotice[child.id] && result?.status === "inProgress" && <p role="status">{waitNotice[child.id]}</p>}
        <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={!connected || !!waiting || !!readError} onClick={() => void waitFor(child.id)}>{waiting === child.id ? "等待中…" : "等待结果"}</Button><Button size="sm" variant="ghost" onClick={() => onOpen(child.id)}>打开子任务与结果</Button></div>
      </article>; })}
      {more && <Button variant="outline" size="sm" disabled={reading || !connected} onClick={() => { pages.current++; void read(); }}>加载更多子任务</Button>}
    </div>
  </section>;
}
