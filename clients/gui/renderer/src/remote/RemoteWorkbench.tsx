import { ComposerActionButton } from "@areal/ui/wip";
import {ApplicationIntlProvider} from "../i18n/IntlProvider.js";
import {createRoot} from 'react-dom/client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {Messages} from '../Messages.js';
import {ConversationComposer} from '../ConversationComposer.js';
import {ComposerPermissionMenu} from '../ComposerPermissionMenu.js';
import {ComposerQueue} from '../ComposerQueue.js';
import {GoalCard} from '../Goal.js';
import {Button} from '../components/ui/button.js';
import {TooltipProvider} from '../components/ui/tooltip.js';
import {ControlHintTooltip} from '../ControlHintTooltip.js';
import {ProjectFolderIcon,ProjectOpenFolderIcon,ProjectNewChatIcon} from '../homeChromeIcons.js';
import {GoalIcon,SendMessageIcon,StopIcon} from '../interfaceIcons.js';
import {permissionMode,permissionOptions} from '../permissions.js';
import {useAppearance,useApplicationPreferences} from '../settings/applicationPreferences.js';
import {shouldSteer} from '../settings/applicationSettings.js';
import type {Action,CommandName,Data} from '../services.js';
import type {LexicalChatInputHandle} from '../LexicalChatInput.js';
import '../styles.css';
import '../workbench.css';
import './remote.css';

