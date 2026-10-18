import {useRef,useState} from 'react';
import {Button} from './components/ui/button.js';
import {Input} from './components/ui/input.js';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription} from './components/ui/dialog.js';
import {attachmentDrafts} from './Composer.js';
import type {Action,Data} from './services.js';

type Draft = {source:'head'|'working-tree'|'branch';ref:string;requestId?:string};
type Receipt = {state:'missing'|'creating'|'created'|'failed';message?:string;record?:{directory:string;branch:string;base:string}};
export function WorktreeStarter({project,action,onOpen}:{project:Data;action:Action;onOpen:(id:string)=>Promise<void>}) {
  const key=`areal-gui:worktree:${project.id}`;
  const [draft,setDraft]=useState<Draft>(()=>{try {const d=JSON.parse(localStorage.getItem(key)??'null');if(d&&['head','working-tree','branch'].includes(d.source)&&typeof d.ref==='string')return d;}catch{}return {source:'head',ref:''};});
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[receipt,setReceipt]=useState<Receipt>();
  const locked=useRef(false);
  const update=(value:Draft)=>{localStorage.setItem(key,JSON.stringify(value));setDraft(value);};
  const run=async(work:()=>Promise<void>)=>{if(locked.current)return;locked.current=true;setBusy(true);setError('');try{await work();}catch(e){setError((e as Error).message);}finally{locked.current=false;setBusy(false);}};
  const accept=(result:Receipt)=>{
    setReceipt(result);
    if(result.state==='failed'){update({source:draft.source,ref:draft.ref});setError(result.message??'工作树创建失败');}
    else if(result.state==='creating'||result.state==='missing')setError('创建结果尚未确认。请稍后核对，不会重复创建工作树。');
  };
  const create=()=>run(async()=>{const requestId=crypto.randomUUID();update({...draft,requestId});setReceipt(undefined);accept(await action('workspace',{projectId:project.id,operation:'worktreeCreate',requestId,source:draft.source,ref:draft.ref}));});
  const recover=()=>run(async()=>accept(await action('workspace',{projectId:project.id,operation:'worktreeRead',requestId:draft.requestId})));
  const enter=()=>run(async()=>{
    const result=await action('workspace',{projectId:project.id,operation:'worktreeOpen',requestId:draft.requestId});
    // Copy the current source draft only into an empty destination. Retain the
    // original so switching back or an interrupted navigation cannot lose input.
    const from=`areal-gui:draft:${project.id}:new`,to=`areal-gui:draft:${result.projectId}:new`;
    if(localStorage.getItem(to)===null){
      for(const suffix of ['',':permission',':plan']){const value=localStorage.getItem(from+suffix);if(value!==null)localStorage.setItem(to+suffix,value);}
      const model=localStorage.getItem(`areal-gui:model:${project.id}`);if(model!==null)localStorage.setItem(`areal-gui:model:${result.projectId}`,model);
      if(attachmentDrafts.has(from))attachmentDrafts.set(to,[...attachmentDrafts.get(from)!]);
    }
    await onOpen(result.projectId);setOpen(false);
  });
  return <>
    <Button variant="ghost" size="sm" disabled={!project.state?.connected} onClick={()=>setOpen(true)} aria-label="创建工作树">工作树</Button>
    <Dialog open={open} onOpenChange={value=>{if(!busy)setOpen(value);}}>
      <DialogContent className="max-w-[480px]" showCloseButton={!busy}>
        <DialogHeader><DialogTitle>创建工作树</DialogTitle><DialogDescription>在独立目录中开始任务。原项目的文件与暂存区保持不变。</DialogDescription></DialogHeader>
        <label className="grid gap-2">起始状态<select aria-label="起始状态" className="rounded-control border border-control bg-transparent px-3 py-2" disabled={busy||!!draft.requestId} value={draft.source} onChange={e=>update({...draft,source:e.target.value as Draft['source']})}>
          <option value="head">当前提交（HEAD）</option><option value="working-tree">包含未提交的改动</option><option value="branch">指定分支或提交</option>
        </select></label>
        {draft.source==='branch'&&<label className="grid gap-2">分支或提交<Input aria-label="分支或提交" value={draft.ref} disabled={busy||!!draft.requestId} onChange={e=>update({...draft,ref:e.target.value})}/></label>}
        {draft.source==='working-tree'&&<p className="text-ui-caption text-foreground-subtle">包括已跟踪与未忽略的新文件；忽略文件遵循项目的 .worktreeinclude 配置。</p>}
        <p className="text-ui-caption text-foreground-subtle">首次打开会复制项目管理的 Skills、启用偏好和 MCP 配置。之后可独立修改，MCP 连接需单独开启。</p>
        {error&&<p role="alert" className="text-destructive text-ui-caption break-words">{error}</p>}
        {receipt?.state==='created'&&<div className="grid gap-1 text-ui-caption"><span>工作树已创建</span><code className="break-all">{receipt.record?.directory}</code><span className="text-foreground-subtle">{receipt.record?.branch}</span></div>}
        <div className="flex justify-end gap-2">
          {receipt?.state==='created'?<><Button variant="ghost" disabled={busy} onClick={()=>{update({source:draft.source,ref:draft.ref});setReceipt(undefined);setError('');}}>创建另一个工作树</Button><Button disabled={busy} onClick={()=>void enter()}>在工作树中新建任务</Button></>:draft.requestId?<Button disabled={busy} onClick={()=>void recover()}>核对创建结果</Button>:<Button disabled={busy||(draft.source==='branch'&&!draft.ref.trim())} onClick={()=>void create()}>创建</Button>}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
