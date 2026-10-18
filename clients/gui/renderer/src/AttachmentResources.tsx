import { useRef, useState } from 'react';
import { Button } from './components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './components/ui/dialog.js';
import type { Action } from './services.js';

type Upload = { uri: string; mimeType: string; sizeBytes: number };
export function AttachmentResources({ projectId, threadId, action, connected, archived, pending }: {
  projectId: string; threadId: string; action: Action; connected: boolean; archived: boolean; pending: boolean;
}) {
  const [open, setOpen] = useState(false), [uploads, setUploads] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const locked = useRef(false), picker = useRef<HTMLInputElement>(null);
  const read = async () => {
    const result = await action('media', { projectId, threadId, operation: 'list' });
    setUploads(result.uploads);
  };
  const run = async (operation: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (cause) { setError((cause as Error).message); }
    finally { locked.current = false; setBusy(false); }
  };
  return <>
    <Button size="sm" variant="ghost" disabled={!connected} onClick={() => { setOpen(true); void run(read); }}>管理已上传附件</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl">
        <DialogTitle>已上传附件</DialogTitle>
        <DialogDescription>此会话的上传记录。释放仅放弃上传所有权；普通与归档历史仍保留，空间由 Core 安全回收。</DialogDescription>
        <Button size="sm" variant="outline" disabled={busy || !connected} onClick={() => void run(read)}>刷新上传记录</Button>
        {!archived && <><Button size="sm" variant="outline" disabled={busy || !connected || pending} onClick={() => picker.current?.click()}>上传待用附件</Button><input ref={picker} className="hidden" aria-label="上传待用附件" type="file" disabled={busy || !connected || pending} onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void run(async () => {
            await action('media', { projectId, threadId, operation: 'upload', mime: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) });
            await read(); setNotice('已上传，尚未加入消息。可释放此上传记录。');
          });
        }} /></>}
        {archived && <p>归档会话只读，不能释放附件。</p>}
        <div className="max-h-64 overflow-y-auto">
          {uploads.map(upload => <div key={upload.uri} className="py-2" data-blob-uri={upload.uri}>
            <p className="break-all">{upload.uri}</p><p>{upload.mimeType} · {upload.sizeBytes} B</p>
            <Button size="sm" variant="outline" disabled={busy || !connected || archived || pending} onClick={() => void run(async () => {
              const result = await action('media', { projectId, threadId, operation: 'release', uri: upload.uri });
              if (result.released !== true) throw new Error('释放结果待核对；请刷新上传记录，不会自动重发。');
              setNotice('上传所有权已释放；实际空间需安全回收。'); await read();
            })}>释放附件</Button>
          </div>)}
          {!busy && !uploads.length && <p>没有上传记录。</p>}
        </div>
        {notice && <p role="status">{notice}</p>}
        {error && <p role="alert">{error}</p>}
      </DialogContent>
    </Dialog>
  </>;
}