type API={attention:(projectId:string,item:Data)=>Promise<void>;pause:(projectId:string,row:Data)=>Promise<void>;select:(id:string,force?:boolean)=>Promise<void>;open:(projectId:string,threadId:string)=>Promise<void>;create:(id:string)=>Promise<void>;more:()=>void;close:()=>void;draft:(value:string)=>void;send:(enqueue:boolean)=>Promise<Data|undefined>;stop:()=>Promise<Data|undefined>;control:(operation:string,values:Data,revision:number)=>Promise<Data|undefined>;query:()=>void;review:(turnId:string)=>void;history:()=>void;retryBody:()=>void};
type View={sessionOpen:boolean;connected:boolean;projects:Data[];selectedProject?:string;groups:Record<string,{rows:Data[];error?:string;hasMore:boolean}>;detail?:Data;turns?:Data[];draft:string;canSubmit:boolean;canInterrupt:boolean;canReview:boolean;blocked:boolean;sendDisabled:boolean;stopDisabled:boolean;notice:string;unknown:boolean;error:string;loading:boolean;bodyError?:string;bodyLoading?:boolean};
function useRemoteTheme(){
  const dark=matchMedia('(prefers-color-scheme: dark)').matches;
  useAppearance(dark);
  useLayoutEffect(()=>{const root=document.documentElement;root.classList.toggle('dark',dark);root.classList.toggle('theme-areal-light',!dark);root.classList.toggle('theme-areal-dark',dark);root.style.colorScheme=dark?'dark':'light';},[dark]);
  return dark;
}
function Home({view,api}:{view:View;api:API}){
  useRemoteTheme();
  const [collapsed,setCollapsed]=useState<Record<string,boolean>>({});
  const [visibleCounts,setVisibleCounts]=useState<Record<string,number>>({});
  return <TooltipProvider><div className="remote-project-heading"><h2>Projects</h2></div>
    {view.notice&&<p role="status">{view.notice}</p>}
    <nav aria-label="项目与会话">{view.projects.map((p,index)=>{
      const closed=collapsed[p.projectId]??index!==0;
      const group=view.groups[p.projectId];
      const sessions=[...new Map((group?.rows??[]).filter(r=>r.threadId).map(r=>[r.threadId,r])).values()];
      const tasks=(group?.rows??[]).filter(row=>row.kind==='taskRun');
      const visibleCount=visibleCounts[p.projectId]??5;
      const listId=`remote-project-sessions-${p.projectId}`;
      return <section className="remote-project-group" key={p.projectId}><div className="remote-project-header"><Button variant="ghost" className="remote-project-row" aria-expanded={!closed} aria-controls={listId} onClick={()=>{setCollapsed(c=>({...c,[p.projectId]:!closed}));setVisibleCounts(c=>({...c,[p.projectId]:5}));if(closed)void api.select(p.projectId);}}>{closed?<ProjectFolderIcon width={21} height={21}/>:<ProjectOpenFolderIcon width={21} height={21}/>}<span>{p.name}</span></Button><Button variant="ghost" size="icon" className="remote-project-create" aria-label={`在项目 ${p.name} 中新建会话`} title={`在项目 ${p.name} 中新建会话`} disabled={!view.canSubmit} onClick={()=>void api.create(p.projectId)}><ProjectNewChatIcon width={22} height={22}/></Button></div>
        {!closed&&<div id={listId} className="remote-session-list">{group?.error&&<p role="alert">{group.error}<Button variant="ghost" onClick={()=>void api.select(p.projectId,true)}>重试</Button></p>}{sessions.slice(0,visibleCount).map(row=><Button key={row.threadId} variant="ghost" className="remote-session-row" data-thread-id={row.threadId} onClick={()=>void api.open(p.projectId,row.threadId)}>{row.title||'未命名会话'}</Button>)}{tasks.map(row=><section key={`${row.taskId}/${row.runId}`} aria-label={row.title||'Task'}><p>{row.title||'Task'} · {row.execution.state}</p>{(row.attentionRefs??[]).map((item:Data,index:number)=><Button key={index} variant="ghost" onClick={()=>void api.attention(p.projectId,item)}>审阅待处理事项</Button>)}<Button variant="ghost" onClick={()=>void api.pause(p.projectId,row)}>审阅暂停 Task</Button></section>)}{(group?.rows??[]).filter(row=>row.kind==='thread').flatMap(row=>(row.attentionRefs??[]).map((item:Data,index:number)=><Button key={`${row.threadId}/${index}`} variant="ghost" onClick={()=>void api.attention(p.projectId,item)}>审阅待处理事项</Button>))}{!group?<p role="status">正在读取会话…</p>:!sessions.length&&!tasks.length&&!group.error?<p>暂无会话</p>:null}{sessions.length>visibleCount&&<Button variant="ghost" className="remote-session-more" onClick={()=>setVisibleCounts(c=>({...c,[p.projectId]:(c[p.projectId]??5)+5}))}>Show more</Button>}{group?.hasMore&&sessions.length<=visibleCount&&<Button variant="ghost" className="remote-session-more" onClick={()=>{setVisibleCounts(c=>({...c,[p.projectId]:visibleCount+5}));void api.select(p.projectId).then(api.more);}}>加载更多</Button>}</div>}
      </section>;
    })}</nav></TooltipProvider>;
}
function projectedTurns(turns:Data[]=[]){return turns.map(turn=>({...turn,items:turn.items.map((item:Data)=>{
  if(item.body)return {...item,...item.body};
  const body=item.preview??'';
  if(item.type==='userMessage')return {...item,content:[{type:'text',text:body}]};
  if(item.type==='agentMessage')return {...item,text:body};
  if(item.type==='reasoning')return {...item,summary:[body],content:[]};
  if(item.type==='dynamicToolCall')return {...item,arguments:{},contentItems:[{type:'inputText',text:body}],execution:{outcome:item.executionOutcome??'unknown'}};
  return {...item,text:body};
})}));}
function Session({view,api}:{view:View;api:API}){
  const dark=useRemoteTheme();
  const prefs=useApplicationPreferences();
  const apiRef=useRef<LexicalChatInputHandle|null>(null);
  const live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const [goalMode,setGoalMode]=useState(false);
  const [localError,setLocalError]=useState('');
  const [editing,setEditing]=useState<Data|null>(null);
  useEffect(()=>{if(apiRef.current&&apiRef.current.getMarkdown()!==view.draft)apiRef.current.setText(view.draft);},[view.draft]);
  const s=view.detail?.snapshot;
  if(!s)return <div role="status">{view.error||'正在读取会话…'}</div>;
  const project:Data={id:view.detail!.projectId,root:'',pending:view.blocked?[{params:{threadId:s.threadId}}]:[],models:s.models??[],core:{features:{}},state:{connected:view.connected&&view.canSubmit,queues:{[s.threadId]:s.queue},interactions:{},threads:{}}};
  const thread:Data={id:s.threadId,title:s.title,turns:projectedTurns(view.turns),goals:s.goals,desktop:{archived:false}};
  const running=!!s.activeTurnId;
  const config=s.configuration;
  const disabled=!view.connected||!view.canSubmit||s.ownership.kind!=='ordinary'||view.blocked;
  const control=async(operation:string,values:Data,revision:number)=>{
    const result=await api.control(operation,values,revision);
    if(result?.admissionState!=='accepted')throw new Error(result?.error?.message??'结果未确认，请先核对原操作');
    return result;
  };
  // Remote 仅处理 manage 与 queueEdit；其余 Action 重载保持明确拒绝。
  const action=(async(name:CommandName,params?:Data)=>{
    if(name==='manage'&&params?.operation==='goal')return {};
    if(name==='manage'&&['goalPause','goalResume','goalClear'].includes(params?.operation))return control(params!.operation,{goalId:params!.goalId},params!.expectedRevision);
    if(name==='queueEdit')return control(`queue${params!.operation[0].toUpperCase()+params!.operation.slice(1)}`,Object.fromEntries(['queueItemId','queueItemIds','expectedTurnId'].filter(k=>params![k]!==undefined).map(k=>[k,params![k]])),params!.expectedRevision);
    throw new Error('此操作请在桌面处理');
  }) as Action;
  async function submit(value:string,invert=false){
    if(!value.trim()||disabled)return false;
    setLocalError('');
    try{
      if(editing){await control('queueUpdate',{queueItemId:editing.id,text:value},s.queue.revision);if(live.current){setEditing(null);api.draft('');}}
      else if(goalMode){await control('goalCreate',{objective:value,inferLimits:true},s.goals?.revision??0);if(live.current){setGoalMode(false);api.draft('');}}
      else if(running&&shouldSteer(prefs.followUp,invert)){await control('steer',{text:value,expectedTurnId:s.activeTurnId},s.configRevision);if(live.current)api.draft('');}
      else await api.send(running);
    }catch(error){setLocalError((error as Error).message);}
    return false;
  }
  return <TooltipProvider><header className="remote-chat-heading" data-thread-id={s.threadId} data-config-revision={s.configRevision} data-ownership={s.ownership.kind} data-task-id={s.ownership.taskId} data-status={s.status} data-queue-count={s.queue.pendingCount} data-queue-paused={s.queue.paused}><Button variant="ghost" size="sm" onClick={api.close}>返回项目列表</Button><span>{view.projects.find(p=>p.projectId===project.id)?.name}</span></header><h2 className="remote-chat-title">{s.title||'会话'}</h2>
    {view.error&&<p role="alert">{view.error}</p>}
    {view.bodyLoading&&<p role="status">正在同步完整正文…</p>}
    {view.bodyError&&<p role="alert">{view.bodyError}<Button variant="ghost" onClick={api.retryBody}>重新读取正文</Button></p>}
    <Messages project={project} thread={thread} action={action} dark={dark} reserveResponseSpace={false} onLink={url=>window.open(url,'_blank','noopener,noreferrer')} onFile={()=>setLocalError('文件请在桌面查看')} onReview={api.review} readTurnReview={async()=>({})}/>
    {s.history?.hasMore&&<Button variant="ghost" onClick={api.history}>更早历史</Button>}
    <div className="remote-gui-composer composer-dock"><GoalCard project={{...project,state:{...project.state,connected:project.state.connected&&s.goalControlAllowed}}} thread={thread} action={action} onEdit={()=>setLocalError('目标编辑请在桌面完成')}/>
      <ComposerQueue project={project} thread={thread} action={action} disabled={disabled||s.queue.complete===false} editingId={editing?.id} onEdit={item=>{if(item.truncated||item.hasAttachments){setLocalError('此排队消息请在桌面编辑');return;}setEditing(item);api.draft(item.input.map((p:Data)=>p.text).join('\n'));}}/>
      {s.queue.complete===false&&<p role="status">队列未完整加载，请在桌面管理。</p>}
      <ConversationComposer project={project} modelConfig={config} modelDisabled={disabled||running||!!editing||!config} onConfigureModel={values=>{void control('configure',values,s.configRevision).catch(error=>setLocalError(error.message));}} workspacePath="" taskId={s.threadId} inputApiRef={apiRef} inputTestId="remote-chat-input" submitTestId="remote-chat-send" initialValue={view.draft} placeholder={goalMode?'描述目标，明确可衡量的结果':'随心输入'} disabled={disabled} submitDisabled={disabled||!view.draft.trim()||!running&&!goalMode&&!editing&&view.sendDisabled} submitLabel={editing?'保存排队消息':goalMode?'开始目标':'发送'} enterSubmits={prefs.sendShortcut==='enter'} enableMentionPanel={false} onChange={api.draft} onSubmit={value=>{void submit(value);return false;}} onModifiedSubmit={value=>{void submit(value,!!running);return false;}} onCancel={running&&view.canInterrupt?()=>void api.stop():undefined}
        composerCatalog={{entries:!s.goals?.goal?[{value:'goal',label:'设置目标',description:'设置持续目标与停止条件',icon:<GoalIcon/>,group:'功能',disabled:disabled||running||!!editing,run:()=>setGoalMode(true)}]:[],refresh:()=>{}}}
        leadingActions={<><ComposerPermissionMenu value={permissionMode(config??{})} configuration={config} permissionsSupported={s.permissionCapabilities?.supported===true} fullAccessAvailable={s.permissionCapabilities?.fullAccessAvailable===true} disabled={disabled||running||!!editing||!config} lockedReadOnly={config?.profile?.readOnly||permissionMode(config??{})==='readOnly'} onChange={mode=>{const options=permissionOptions(mode,config?.options);void control('configure',{options},s.configRevision).catch(error=>setLocalError(error.message));}} onClose={()=>apiRef.current?.focus()}/>{goalMode&&<Button variant="ghost" size="sm" aria-label="退出目标模式" onClick={()=>setGoalMode(false)}><GoalIcon/>目标</Button>}</>}
        topContent={editing?<div className="composer-queue-edit-banner"><span>编辑排队消息</span><Button variant="ghost" size="sm" onClick={()=>{if(live.current){setEditing(null);api.draft('');}}}>取消</Button></div>:undefined}
        submitControl={running&&!editing?(view.draft.trim()?<ControlHintTooltip title="发送"><ComposerActionButton type="button" size="icon" className="composer-primary-action" aria-label="发送" data-testid="remote-chat-send" disabled={disabled} onClick={event=>void submit(view.draft,event.metaKey||event.ctrlKey)}><SendMessageIcon/></ComposerActionButton></ControlHintTooltip>:<Button type="button" variant="secondary" size="icon" className="composer-primary-action composer-stop-action" aria-label="停止" disabled={view.stopDisabled} onClick={()=>void api.stop()}><StopIcon/></Button>):undefined}/>
      {(localError||view.notice)&&<p role={localError?'alert':'status'}>{localError||view.notice}</p>}{view.unknown&&<Button variant="outline" size="sm" onClick={api.query}>核对原操作</Button>}
    </div></TooltipProvider>;
}
export function createRemoteWorkbench(api:API){
  const home=createRoot(document.getElementById('remote-projects')!);
  const session=createRoot(document.getElementById('remote-session-ui')!);
  return {render(view:View){home.render(<ApplicationIntlProvider><Home view={view} api={api}/></ApplicationIntlProvider>);session.render(<ApplicationIntlProvider>{view.detail?<Session key={`${view.detail.projectId}/${view.detail.snapshot.threadId}`} view={view} api={api}/>:view.sessionOpen?<><header className="remote-chat-heading"><Button variant="ghost" size="sm" onClick={api.close}>返回项目列表</Button></header><p role={view.error?'alert':'status'}>{view.error||'正在读取会话…'}</p></>:null}</ApplicationIntlProvider>);}};
}
