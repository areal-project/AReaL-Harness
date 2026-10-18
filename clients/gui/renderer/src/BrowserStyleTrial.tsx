import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button.js';
import type { RegionDraft } from './BrowserRegionAnnotation.js';
import './BrowserStyleTrial.css';

export interface StyleTrialDraft {
  trialId: string;
  before: RegionDraft['capture'];
  element: NonNullable<RegionDraft['element']>;
  edits: { property: string; before: string; after: string }[];
  canUndo: boolean;
  canRedo: boolean;
  stale: boolean;
  cleared?: boolean;
  intent: string;
  after?: { capture: RegionDraft['capture']; element: NonNullable<RegionDraft['element']> };
}
const choices = [
  ['text', '文字'], ['color', '文字颜色'], ['background-color', '背景颜色'],
  ['font-size', '字号'], ['font-weight', '字重'], ['font-family', '字体'],
  ['letter-spacing', '字距'], ['line-height', '行高'], ['margin', '外边距'],
  ['padding', '内边距'], ['width', '宽度'], ['height', '高度'],
] as const;

export function BrowserStyleTrial({ draft, busy, onApply, onUndo, onRedo, onIntent, onStage, onCancel }: {
  draft: StyleTrialDraft;
  busy: boolean;
  onApply: (property: string, value: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onIntent: (value: string) => void;
  onStage: () => void;
  onCancel: () => void;
}) {
  const [property, setProperty] = useState<string>('color');
  const [value, setValue] = useState('');
  const field = useRef<HTMLSelectElement>(null);
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!busy && !focused.current && field.current) {
      field.current.focus(); focused.current = true;
    }
  }, [busy]);
  return <section className="browser-style-trial" aria-label="页面试改"
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault(); event.stopPropagation();
        if (!busy && !draft.stale && draft.edits.length && draft.intent.trim()) onStage();
      }
    }}>
    <strong role="status">页面试改，未写入代码</strong>
    <span>{draft.element.role} · {draft.element.name || '无名称'} · 来源位置未知</span>
    {draft.stale && <span role="alert">应用已改变目标；请刷新页面，试改不能再回放。</span>}
    {draft.after && <span role="status">前后截图已冻结{draft.cleared ? '，试改已清除' : ''}。请将意图加入原聊天草稿。</span>}
    {!draft.after && <div className="browser-style-trial-fields">
      <label>属性<select ref={field} value={property} disabled={busy || draft.stale} onChange={event => setProperty(event.target.value)}>
        {choices.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>试改值<input value={value} disabled={busy || draft.stale} maxLength={500}
        onChange={event => setValue(event.target.value)} placeholder={property === 'text' ? '新文字' : '#336699 或 16px'} /></label>
      <Button type="button" size="sm" disabled={busy || draft.stale || !value} onClick={() => onApply(property, value)}>应用到页面</Button>
      <Button type="button" size="sm" disabled={busy || draft.stale || !draft.canUndo} onClick={onUndo}>撤销试改</Button>
      <Button type="button" size="sm" disabled={busy || draft.stale || !draft.canRedo} onClick={onRedo}>重做试改</Button>
    </div>}
    <label>希望 Agent 如何修改源码<textarea value={draft.intent} disabled={busy} onChange={event => onIntent(event.target.value)}
      placeholder="描述最终想保留的效果" /></label>
    <div className="browser-style-trial-actions">
      <Button type="button" size="sm" disabled={busy} onClick={onCancel}>取消并清除试改</Button>
      <Button type="button" size="sm" disabled={busy || draft.stale || !draft.edits.length || !draft.intent.trim()}
        onClick={onStage}>加入原聊天草稿</Button>
    </div>
  </section>;
}
