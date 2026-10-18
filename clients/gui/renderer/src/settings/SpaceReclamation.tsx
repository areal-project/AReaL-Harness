import { useRef, useState } from 'react';
import { Button } from '../components/ui/button.js';
import { SettingsRow } from './SettingsPageParts.js';
import type { Action } from '../services.js';

type Operation = 'serverDrain' | 'serverGc';
export function SpaceReclamation({ projectId, action, disabled, onChange }: {
  projectId: string; action: Action; disabled: boolean; onChange: () => Promise<void>;
}) {
  const prefix = `areal-gui:space-maintenance:${projectId}:`;
  const hasUnconfirmed = () => Object.keys(localStorage).some(key => key.startsWith(prefix));
  const [unconfirmed, setUnconfirmed] = useState(hasUnconfirmed);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const run = async (operation: Operation) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    const key = `${prefix}${crypto.randomUUID()}`;
    try {
      // Retain uncertainty if the Renderer goes away after dispatch. This is UI
      // recovery state, never an execution journal or a reason to replay.
      // Each invocation owns its marker. A later successful operation cannot
      // erase an earlier unknown result, even for the same maintenance action.
      localStorage.setItem(key, operation);
      const result = await action('manage', { projectId, operation });
      if (operation === 'serverDrain') {
        if (result.draining !== true || result.restartSafe !== true) throw new Error('Core 尚未完成收敛，请检查执行与资源状态。');
        setNotice('Core 已完成收敛，可以回收空间。');
      } else {
        if (!['deletedBlobs', 'reclaimedBytes', 'retainedBytes'].every(field => Number.isSafeInteger(result[field]) && result[field] >= 0)) {
          throw Object.assign(new Error('回收结果不完整，实际释放空间待核对。'), { submissionUnknown: true });
        }
        setNotice(`已回收 ${result.reclaimedBytes} B（${result.deletedBlobs} 个附件），保留 ${result.retainedBytes} B。`);
      }
      localStorage.removeItem(key);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      setError(failure.message);
      if (!failure.submissionUnknown) localStorage.removeItem(key);
      else setNotice('维护操作结果待核对；不会自动重发，也不能确认已释放空间。');
    } finally { setUnconfirmed(hasUnconfirmed()); locked.current = false; setBusy(false); await onChange(); }
  };
  return <div aria-label="空间回收" className="mt-4">
    <SettingsRow label="空间回收" description="先停止接收新工作，再回收未引用附件。正在执行或有未结算资源时会拒绝；保留普通与归档历史。维护后请停止后台并重新连接，以恢复接收工作。"
      control={<div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run('serverDrain')}>停止接收新工作</Button>
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run('serverGc')}>回收未引用附件</Button>
      </div>} />
    {busy && <p role="status">正在处理空间维护…</p>}
    {notice && <p role="status">{notice}</p>}
    {unconfirmed && !busy && <p role="status">上次维护操作结果待核对；不会自动重发。</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </div>;
}
