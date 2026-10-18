import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Switch } from "../components/ui/switch.js";
import type { Data } from "../services.js";
import { EmptySettings, Feedback, type SettingsProps } from "./common.js";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "./SettingsPageParts.js";
import { useDraftBlocker } from "./UnsavedChanges.js";

const storageKeyFor = (projectId?: string, threadId?: string) => `areal-gui:thread-config:${projectId}:${threadId}`;
const skillKey = (skill: Data) => `${skill.id}/${skill.revision}`;
const modelValue = (model: Data | null | undefined) => model?.providerId && model?.modelId ? `${model.providerId}/${model.modelId}` : "";
const parseModel = (value: string) => {
  const slash = value.indexOf("/");
  return slash > 0 ? { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) } : null;
};
const parseSkill = (value: string) => {
  const slash = value.indexOf("/");
  return { id: value.slice(0, slash), revision: value.slice(slash + 1) };
};
const fromConfig = (configuration: Data): Data => {
  const skills = (configuration.selectedSkills ?? []).map(skillKey);
  return {
    baseRevision: configuration.revision,
    model: configuration.model ? { providerId: configuration.model.providerId, modelId: configuration.model.modelId } : null,
    skillMode: skills.length ? "custom" : "profile",
    skills,
    options: { ...(configuration.options ?? {}) },
    parameters: { ...(configuration.parameters ?? {}) },
    unknown: false,
  };
};
const readStored = (key: string) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    return value && Number.isSafeInteger(value.baseRevision) ? value : null;
  } catch { return null; }
};
const wireOptions = (options: Data, readOnly: boolean) => ({
  ...options,
  readOnly,
  appendInstructions: options.appendInstructions ?? "",
  maxModelRounds: options.maxModelRounds ?? null,
  systemPrompt: options.systemPrompt ?? null,
  toolAllowlist: options.toolAllowlist ?? null,
  approvalTools: options.approvalTools ?? [],
  preapprovedTools: options.preapprovedTools ?? [],
});
const wireParameters = (parameters: Data, clear: boolean) => clear ? {} : {
  temperature: parameters?.temperature ?? null,
  maxOutputTokens: parameters?.maxOutputTokens ?? null,
  reasoningEffort: parameters?.reasoningEffort ?? null,
  ...(parameters?.reasoningSummary != null ? { reasoningSummary: parameters.reasoningSummary } : {}),
};

