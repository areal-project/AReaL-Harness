import { useEffect, useState } from "react";
import { Messages } from "./Messages.js";
import { AgentAvatar, agentName, agentStatus } from "./AgentIdentity.js";
import type { Action, Data } from "./services.js";

/** 子对话复用权威投影与消息组件；标签关闭只关闭阅读视图。 */
export function AgentConversationPane({ project, parentId, childId, action, dark, onLink, onFile, onReview, onAgent }: {
  project: Data; parentId: string; childId: string; action: Action; dark: boolean;
  onLink: (url: string) => void; onFile: (path: string) => void; onReview: (threadId: string, turnId: string) => void; onAgent: (id: string) => void;
}) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, refresh] = useState(0);
  const thread = project.state?.threads[childId];
  const connected = !!project.state?.connected;
  useEffect(() => {
    let live = true;
    setLoading(true); setError("");
    if (!connected) { setLoading(false); return; }
    void action("open", { projectId: project.id, threadId: childId }).catch(cause => {
      if (live) setError((cause as Error).message);
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [project.id, childId, connected, action, revision]);
  // 迟到的旧任务投影不能成为当前标签的内容。
  const owned = thread?.id === childId && thread.parentThreadId === parentId;
  return <section className="agent-conversation-pane" data-agent-conversation={childId} aria-label={`${agentName(childId)} 子对话`}>
    <div className="agent-conversation-heading"><AgentAvatar id={childId} /><strong>{agentName(childId)}</strong><span role="status">{agentStatus(owned ? thread.turns?.at(-1)?.status : undefined)}</span></div>
    {!connected && <p className="agent-pane-notice" role="status">连接不可用，已显示的历史可能已过期。</p>}
    {error && <div className="agent-pane-notice" role="alert">{error}<button type="button" disabled={!connected || loading} onClick={() => refresh(n => n + 1)}>重新读取</button></div>}
    {owned ? <Messages project={project} thread={thread} action={action} dark={dark} onLink={onLink} onFile={onFile}
      onReview={turnId => onReview(childId, turnId)} onAgent={onAgent}
      readTurnReview={(turnId, itemId) => action("workspace", { projectId: project.id, threadId: childId, turnId, itemId, operation: "turnReview" })} />
      : !error && <p className="agent-pane-notice" role="status">{loading ? "正在读取子对话…" : "子对话不可用。"}</p>}
  </section>;
}
