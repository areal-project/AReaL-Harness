import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import type { Data } from "./services.js";

type Task = { id: string; instruction: string; writes: string[]; depends: string[]; integrationDepends?: string[]; checks: string[][]; configuration?: Data | null };
export type WorkgroupPlan = { objective: string; tasks: Task[] };
type Draft = { baseRevision: number; base: WorkgroupPlan; plan: WorkgroupPlan };
const blank = (): WorkgroupPlan => ({ objective: "", tasks: [{ id: "stage-1", instruction: "", writes: [], depends: [], integrationDepends: [], checks: [] }] });
const fromRecord = (record?: Data): WorkgroupPlan => record ? { objective: record.objective, tasks: record.tasks.map((task: Data) => task.spec) } : blank();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const lines = (values: string[]) => [...new Set(values.map(value => value.trim()).filter(Boolean))];
const bytes = (value: string) => new TextEncoder().encode(value).length;
const versionKey = (value: Data) => JSON.stringify({ id: value.id, revision: value.revision });
const modelKey = (value: Data) => JSON.stringify({ providerId: value.providerId, modelId: value.modelId });
function load(key: string, record?: Data, initial?: WorkgroupPlan): Draft {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    const valid = (plan: WorkgroupPlan) => typeof plan?.objective === "string" && Array.isArray(plan.tasks) && plan.tasks.length <= 64 && plan.tasks.every(task => typeof task.id === "string" && typeof task.instruction === "string" && [task.writes, task.depends, task.integrationDepends ?? []].every(values => Array.isArray(values) && values.every(v => typeof v === "string")) && Array.isArray(task.checks) && task.checks.every(c => Array.isArray(c) && c.every(a => typeof a === "string")));
    if (value && Number.isSafeInteger(value.baseRevision) && valid(value.base) && valid(value.plan)) return value;
  } catch { /* A damaged UI draft is not execution state. */ }
  const base = fromRecord(record);
  return { baseRevision: record?.planRevision ?? 0, base, plan: initial ?? base };
}
function normalized(plan: WorkgroupPlan, policy: Data): WorkgroupPlan {
  const result = { objective: plan.objective, tasks: plan.tasks.map(task => ({ ...task, ...(task.configuration && Array.isArray(task.configuration.toolAllowlist) ? { configuration: { ...task.configuration, toolAllowlist: lines(task.configuration.toolAllowlist) } } : {}), writes: lines(task.writes), depends: lines(task.depends), integrationDepends: lines(task.integrationDepends ?? []) })) };
  if (!result.objective.trim() || bytes(result.objective) > 32000) throw Error("目标需要文字，且不能超过32000字节。");
  if (!result.tasks.length || result.tasks.length > 64) throw Error("计划需要1至64个阶段。");
  const ids = new Set<string>();
  for (const task of result.tasks) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(task.id) || ids.has(task.id)) throw Error("阶段标识需要唯一的字母、数字、下划线或连字符，最多80字符。");
    ids.add(task.id);
    if (!task.instruction.trim() || bytes(task.instruction) > 32000) throw Error(`阶段 ${task.id} 的指令需要文字，且不能超过32000字节。`);
    if (task.writes.length > 256) throw Error(`阶段 ${task.id} 最多拥有256个写入文件。`);
    for (const path of task.writes) {
      if (path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..") || !((policy.allowedWrites ?? []).includes(path) || (policy.allowedDirectories ?? []).some((directory: string) => path.startsWith(directory + "/")))) throw Error(`写入路径超出部署授权或不是有效相对路径：${path}`);
    }
    if (task.depends.some(id => task.integrationDepends.includes(id))) throw Error("同一依赖不能同时作为执行依赖和集成依赖。");
    if (task.checks.length > 16 || task.checks.some(check => !check.length || check.length > 128 || !check[0] || check.some(arg => arg.includes("\0")) || check.reduce((sum, arg) => sum + bytes(arg), 0) > 32000)) throw Error("阶段检查需要有效的命令参数，每阶段最多16项。");
  }
  const done = new Set<string>();
  for (const task of result.tasks) if ([...task.depends, ...task.integrationDepends].some(id => !ids.has(id))) throw Error(`阶段 ${task.id} 的依赖不存在。`);
  while (done.size < result.tasks.length) {
    const before = done.size;
    for (const task of result.tasks) if ([...task.depends, ...task.integrationDepends].every(id => done.has(id))) done.add(task.id);
    if (done.size === before) throw Error("依赖包含环，请调整执行依赖或集成依赖。");
  }
  if (bytes(JSON.stringify(result)) > 256 * 1024) throw Error("计划不能超过256 KiB。");
  return result;
}