/** 会话配置只影响 Core 接受后的后续轮次。草稿和未知结果留在本页，不自动重发。 */
export function SessionSettings({ project, thread, action }: SettingsProps) {
  const configuration = thread && project.configurations?.[thread.id];
  const storageKey = storageKeyFor(project?.id, thread?.id);
  const ready = useRef(false);
  const clean = useRef("");
  const saveRef = useRef<(revision: number, overrides?: Data) => Promise<void>>(async () => { throw new Error("请先选择任务，以编辑会话配置。"); });
  const [draft, setDraft] = useState<Data | null>(null);
  const [conflict, setConflict] = useState(false);
  const [readback, setReadback] = useState<Data | null>(null);
  const [rereadRevision, setRereadRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const threadPending = (project?.pending ?? []).filter((entry: Data) => entry.params?.threadId === thread?.id);
  const pendingConfig = threadPending.some((entry: Data) => entry.method === "areal/thread/configure" && !entry.awaitingResponse);
  const unknown = !!draft?.unknown || pendingConfig;
  const running = !!thread?.turns?.some((turn: Data) => turn.status === "inProgress");
  const fieldsDisabled = busy || !!thread?.desktop?.archived || running || threadPending.length > 0;
  useEffect(() => {
    if (ready.current || !configuration) return;
    ready.current = true;
    const stored = readStored(storageKey);
    const opened = fromConfig(configuration);
    clean.current = JSON.stringify(opened);
    if (stored && (stored.unknown || stored.baseRevision !== configuration.revision)) {
      setDraft(stored);
      setConflict(stored.baseRevision !== configuration.revision);
      return;
    }
    setDraft(stored ?? opened);
  }, [configuration, storageKey]);
  useEffect(() => {
    if (draft) localStorage.setItem(storageKey, JSON.stringify(draft));
  }, [draft, storageKey]);
  const dirty = !!draft && clean.current !== "" && JSON.stringify({ ...draft, unknown: false }) !== clean.current;
  useDraftBlocker({
    label: "会话配置",
    dirty,
    busy,
    discard: () => {
      localStorage.removeItem(storageKey);
      if (configuration) {
        const next = fromConfig(configuration);
        clean.current = JSON.stringify(next);
        setDraft(next);
      }
      setConflict(false);
      setError("");
      setMessage("");
      setReadback(null);
      setRereadRevision(null);
    },
    save: async () => {
      if (unknown) throw new Error("配置结果待核对，不会自动重发。");
      if (conflict) throw new Error("会话配置已变化，请重新读取后再决定是否提交。草稿已保留。");
      await saveRef.current(draft?.baseRevision);
    },
  });
  if (!thread || !configuration || !draft) return <EmptySettings>请先选择任务，以编辑会话配置。</EmptySettings>;
  const profileLocked = configuration.profile?.readOnly === true;
  const profileSkills: Data[] = configuration.profile?.skills ?? [];
  const models = (project.models ?? []).filter((model: Data) => model.providerId && model.modelId && model.available !== false);
  if (draft.model && !models.some((model: Data) => model.providerId === draft.model.providerId && model.modelId === draft.model.modelId)) models.unshift(draft.model);
  const selectedSkills = draft.skillMode === "profile" ? [] : (draft.skills as string[]).map(parseSkill);
  const applyLatest = (latest: Data, notice: string) => {
    const next = fromConfig(latest);
    clean.current = JSON.stringify(next);
    setDraft(next);
    setConflict(false);
    setRereadRevision(null);
    setReadback(latest);
    setError("");
    setMessage(notice);
  };
  const payloadFor = (revision: number, overrides: Data = {}) => {
    const clear = overrides.clear === true;
    const skills = overrides.selectedSkills ?? (clear ? [] : selectedSkills);
    if (!clear && draft.skillMode === "custom" && skills.length === 0) throw new Error("请至少选择一个技能，或改回使用预设全部技能。");
    return {
      projectId: project.id,
      threadId: thread.id,
      expectedRevision: revision,
      model: overrides.model !== undefined ? overrides.model : clear ? null : draft.model,
      parameters: wireParameters(overrides.parameters ?? draft.parameters, clear),
      options: wireOptions(overrides.options ?? draft.options, profileLocked || (!clear && draft.options.readOnly === true)),
      selectedSkills: skills,
    };
  };
  saveRef.current = async (revision: number, overrides: Data = {}) => {
    setBusy(true);
    setError("");
    try {
      await action("configure", payloadFor(revision, overrides));
      const latest = await action("manage", { projectId: project.id, threadId: thread.id, operation: "inspect" });
      if (!latest?.configuration) throw new Error("会话配置已保存，但读回失败。请重新读取。");
      applyLatest(latest.configuration, "会话配置已保存");
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (failure.submissionUnknown) {
        setDraft(current => current ? { ...current, unknown: true } : current);
        setError("");
        setMessage("");
        return;
      }
      if (/已变化|conflict/i.test(failure.message)) {
        setConflict(true);
        setError("会话配置已变化，请重新读取后再决定是否提交。草稿已保留。");
        return;
      }
      setError(failure.message);
    } finally { setBusy(false); }
  };
  const update = (patch: Data) => setDraft(current => current ? { ...current, ...patch, unknown: false } : current);
  const read = async () => {
    setBusy(true);
    setError("");
    try {
      const latest = await action("manage", { projectId: project.id, threadId: thread.id, operation: "inspect" });
      setReadback(latest.configuration);
      setRereadRevision(latest.configuration.revision);
      setMessage("已读回当前会话配置。草稿仍保留，可以重新提交或采用最新配置。");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true);
    setError("");
    try {
      await action("reconcile", { projectId: project.id });
      const latest = await action("manage", { projectId: project.id, threadId: thread.id, operation: "inspect" });
      setReadback(latest.configuration);
      setMessage("已读回当前会话配置。未自动重发未确认的修改。");
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <form className="settings-form" noValidate onSubmit={event => { event.preventDefault(); if (!fieldsDisabled && !conflict) void saveRef.current(draft.baseRevision); }}>
      <fieldset disabled={fieldsDisabled} className="m-0 space-y-6 border-0 p-0">
        <SettingsSection title="会话模型" description="只影响之后的新消息。选择预设或服务默认会清除会话模型覆盖。">
          <SettingsGroupCard>
            <SettingsRow label="模型" description="可选模型来自当前 Core 目录。已入队消息保留加入时的模型。" control={
              <select aria-label="会话模型" value={modelValue(draft.model)} onChange={event => update({ model: parseModel(event.target.value) })}>
                <option value="">预设或服务默认</option>
                {models.map((model: Data) => <option key={modelValue(model)} value={modelValue(model)}>{model.displayName || model.modelId}</option>)}
              </select>
            } />
          </SettingsGroupCard>
        </SettingsSection>
        <SettingsSection title="会话权限与安全" description="只影响之后的新消息。已入队消息配置保持不变；部署与预设的权限上限仍生效。">
          <SettingsGroupCard>
            <SettingsRow label="只读模式" description={profileLocked ? "只读预设不能放宽为可写，部署权限也不会被会话配置扩大。" : "限制写操作与高危行为，具体工具权限由 Core 判定。"} control={
              <Switch aria-label="只读模式" checked={profileLocked || draft.options.readOnly === true} disabled={fieldsDisabled || profileLocked} onCheckedChange={readOnly => update({ options: { ...draft.options, readOnly } })} />
            } />
            <SettingsRow label="单轮最大模型调用次数" description="防止单轮次无限循环调用的安全上限（1 - 1024）。" control={
              <div className="flex items-center gap-1.5">
                <Input type="number" aria-label="单轮最大模型调用次数" min={1} max={1024} value={draft.options.maxModelRounds ?? ""} className="w-20 text-center" onChange={event => update({ options: { ...draft.options, maxModelRounds: event.target.value === "" ? null : Number(event.target.value) } })} />
                <span className="text-ui-sm text-foreground-subtle">次</span>
              </div>
            } />
          </SettingsGroupCard>
        </SettingsSection>
        <SettingsSection title="指令设置" description="为当前任务追加自定义系统指令。恢复默认会清除这段追加，不改写旧轮次。">
          <SettingsGroupCard>
            <div className="space-y-2 p-4">
              <div className="settings-field-label">附加指令</div>
              <textarea rows={4} aria-label="附加指令" value={draft.options.appendInstructions ?? ""} onChange={event => update({ options: { ...draft.options, appendInstructions: event.target.value } })} />
            </div>
          </SettingsGroupCard>
        </SettingsSection>
        <SettingsSection title="会话技能" description="只使用所选技能时，下一次执行采用这个子集。使用预设全部技能会清除会话覆盖。">
          <SettingsGroupCard>
            <div className="space-y-3 p-4">
              <select aria-label="会话技能范围" value={draft.skillMode} onChange={event => update({ skillMode: event.target.value, skills: event.target.value === "profile" ? [] : draft.skills })}>
                <option value="profile">使用预设全部技能</option>
                <option value="custom">只使用所选技能</option>
              </select>
              {draft.skillMode === "custom" && profileSkills.map(skill => {
                const key = skillKey(skill);
                return <label key={key} className="flex items-center gap-2"><input type="checkbox" aria-label={`${skill.id} · ${skill.revision}`} checked={draft.skills.includes(key)} onChange={event => update({ skills: event.target.checked ? [...draft.skills, key] : draft.skills.filter((item: string) => item !== key) })} />{skill.id} · {skill.revision}</label>;
              })}
              {draft.skillMode === "custom" && !profileSkills.length && <p>当前预设没有可选择的技能。</p>}
            </div>
          </SettingsGroupCard>
        </SettingsSection>
        <SettingsSection title="模型参数" description="留空表示交给目标模型的默认参数。恢复默认会清空会话参数覆盖。">
          <SettingsGroupCard>
            <SettingsRow label="温度 (Temperature)" description="采样随机性（0.0 - 2.0）。" control={
              <Input type="number" aria-label="温度" min={0} max={2} step={0.1} value={draft.parameters.temperature ?? ""} className="w-24 text-center" onChange={event => update({ parameters: { ...draft.parameters, temperature: event.target.value === "" ? null : Number(event.target.value) } })} />
            } />
            <SettingsRow label="最大输出 Token" description="单次模型响应允许生成的最大 Token 限制。" control={
              <Input type="number" aria-label="最大输出 Token" min={1} value={draft.parameters.maxOutputTokens ?? ""} className="w-24 text-center" onChange={event => update({ parameters: { ...draft.parameters, maxOutputTokens: event.target.value === "" ? null : Number(event.target.value) } })} />
            } />
          </SettingsGroupCard>
        </SettingsSection>
      </fieldset>
      {running && <p role="status">任务正在执行，完成或停止后才能修改配置。</p>}
      {thread.desktop?.archived && <p role="status">已归档任务只读，不能修改会话配置。</p>}
      {unknown && <p role="status">配置结果待核对。草稿已保留，不会自动重发。</p>}
      <Feedback error={error} message={message} />
      <div className="settings-form-actions">
        <Button type="submit" disabled={fieldsDisabled || conflict}>保存会话配置</Button>
        <Button type="button" variant="outline" disabled={fieldsDisabled || conflict} onClick={() => void saveRef.current(draft.baseRevision, { clear: true, model: null, selectedSkills: [], options: { ...draft.options, readOnly: profileLocked, appendInstructions: "", maxModelRounds: null } })}>恢复默认配置</Button>
        {conflict && <Button type="button" variant="outline" disabled={busy} onClick={() => void read()}>重新读取</Button>}
        {conflict && <Button type="button" disabled={busy || rereadRevision == null} onClick={() => void saveRef.current(rereadRevision as number)}>用当前草稿重新提交</Button>}
        {conflict && <Button type="button" variant="outline" disabled={busy || !readback} onClick={() => applyLatest(readback as Data, "已采用最新配置。尚未再次保存。")}>采用最新配置</Button>}
        {unknown && <Button type="button" variant="outline" disabled={busy} onClick={() => void verify()}>核对会话配置</Button>}
      </div>
      {readback && <section aria-label="已读回的会话配置">
        <p>版本：{readback.revision}</p>
        <p>模型：{readback.model ? `${readback.model.providerId}/${readback.model.modelId}` : "预设或服务默认"}</p>
        <p>附加指令：{readback.options?.appendInstructions || "无"}</p>
        <p>技能：{readback.selectedSkills?.length ? readback.selectedSkills.map((skill: Data) => `${skill.id} · ${skill.revision}`).join("、") : "预设全部技能"}</p>
        <p>单轮最大模型调用次数：{readback.options?.maxModelRounds ?? "未限制"}</p>
        <p>温度：{readback.parameters?.temperature ?? "默认"}</p>
        <p>最大输出 Token：{readback.parameters?.maxOutputTokens ?? "默认"}</p>
        <p>只读：{readback.readOnly === true ? "是" : "否"}</p>
      </section>}
    </form>
  );
}
