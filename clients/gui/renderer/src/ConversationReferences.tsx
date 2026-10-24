import { SideChatIcon } from "./interfaceIcons.js";
import { buildSessionMentionMarkdown } from "./mentions/mentionMarkdown.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";

export interface ConversationReference {
  threadId: string;
  title: string;
  updatedAt: number;
}

export function conversationReferenceEntries(
  references: readonly ConversationReference[],
  description: string,
): ComposerCatalogEntry[] {
  return references.map(({ threadId, title }) => ({
    value: `session:${threadId}`,
    label: title,
    description,
    group: "会话",
    icon: <SideChatIcon size={16} />,
    mention: {
      id: `session:${threadId}`, category: "sessions", label: title, value: threadId,
      markdown: buildSessionMentionMarkdown(threadId, title),
    },
    run: () => {},
  }));
}