export function WorkgroupPlanEditor({ storageKey, project, policy, record, initial, disabled, onSubmit, onClose }: { storageKey: string; project: Data; policy: Data; record?: Data; initial?: WorkgroupPlan; disabled: boolean; onSubmit: (plan: WorkgroupPlan, revision: number) => Promise<Data | undefined>; onClose: () => void }) {
  const [draft, setDraft] = useState(() => load(storageKey, record, initial));
  const [error, setError] = useState(""), [saving, setSaving] = useState(false);
  const lock = useRef(false), mounted = useRef(true);
  const dirty = !same(draft.plan, draft.base), conflict = !!record && record.planRevision !== draft.baseRevision;
  const sealed = !!record && (record.status !== "running" || record.tasks.every((task: Data) => task.status === "integrated"));
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (record && !dirty && record.planRevision > draft.baseRevision) { const base = fromRecord(record); setDraft({ baseRevision: record.planRevision, base, plan: base }); localStorage.removeItem(storageKey); }
  }, [record?.planRevision, draft.baseRevision, dirty, storageKey]);
  const change = (plan: WorkgroupPlan) => { const value = { ...draft, plan }; setDraft(value); localStorage.setItem(storageKey, JSON.stringify(value)); setError(""); };
  const taskChange = (index: number, patch: Partial<Task>) => change({ ...draft.plan, tasks: draft.plan.tasks.map((task, i) => i === index ? { ...task, ...patch } : task) });
  const configChange = (index: number, patch: Data) => taskChange(index, { configuration: { ...(draft.plan.tasks[index].configuration ?? {}), ...patch } });
  const restore = () => { const base = fromRecord(record); setDraft({ baseRevision: record?.planRevision ?? 0, base, plan: base }); localStorage.removeItem(storageKey); setError(""); };
  const save = async () => {
    if (lock.current || disabled || sealed || conflict) return;
    let plan: WorkgroupPlan;
    try { plan = normalized(draft.plan, policy); } catch (cause) { setError((cause as Error).message); return; }
    lock.current = true; setSaving(true); setError("");
    try {
      const value = await onSubmit(plan, draft.baseRevision);
      if (value) { localStorage.removeItem(storageKey); if (mounted.current) onClose(); }
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  };
  const blocked = disabled || saving || sealed;
  return <section aria-label="工作组计划编辑" className="flex flex-col gap-3 rounded-control border border-border p-3">
    <div className="flex items-center justify-between"><h3 className="font-medium">{record ? "修订工作组计划" : "自定义工作组"}</h3><Button size="sm" variant="ghost" onClick={onClose}>关闭计划编辑</Button></div>
    {record && <p className="text-foreground-subtle">计划版本 {draft.baseRevision}。只能修改未启动阶段或追加阶段；已有标识、顺序及检查保留。</p>}
    {conflict && <p role="alert">计划版本已更新。草稿已保留，请核对后采用最新工作组计划。</p>}
    {sealed && <p role="status">计划已封存或执行结束，不能继续修订。</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
    {record && <Button size="sm" variant="outline" disabled={saving || disabled} onClick={restore}>采用最新工作组计划</Button>}
    <label>目标<Textarea aria-label="工作组目标" value={draft.plan.objective} disabled={blocked || !!record} onChange={event => change({ ...draft.plan, objective: event.target.value })} /></label>
    {draft.plan.tasks.map((task, index) => {
      const old = record?.tasks[index], frozen = !!old && (old.status !== "ready" || old.generation !== 0);
      const config = task.configuration ?? {}, profiles: Data[] = project.profiles ?? [], models: Data[] = (project.models ?? []).filter((model: Data) => model.providerId && model.available !== false);
      const profile = profiles.find(value => config.agentProfile && versionKey(value) === versionKey(config.agentProfile));
      const skillRefs: Data[] = profile?.skills ?? [];
      const label = `阶段 ${index + 1}`;
      return <fieldset key={index} disabled={blocked || frozen} className="flex min-w-0 flex-col gap-2 rounded-control border border-border p-3">
        <legend>{label}{frozen ? " · 已启动，不可修改" : ""}</legend>
        <label>标识<Textarea aria-label={`${label} 标识`} disabled={blocked || !!old} value={task.id} onChange={event => taskChange(index, { id: event.target.value })} /></label>
        <label>指令<Textarea aria-label={`${label} 指令`} value={task.instruction} onChange={event => taskChange(index, { instruction: event.target.value })} /></label>
        <label>写入路径（每行一个文件）<Textarea aria-label={`${label} 写入路径`} value={task.writes.join("\n")} onChange={event => taskChange(index, { writes: event.target.value.split("\n") })} /></label>
        <label>执行依赖（每行一个阶段标识）<Textarea aria-label={`${label} 执行依赖`} value={task.depends.join("\n")} onChange={event => taskChange(index, { depends: event.target.value.split("\n") })} /></label>
        <label>集成依赖（每行一个阶段标识）<Textarea aria-label={`${label} 集成依赖`} value={(task.integrationDepends ?? []).join("\n")} onChange={event => taskChange(index, { integrationDepends: event.target.value.split("\n") })} /></label>
        <p className="text-foreground-subtle">执行依赖完成集成后才启动；集成依赖允许提前执行，但在接纳产物前等待。</p>
        <details><summary>阶段配置与检查</summary><div className="mt-2 flex flex-col gap-2">
          <Select value={config.agentProfile ? versionKey(config.agentProfile) : "inherit"} disabled={blocked || frozen} onValueChange={value => { if (value) configChange(index, { agentProfile: value === "inherit" ? null : JSON.parse(value), skills: null }); }}><SelectTrigger aria-label={`${label} 预设`}><SelectValue>{profile?.displayName ?? (config.agentProfile ? "预设不可用" : "部署默认预设")}</SelectValue></SelectTrigger><SelectContent><SelectItem value="inherit">部署默认预设</SelectItem>{profiles.map(value => <SelectItem key={versionKey(value)} value={versionKey(value)}>{value.displayName || value.id} · {value.revision}</SelectItem>)}</SelectContent></Select>
          <Select value={config.model ? modelKey(config.model) : "inherit"} disabled={blocked || frozen} onValueChange={value => { if (value) configChange(index, { model: value === "inherit" ? null : JSON.parse(value), defaultModelRevision: null }); }}><SelectTrigger aria-label={`${label} 模型`}><SelectValue>{config.model?.modelId ?? "部署默认模型"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="inherit">部署默认模型</SelectItem>{models.map(value => <SelectItem key={modelKey(value)} value={modelKey(value)}>{value.displayName || value.modelId}</SelectItem>)}</SelectContent></Select>
          <label><input type="checkbox" aria-label={`${label} 只读`} checked={config.readOnly === true} onChange={event => configChange(index, { readOnly: event.target.checked })} /> 只读执行（部署限制仍然有效）</label>
          <label><input type="checkbox" checked={Array.isArray(config.skills)} onChange={event => configChange(index, { skills: event.target.checked ? [] : null })} /> 自定义技能范围</label>
          {Array.isArray(config.skills) && <div>{skillRefs.map(skill => <label key={versionKey(skill)} className="block"><input type="checkbox" checked={config.skills.some((ref: Data) => versionKey(ref) === versionKey(skill))} onChange={event => configChange(index, { skills: event.target.checked ? [...config.skills, { id: skill.id, revision: skill.revision }] : config.skills.filter((ref: Data) => versionKey(ref) !== versionKey(skill)) })} /> {skill.id} · {skill.revision}</label>)}<p className="text-foreground-subtle">未选中表示不使用技能。选择预设后显示其可用技能。</p></div>}
          <label><input type="checkbox" checked={Array.isArray(config.toolAllowlist)} onChange={event => configChange(index, { toolAllowlist: event.target.checked ? [] : null })} /> 自定义工具范围</label>
          {Array.isArray(config.toolAllowlist) && <Textarea aria-label={`${label} 工具范围`} value={config.toolAllowlist.join("\n")} onChange={event => configChange(index, { toolAllowlist: event.target.value.split("\n") })} placeholder="每行一个工具名；留空表示不使用工具" />}
          {task.checks.map((check, ci) => <div key={ci}><label>检查 {ci + 1}（首行是程序，其余每行一个参数）<Textarea aria-label={`${label} 检查 ${ci + 1}`} value={check.join("\n")} disabled={blocked || ci < (old?.spec.checks.length ?? 0)} onChange={event => taskChange(index, { checks: task.checks.map((args, i) => i === ci ? event.target.value.split("\n") : args) })} /></label>{ci >= (old?.spec.checks.length ?? 0) && <Button size="sm" variant="ghost" onClick={() => taskChange(index, { checks: task.checks.filter((_, i) => i !== ci) })}>移除检查 {ci + 1}</Button>}</div>)}
          <Button size="sm" variant="outline" disabled={blocked || task.checks.length >= 16} onClick={() => taskChange(index, { checks: [...task.checks, [""]] })}>添加阶段检查</Button>
        </div></details>
        {!old && <Button size="sm" variant="ghost" onClick={() => change({ ...draft.plan, tasks: draft.plan.tasks.filter((_, i) => i !== index) })}>移除阶段 {index + 1}</Button>}
      </fieldset>;
    })}
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={blocked || draft.plan.tasks.length >= 64} onClick={() => { let number = draft.plan.tasks.length + 1; while (draft.plan.tasks.some(task => task.id === `stage-${number}`)) number++; change({ ...draft.plan, tasks: [...draft.plan.tasks, { id: `stage-${number}`, instruction: "", writes: [], depends: [], integrationDepends: [], checks: [] }] }); }}>添加阶段</Button><Button size="sm" disabled={blocked || conflict || (!!record && !dirty)} onClick={() => void save()}>{record ? "保存工作组修订" : "启动自定义工作组"}</Button></div>
  </section>;
}
