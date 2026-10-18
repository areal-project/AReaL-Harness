import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from './components/ui/button.js';
import type { RegionDraft } from './BrowserRegionAnnotation.js';
import './BrowserRegionAnnotation.css';

export function BrowserKeyboardElementPicker({ capture, busy, onSelect, onCancel }: {
  capture: RegionDraft['capture'];
  busy: boolean;
  onSelect: (x: number, y: number) => void;
  onCancel: () => void;
}) {
  const { bitmapWidth: width, bitmapHeight: height } = capture.viewport;
  const [x, setX] = useState(String(Math.floor(width / 2)));
  const [y, setY] = useState(String(Math.floor(height / 2)));
  const first = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (!busy) first.current?.focus();
  }, [busy]);
  const valid = x !== '' && y !== '' && Number.isSafeInteger(Number(x)) && Number.isSafeInteger(Number(y))
    && Number(x) >= 0 && Number(x) < width && Number(y) >= 0 && Number(y) < height;
  return <form className="browser-region-annotation" aria-label="键盘选择元素"
    onSubmit={event => { event.preventDefault(); if (!busy && valid) onSelect(Number(x), Number(y)); }}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) { if (event.key === 'Enter') event.preventDefault(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onCancel(); }
    }}>
    <strong>键盘选择元素</strong>
    <p>输入截图像素坐标（左上角为 0, 0），上下方向键微调。Enter 确认，Escape 取消。</p>
    <div className="browser-region-image-wrap">
      <img src={`data:image/png;base64,${capture.imageBase64}`} alt="当前页面的隐私保护截图" />
      {valid && <span aria-hidden="true" style={{ position: 'absolute', left: `${Number(x) / width * 100}%`,
        top: `${Number(y) / height * 100}%`, width: 12, height: 12, transform: 'translate(-50%, -50%)',
        border: '2px solid #fff', outline: '2px solid #111', borderRadius: '50%', pointerEvents: 'none' }} />}
    </div>
    <div className="browser-region-coordinates">
      <label>元素横坐标<input ref={first} type="number" min={0} max={width - 1} step={1} required value={x}
        disabled={busy} onChange={event => setX(event.target.value)} /></label>
      <label>元素纵坐标<input type="number" min={0} max={height - 1} step={1} required value={y}
        disabled={busy} onChange={event => setY(event.target.value)} /></label>
    </div>
    <span role="status">截图尺寸：{width} × {height}；选择不会发送消息。</span>
    <div className="browser-region-actions">
      <Button type="submit" size="sm" disabled={busy || !valid}>选择此位置的元素</Button>
      <Button type="button" size="sm" disabled={busy} onClick={onCancel}>取消元素选择</Button>
    </div>
  </form>;
}
