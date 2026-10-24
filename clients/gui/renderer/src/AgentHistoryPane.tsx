import { useState } from "react";
import { AgentsPane } from "./AgentsPane.js";
import { AgentConversationPane } from "./AgentConversationPane.js";
import type { Action, Data } from "./services.js";

/** Reading navigation only; AgentsPane owns discovery and Core owns history. */
export function AgentHistoryPane({ project, thread, initialId, action, dark, onClose, onLink, onFile, onReview, onAgent }: {
  project: Data; thread: Data; initialId?: string; action: Action; dark: boolean; onClose: () => void;
  onLink: (url: string) => void; onFile: (path: string) => void; onReview: (threadId: string, turnId: string) => void; onAgent: (id: string) => void;
}) {
  const [selectedId, onSelect] = useState(initialId);
  return <AgentsPane project={project} thread={thread} action={action} onOpen={onSelect}
    reader={{ selectedId, onSelect, onClose, children: selectedId && <AgentConversationPane key={selectedId} project={project} parentId={thread.id}
      childId={selectedId} action={action} dark={dark} onLink={onLink} onFile={onFile} onReview={onReview} onAgent={onAgent} /> }} />;
}
