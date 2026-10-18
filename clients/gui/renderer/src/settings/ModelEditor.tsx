import { useId, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Feedback } from "../components/ui/feedback.js";
import { SettingsDialog } from "./common.js";
import type { Data } from "../services.js";
import "./ModelEditor.css";

export function ModelEditor({ model, editing, ids, onSave, onClose }: {
  model: Data; editing: boolean; ids: string[]; onSave: (model: Data) => void; onClose: () => void;
}) {
  const [id, setId] = useState(model.id ?? "");
  const [name, setName] = useState(model.displayName ?? "");
  const [maximum, setMaximum] = useState(String(model.parameters?.maxOutputTokens ?? ""));
  const [temperature, setTemperature] = useState(String(model.parameters?.temperature ?? ""));
  const [effort, setEffort] = useState(model.parameters?.reasoningEffort ?? "");
  const [error, setError] = useState("");
  const [invalidField, setInvalidField] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const idInput = useRef<HTMLInputElement>(null);
  const maximumInput = useRef<HTMLInputElement>(null);
  const temperatureInput = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const dirty = id !== (model.id ?? "") || name !== (model.displayName ?? "")
    || maximum !== String(model.parameters?.maxOutputTokens ?? "")
    || temperature !== String(model.parameters?.temperature ?? "")
    || effort !== (model.parameters?.reasoningEffort ?? "");
  const requestClose = () => dirty ? setConfirmDiscard(true) : onClose();
  const invalid = (field: string) => ({
    "aria-invalid": invalidField === field || undefined,
    "aria-describedby": invalidField === field ? errorId : undefined,
  });
  const fail = (field: string, message: string, input: HTMLInputElement | null) => {
    setInvalidField(field);
    setError(message);
    input?.focus();
  };
  return <SettingsDialog title={editing ? "编辑模型" : "添加模型"} description="为模型设置独立名称和生成参数。" onClose={requestClose}>
    <form className="model-editor" noValidate onSubmit={e => {
      e.preventDefault();
      if (!id.trim() || ids.includes(id.trim())) { fail("id", "模型 ID 不能为空或重复", idInput.current); return; }
      if (maximumInput.current?.validity.badInput || (maximum && (!Number.isSafeInteger(Number(maximum)) || Number(maximum) <= 0))) {
        fail("maximum", "最大输出必须是正整数", maximumInput.current); return;
      }
      if (temperatureInput.current?.validity.badInput || (temperature && (!Number.isFinite(Number(temperature)) || Number(temperature) < 0 || Number(temperature) > 2))) {
        fail("temperature", "温度须在 0 到 2 之间", temperatureInput.current); return;
      }
      onSave({ ...model, id: id.trim(), displayName: name.trim(), parameters: {
        ...(maximum ? { maxOutputTokens: Number(maximum) } : {}),
        ...(temperature ? { temperature: Number(temperature) } : {}),
        ...(effort ? { reasoningEffort: effort } : {}),
      } });
    }}>
      <div className="model-editor-grid">
        <label>模型 ID<Input ref={idInput} {...invalid("id")} aria-label="模型 ID" required maxLength={256} placeholder="服务提供的模型 ID" value={id} onChange={e => setId(e.target.value)} /></label>
        <label>显示名称<Input aria-label="显示名称" maxLength={128} placeholder="留空使用模型 ID" value={name} onChange={e => setName(e.target.value)} /></label>
      </div>
      <section className="model-editor-parameters" aria-label="模型生成参数">
        <h3>生成参数</h3><p>留空沿用供应商默认值。保存供应商后，新任务或重新选择此模型时生效。</p>
        <div className="model-editor-grid">
          <label>最大输出 Token<Input ref={maximumInput} {...invalid("maximum")} aria-label="模型最大输出 Token" type="number" min={1} step={1} placeholder="供应商默认" value={maximum} onChange={e => setMaximum(e.target.value)} /></label>
          <label>温度<Input ref={temperatureInput} {...invalid("temperature")} aria-label="模型温度" type="number" min={0} max={2} step="any" placeholder="供应商默认" value={temperature} onChange={e => setTemperature(e.target.value)} /></label>
        </div>
        <label className="model-editor-effort"><span>推理强度<small>仅适用于支持推理参数的模型</small></span><select aria-label="模型推理强度" value={effort} onChange={e => setEffort(e.target.value)}><option value="">供应商默认</option><option value="none">无</option><option value="minimal">最低</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">最高</option></select></label>
      </section>
      <Feedback id={errorId} error={error} />
      <footer><Button type="button" variant="outline" onClick={requestClose}>取消</Button><Button type="submit">保存模型</Button></footer>
    </form>
    {confirmDiscard && <SettingsDialog title="放弃模型修改？" description="尚未保存的模型名称和生成参数将丢失。" onClose={() => setConfirmDiscard(false)}>
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => setConfirmDiscard(false)}>继续编辑</Button>
        <Button variant="destructive" onClick={onClose}>放弃修改</Button>
      </div>
    </SettingsDialog>}
  </SettingsDialog>;
}
