import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select.js";
import type { Action, Data } from "./services.js";
import { WorkgroupPlanEditor, type WorkgroupPlan } from "./WorkgroupPlanEditor.js";

const status: Record<string, string> = { running: "执行中", completed: "已完成", failed: "失败", cancelled: "已取消", unknown: "结果未知", ready: "等待执行", submitted: "等待验证", validating: "验证中", integrated: "已集成", blocked: "被阻塞" };
type ArtifactPending = { id: string; path: string; head: string };
type WorkflowOrigin = { id: string; revision: string; displayName: string };
function loadWorkflowOrigins(key: string): Record<string, WorkflowOrigin> {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "{}");
    return value && !Array.isArray(value) && typeof value === "object" ? value : {};
  } catch { return {}; }
}
function pendingArtifact(key: string): ArtifactPending | null {
  try { const value = JSON.parse(localStorage.getItem(key) ?? "null"); return value && [value.id, value.path, value.head].every(item => typeof item === "string") ? value : null; } catch { return null; }
}
const terminal = new Set(["completed", "failed", "cancelled", "unknown"]);
const keyOf = (value: Data) => JSON.stringify({ id: value.id, revision: value.revision });

/** Workgroups are project-scoped Core executions, not Threads or scheduled Tasks. */
export function WorkgroupsPane({ project, action }: { project: Data; action: Action }) {
  const storageKey = `areal-gui:workgroup:${project.id}`;
  const [enabled, setEnabled] = useState<boolean | null>(null), [policy, setPolicy] = useState<Data | null>(null);
  const [groups, setGroups] = useState<Data[]>([]), [workflows, setWorkflows] = useState<Data[]>([]);
  const [selected, setSelected] = useState(() => localStorage.getItem(storageKey) ?? "");
  const [workflowKey, setWorkflowKey] = useState(() => localStorage.getItem(`${storageKey}:workflow`) ?? "");
  const [workflowOrigins, setWorkflowOrigins] = useState<Record<string, WorkflowOrigin>>(() => loadWorkflowOrigins(`${storageKey}:workflow-origins`));
  const [workflow, setWorkflow] = useState<Data | null>(null), [detail, setDetail] = useState<Data | null>(null);
  const [workers, setWorkers] = useState(""), [admission, setAdmission] = useState("fixed");
  const [reading, setReading] = useState(true), [busy, setBusy] = useState(false), [confirmCancel, setConfirmCancel] = useState(false);
  const [unknown, setUnknown] = useState(() => !!localStorage.getItem(`${storageKey}:pending`));
  const [detailError, setDetailError] = useState("");
  const [readError, setReadError] = useState(""), [error, setError] = useState("");
  const artifactKey = `${storageKey}:artifact-pending`;
  const [artifactPending, setArtifactPending] = useState(() => pendingArtifact(artifactKey));
  const [applyError, setApplyError] = useState("");
  const [applyState, setApplyState] = useState<string | null>(null);
  const [paths, setPaths] = useState<Data | null>(null), [file, setFile] = useState<Data | null>(null);
  const [planEditor, setPlanEditor] = useState<{ id?: string; initial?: WorkgroupPlan } | null>(null);
  const mounted = useRef(true), locked = useRef(false), fileGeneration = useRef(0), listRequest = useRef<Promise<void> | null>(null);
  const connected = !!project.state?.connected;
  const pending = project.pending?.some((entry: Data) => entry.method?.startsWith("areal/workgroup/") || entry.method === "areal/workflow/start");
  const request = useCallback((operation: string, params: Data = {}) => action("manage", { projectId: project.id, operation, ...params }), [action, project.id]);
  const acceptDetail = useCallback((value: Data) => {
    setDetail(previous => !previous || previous.id !== value.id || value.record.revision >= previous.record.revision ? value : previous);
    const record = value.record;
    const summary = { id: value.id, objective: record.objective, status: record.status, revision: record.revision, cleanupConfirmed: record.cleanupConfirmed, head: record.head };
    setGroups(previous => previous.some(group => group.id === value.id)
      ? previous.map(group => group.id === value.id && record.revision >= group.revision ? { ...group, ...summary } : group)
      : [...previous, summary]);
  }, []);
  const select = (id: string) => { setSelected(id); localStorage.setItem(storageKey, id); setConfirmCancel(false); setPlanEditor(null); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; fileGeneration.current++; }; }, []);
  useEffect(() => {
    const sync = (event: Event) => { if ((event as CustomEvent<string>).detail === artifactKey) setArtifactPending(pendingArtifact(artifactKey)); };
    document.addEventListener("areal:workgroup-artifact", sync);
    return () => document.removeEventListener("areal:workgroup-artifact", sync);
  }, [artifactKey]);
  useEffect(() => {
    const key = `${storageKey}:workflow-origins`;
    const sync = (event: StorageEvent) => {
      if (event.key !== key) return;
      setWorkflowOrigins(loadWorkflowOrigins(key));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [storageKey]);
  const storeArtifactPending = (value: ArtifactPending | null) => {
    if (value) localStorage.setItem(artifactKey, JSON.stringify(value)); else localStorage.removeItem(artifactKey);
    document.dispatchEvent(new CustomEvent("areal:workgroup-artifact", { detail: artifactKey }));
  };
  const rememberWorkflow = (workgroupId: string, origin?: WorkflowOrigin) => {
    if (!origin) return;
    const key = `${storageKey}:workflow-origins`;
    const current = loadWorkflowOrigins(key);
    const next = { ...current, [workgroupId]: origin };
    localStorage.setItem(key, JSON.stringify(next)); setWorkflowOrigins(next);
  };
  const refresh = useCallback(() => {
    if (!connected) return Promise.resolve();
    if (listRequest.current) return listRequest.current;
    setReading(true);
    const task = (async () => {
      try {
        const capability = await request("workgroupCapabilities");
        if (!capability.enabled) { if (mounted.current) { setEnabled(false); setReadError(""); } return; }
        const [limits, list, catalog] = await Promise.all([request("workgroupPolicy"), request("workgroups"), request("workflows")]);
        if (mounted.current) {
          setEnabled(true); setPolicy(limits);
          setGroups(previous => list.data.map((group: Data) => { const known = previous.find(item => item.id === group.id); return known && known.revision > group.revision ? known : group; }));
          setWorkflows(previous => JSON.stringify(previous) === JSON.stringify(catalog.data) ? previous : catalog.data); setReadError("");
        }
      } catch (cause) { if (mounted.current) setReadError(`工作组刷新失败，当前数据可能已过期。${(cause as Error).message}`); }
      finally { if (mounted.current) setReading(false); listRequest.current = null; }
    })();
    listRequest.current = task; return task;
  }, [request, connected]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const tick = async () => { await refresh(); if (live) timer = setTimeout(tick, 2500); };
    void tick(); return () => { live = false; clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => {
    const sync = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== storageKey) return;
      setUnknown(!!localStorage.getItem(`${storageKey}:pending`));
      setSelected(localStorage.getItem(storageKey) ?? "");
    };
    document.addEventListener("areal:workgroup-operation", sync);
    return () => document.removeEventListener("areal:workgroup-operation", sync);
  }, [storageKey]);
  useEffect(() => {
    let live = true; setWorkflow(null); setError("");
    const ref = workflows.find(item => keyOf(item) === workflowKey);
    if (ref) void request("workflow", { id: ref.id, revision: ref.revision }).then(value => { if (live) setWorkflow(value); }).catch(cause => { if (live) setError(cause.message); });
    return () => { live = false; };
  }, [workflowKey, request, workflows]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    setDetail(null); setPaths(null); setFile(null); setApplyState(null); setApplyError(""); setDetailError(""); fileGeneration.current++; setConfirmCancel(false);
    const tick = async () => {
      if (!selected || !connected) return;
      try { const value = await request("workgroup", { id: selected }); if (live) { acceptDetail(value); setDetailError(""); } }
      catch (cause) { if (live) setDetailError(`工作组详情读取失败。${(cause as Error).message}`); }
      if (live) timer = setTimeout(tick, 1500);
    };
    void tick(); return () => { live = false; clearTimeout(timer); };
  }, [selected, connected, request, acceptDetail]);
  const mutate = async (operation: string, params: Data) => {
    const creating = operation !== "workgroupCancel";
    if (locked.current || !connected || readError || (creating && (pending || unknown)) || (!creating && detailError)) return;
    locked.current = true; setBusy(true); setError("");
    const requestId = creating ? crypto.randomUUID() : undefined;
    const origin = operation === "workflowStart" ? workflows.find(item => item.id === params.workflow?.id && item.revision === params.workflow?.revision) : undefined;
    if (creating) { localStorage.setItem(`${storageKey}:pending`, JSON.stringify({ requestId, operation, id: params.id, workflow: origin && { id: origin.id, revision: origin.revision, displayName: origin.displayName } })); setUnknown(true); }
    try {
      const value = await request(operation, { ...params, ...(requestId ? { requestId } : {}) });
      // Store the actual ID even when the originating panel has closed.
      localStorage.setItem(storageKey, value.id);
      rememberWorkflow(value.id, origin && { id: origin.id, revision: origin.revision, displayName: origin.displayName });
      if (creating) localStorage.removeItem(`${storageKey}:pending`);
      document.dispatchEvent(new CustomEvent("areal:workgroup-operation", { detail: storageKey }));
      if (mounted.current) { select(value.id); acceptDetail(value); setConfirmCancel(false); await refresh(); }
      return value;
    } catch (cause) {
      if (creating && !(cause as Error & { submissionUnknown?: boolean }).submissionUnknown) {
        localStorage.removeItem(`${storageKey}:pending`);
        document.dispatchEvent(new CustomEvent("areal:workgroup-operation", { detail: storageKey }));
      }
      if (mounted.current) setError((cause as Error).message);
    }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const reconcileSubmission = async () => {
    if (locked.current || !connected) return;
    let saved: Data | null;
    try { saved = JSON.parse(localStorage.getItem(`${storageKey}:pending`) ?? "null"); } catch { saved = null; }
    if (!saved?.requestId) { setError("此旧提交没有可核对的请求标识，仍保持未知状态；不会重发。"); return; }
    locked.current = true; setBusy(true); setError("");
    try {
      const receipt = await request("workgroupSubmission", { requestId: saved.requestId });
      if (!receipt.confirmed) { if (mounted.current) setError("尚未找到原提交的确认记录，继续保留未知状态；不会重发。"); return; }
      localStorage.setItem(storageKey, receipt.workgroupId);
      rememberWorkflow(receipt.workgroupId, saved.workflow);
      localStorage.removeItem(`${storageKey}:pending`);
      if (saved.operation === "workgroupStart" || saved.operation === "workgroupRevise") localStorage.removeItem(`${storageKey}:plan:${saved.id ?? "new"}`);
      document.dispatchEvent(new CustomEvent("areal:workgroup-operation", { detail: storageKey }));
      if (mounted.current) { select(receipt.workgroupId); await refresh(); }
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const start = () => {
    if (!workflow) return;
    const count = workers.trim() ? Number(workers) : undefined;
    if (count !== undefined && (!Number.isSafeInteger(count) || count < 1 || count > policy!.workers)) { setError(`并发数应为1至${policy!.workers}的整数。`); return; }
    void mutate("workflowStart", { workflow: { id: workflow.id, revision: workflow.revision }, admission, ...(count === undefined ? {} : { workers: count }) });
  };
  const editPlan = async () => {
    if (!detail || locked.current) return;
    const id = detail.id; locked.current = true; setBusy(true); setError("");
    try {
      // Opening the editor must not expose already-started stages as editable
      // merely because the periodic detail snapshot is one poll behind.
      const value = await request("workgroup", { id });
      if (mounted.current && localStorage.getItem(storageKey) === id) { acceptDetail(value); setPlanEditor({ id }); }
    } catch (cause) { if (mounted.current) setError((cause as Error).message); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const artifacts = async (more = false) => {
    if (!detail || locked.current) return;
    const stamp = ++fileGeneration.current; locked.current = true; setBusy(true); setError("");
    try {
      const value = await request("workgroupArtifact", { id: detail.id, offset: more ? paths?.nextOffset : 0 });
      if (mounted.current && fileGeneration.current === stamp) {
        if (more && paths?.head !== value.head) throw new Error("产物版本已变化，请重新读取。");
        setPaths({ ...value, paths: more ? [...paths!.paths, ...value.paths] : value.paths });
      }
    } catch (cause) { if (mounted.current && fileGeneration.current === stamp) setError((cause as Error).message); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const readFile = async (path: string, more = false) => {
    if (!detail || locked.current) return;
    const stamp = ++fileGeneration.current; locked.current = true; setBusy(true); setError("");
    if (!more) { setFile(null); setApplyState(null); setApplyError(""); }
    try {
      const value = await request("workgroupArtifact", { id: detail.id, path, offset: more ? file?.nextOffset : 0 });
      if (mounted.current && fileGeneration.current === stamp) {
        if (value.path !== path || (more && (file?.sha256 !== value.sha256 || file?.head !== value.head || file?.bytes !== value.bytes || file?.baseSha256 !== value.baseSha256 || file?.exists !== value.exists || file?.executable !== value.executable))) throw new Error("产物版本已变化，请重新读取。");
        const chunk = Uint8Array.from(atob(value.dataBase64), char => char.charCodeAt(0));
        const expected = more ? file!.nextOffset : 0;
        if (value.offset !== expected || value.nextOffset !== expected + chunk.length || value.nextOffset > value.bytes || value.complete !== (value.nextOffset === value.bytes) || (!value.complete && !chunk.length)) throw new Error("产物分块不完整，请重新读取。");
        const bytes = [...(more ? file!.data : []), ...chunk];
        const text = new TextDecoder("utf-8", { fatal: true });
        let preview: string | null;
        try { const decoded = text.decode(new Uint8Array(bytes), { stream: !value.complete }); preview = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded) ? null : decoded; }
        catch { preview = null; }
        setFile({ ...value, data: bytes, preview });
      }
    } catch (cause) { if (mounted.current && fileGeneration.current === stamp) setError((cause as Error).message); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const inspectFile = async () => {
    if (!detail || !file || locked.current) return;
    const params = { id: detail.id, path: file.path, head: file.head };
    const stamp = fileGeneration.current;
    locked.current = true; setBusy(true); setError(""); setApplyState(null); setApplyError("");
    try {
      const value = await request("workgroupArtifactStatus", params);
      const pending = pendingArtifact(artifactKey);
      if (pending && pending.id === params.id && pending.path === params.path && pending.head === params.head) storeArtifactPending(null);
      if (mounted.current && fileGeneration.current === stamp) setApplyState(value.state);
    } catch (cause) {
      if (mounted.current && fileGeneration.current === stamp) setApplyError((cause as Error).message);
    } finally { locked.current = false; if (mounted.current) setBusy(false); }
  };
  const record = detail?.record;
  const profileThread = detail ? (Object.values(project.state?.threads ?? {}) as Data[]).find(thread => thread.desktop?.workflowRun?.workgroupId === detail.id) : undefined;
  const profileWorkflow = profileThread?.desktop?.workflowRun?.workflow;
  const controlDisabled = busy || !connected || !!readError || !!detailError;
  const disabled = busy || !connected || !!readError || pending || unknown;
  return <section aria-label="工作组" className="flex h-full min-h-0 flex-col text-ui-base">
    <div className="panel-toolbar flex shrink-0 items-center justify-between"><span>工作组</span><Button size="sm" variant="ghost" disabled={!connected || reading} onClick={() => void refresh()}>刷新工作组</Button></div>
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
      {!connected && <p role="status">连接不可用，当前数据可能已过期。</p>}
      {readError && <p role="alert" className="text-destructive">{readError}</p>}
      {detailError && <p role="alert" className="text-destructive">{detailError}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {artifactPending && !busy && <p role="alert">有一项产物应用待核对：{artifactPending.path}。重新打开此文件并核对文件状态；不会自动重发。</p>}
      {unknown && !busy && <div><p role="alert">工作组提交结果待确认。请核对原提交；刷新不会重新提交。</p><Button size="sm" variant="outline" disabled={!connected} onClick={() => void reconcileSubmission()}>核对工作组提交</Button></div>}
      {pending && <p role="status">工作组提交处理中或结果待确认。刷新不会重发请求。</p>}
      {enabled === false && <p role="status">当前部署未启用工作组执行。</p>}
      {enabled && <>
        <p className="text-foreground-subtle">在隔离工作区执行并验证产物。完成后审查结果，原项目不会自动被覆盖。</p>
        <details><summary>部署允许的范围</summary><p>文件：{policy?.allowedWrites?.join("、") || "无"}</p><p>目录：{policy?.allowedDirectories?.join("、") || "无"}</p><p>最多{policy?.workers}个执行者 · {policy?.timeoutSeconds}秒</p><ul>{policy?.checks?.map((check: string[], index: number) => <li key={index} className="break-all font-mono">{check.join(" ")}</li>)}</ul></details>
        <div className="flex flex-col gap-3 rounded-control border border-border p-3">
          <h3 className="font-medium">从工作流启动</h3>
          <Select value={workflowKey} disabled={disabled} onValueChange={value => { if (value) { setWorkflowKey(value); localStorage.setItem(`${storageKey}:workflow`, value); } }}><SelectTrigger aria-label="工作流模板"><SelectValue>{workflows.find(item => keyOf(item) === workflowKey)?.displayName || "选择工作流模板"}</SelectValue></SelectTrigger><SelectContent>{workflows.map(item => <SelectItem key={keyOf(item)} value={keyOf(item)}>{item.displayName} · {item.revision}</SelectItem>)}</SelectContent></Select>
          {!workflows.length && <p>当前部署没有工作流模板。</p>}
          {workflow && <><p>{workflow.plan.objective}</p><ol className="flex flex-col gap-2">{workflow.plan.tasks.map((task: Data) => <li key={task.id}><strong>{task.id}</strong><p className="whitespace-pre-wrap break-words">{task.instruction}</p><p className="text-foreground-subtle">写入：{task.writes.join("、") || "无"} · 执行依赖：{task.depends?.join("、") || "无"} · 集成依赖：{task.integrationDepends?.join("、") || "无"}</p></li>)}</ol></>}
          <label>并发执行者<input aria-label="工作组并发数" type="number" min={1} max={policy?.workers} value={workers} disabled={disabled} onChange={event => setWorkers(event.target.value)} className="ml-2 w-20 rounded-control border border-border bg-transparent px-2" placeholder="默认" /></label>
          <Select value={admission} disabled={disabled} onValueChange={value => { if (value) setAdmission(value); }}><SelectTrigger aria-label="工作组调度策略"><SelectValue>{{ fixed: "固定并发", auto: "限制待验证数量", adaptive: "自适应并发" }[admission]}</SelectValue></SelectTrigger><SelectContent><SelectItem value="fixed">固定并发</SelectItem><SelectItem value="auto">限制待验证数量</SelectItem><SelectItem value="adaptive">自适应并发</SelectItem></SelectContent></Select>
          <Button size="sm" disabled={disabled || !workflow} className="self-start" onClick={start}>启动工作流</Button>
        </div>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={disabled} onClick={() => setPlanEditor({})}>自定义工作组</Button></div>
        {planEditor && (!planEditor.id || detail?.id === planEditor.id) && <WorkgroupPlanEditor key={planEditor.id ?? "new"} storageKey={`${storageKey}:plan:${planEditor.id ?? "new"}`} project={project} policy={policy!} record={planEditor.id ? record : undefined} initial={planEditor.initial} disabled={disabled || (!!planEditor.id && !!detailError)} onClose={() => setPlanEditor(null)} onSubmit={async (plan, revision) => {
          if (planEditor.id) return mutate("workgroupRevise", { id: planEditor.id, expectedRevision: revision, plan });
          const count = workers.trim() ? Number(workers) : undefined;
          if (count !== undefined && (!Number.isSafeInteger(count) || count < 1 || count > policy!.workers)) throw Error(`并发数应为1至${policy!.workers}的整数。`);
          return mutate("workgroupStart", { plan, admission, ...(count === undefined ? {} : { workers: count }) });
        }} />}
        <div className="flex flex-col gap-1" aria-label="工作组列表">{groups.map(group => <Button key={group.id} data-testid={`workgroup-${group.id}`} variant={selected === group.id ? "secondary" : "ghost"} className="h-auto justify-start whitespace-normal text-left" onClick={() => select(group.id)}>{group.objective} · {status[group.status] ?? group.status}</Button>)}{!groups.length && !reading && <p>此项目尚无工作组。</p>}</div>
        {record && <div data-testid="workgroup-detail" className="flex flex-col gap-3 rounded-control border border-border p-3">
          <h3 className="font-medium">{record.objective}</h3><p role="status">{status[record.status] ?? record.status}</p>
          {workflowOrigins[detail.id] && <p>本机启动模板：{workflowOrigins[detail.id].displayName} · {workflowOrigins[detail.id].id}@{workflowOrigins[detail.id].revision}</p>}
          {profileWorkflow && <p>预设关联模板：{profileWorkflow.id}@{profileWorkflow.revision} · 会话 {profileThread?.id}</p>}
          <p className="text-foreground-subtle">版本 {record.revision} · 计划版本 {record.planRevision} · {record.wallSeconds?.toFixed(1)}秒</p>
          <p>资源清理：{record.cleanupConfirmed === true ? "已确认" : record.cleanupConfirmed === false ? "未完成" : "待确认"}</p>
          {record.error && <p className="text-destructive">{record.error}</p>}{record.cleanupError && <p className="text-destructive">{record.cleanupError}</p>}
          {record.tasks.map((task: Data) => <article key={task.spec.id} className="rounded-control border border-border p-2"><h4>{task.spec.id} · {status[task.status] ?? task.status}</h4><p>{task.spec.instruction}</p><p className="text-foreground-subtle">执行依赖：{task.spec.depends?.join("、") || "无"} · 集成依赖：{task.spec.integrationDepends?.join("、") || "无"}</p>{task.artifact && <p>{record.status === "completed" && record.finalCheck?.passed && record.cleanupConfirmed === true ? "阶段产物已纳入已验证结果" : "阶段候选产物，尚未作为已验证结果提供应用"}</p>}{task.feedback && <pre className="whitespace-pre-wrap break-words">{task.feedback}</pre>}</article>)}
          {record.finalChecks?.map((check: Data, index: number) => <details key={index}><summary>检查 {index + 1}：{check.passed ? "通过" : "未通过"}</summary><pre className="whitespace-pre-wrap break-words">{check.output}</pre></details>)}
          {record.finalCheck && <details><summary>最终检查：{record.finalCheck.passed ? "通过" : "未通过"}</summary><pre className="whitespace-pre-wrap break-words">{record.finalCheck.output}</pre></details>}
          {record.status === "running" && !record.tasks.every((task: Data) => task.status === "integrated") && <Button size="sm" variant="outline" disabled={disabled || !!detailError} onClick={() => void editPlan()}>修订工作组计划</Button>}
          {!terminal.has(record.status) && (!confirmCancel ? <Button variant="outline" size="sm" disabled={controlDisabled} onClick={() => setConfirmCancel(true)}>取消工作组</Button> : <div role="group" aria-label="取消工作组确认"><p>取消执行并等待资源清理？</p><Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>继续运行</Button><Button size="sm" disabled={controlDisabled} onClick={() => void mutate("workgroupCancel", { id: detail.id })}>确认取消工作组</Button></div>)}
          {record.status === "completed" && record.cleanupConfirmed === true && record.finalCheck?.passed && <Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => void artifacts()}>查看产物</Button>}
          {paths && <div>{paths.paths.map((path: string) => <Button key={path} size="sm" variant="ghost" disabled={busy} onClick={() => void readFile(path)}>{path}</Button>)}{!paths.complete && <Button size="sm" disabled={busy} onClick={() => void artifacts(true)}>更多产物</Button>}{!paths.paths.length && <p>没有文件变化。</p>}</div>}
          {file && <div><p role="status">{file.complete ? "产物内容已完整读取" : `产物已读取 ${file.nextOffset} / ${file.bytes} 字节，尚不完整`}</p><div className="mb-2 flex flex-col gap-2">
            {applyError && <p role="alert" className="text-destructive">{applyError}</p>}
            {artifactPending && !busy && <p role="alert">应用结果待核对：{artifactPending.path}。请核对该文件的当前状态，不会自动重发。</p>}
            {applyState === "matches" && <p role="status">当前文件与此产物一致。</p>}
            {applyState === "ready" && <p role="status">当前文件符合工作组基线。</p>}
            {applyState === "conflict" && <p role="alert">文件已变化，与工作组基线不一致；请先处理冲突。</p>}
            <p className="text-foreground-subtle">兼容产物只提供查看和基线核对。新的修改任务在普通输入区提交，由 Core 验证并交付整组改动。</p>
            <Button size="sm" variant="ghost" disabled={busy || !connected} onClick={() => void inspectFile()}>核对文件状态</Button>
          </div><p>{file.path} · {file.bytes}字节{file.exists ? "" : " · 已删除"}</p><details><summary>文件校验值</summary><p className="break-all">原文件：{file.baseSha256 ?? "不存在"}</p><p className="break-all">产物：{file.sha256 ?? "不存在"}</p></details>{file.preview === null ? <p>二进制内容不支持文本预览。</p> : <pre data-testid="workgroup-artifact-text" className="whitespace-pre-wrap break-words">{file.preview}</pre>}{!file.complete && <Button size="sm" disabled={busy} onClick={() => void readFile(file.path, true)}>继续读取文件</Button>}</div>}
        </div>}
      </>}
    </div>
  </section>;
}
