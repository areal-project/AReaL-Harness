import { parsePromptConversationSelections } from "./conversationSelectionReference.js";
import { ConversationSelectionReferences } from "./ConversationSelectionReferences.js";
import { stripGenUiModelContext } from "@areal/gen-ui/contract";
import { Box } from "lucide-react";
import { MessageResponse } from "./components/ai-elements/message.js";
import { formatSkillMentionDisplayLabel } from "./mentions/mentionMarkdown.js";

type UserMessageProjection = {
  text: string;
  skills: { name: string; source: string; id: string; revision: string }[];
};

const skillHeader = /^<skill name=("(?:[^"\\\r\n]|\\.)*") source=("(?:[^"\\\r\n]|\\.)*") id=("(?:[^"\\\r\n]|\\.)*") revision=("(?:[^"\\\r\n]|\\.)*")>\n/;

function skillSuffix(raw: string, start: number): UserMessageProjection["skills"] | undefined {
  const skills: UserMessageProjection["skills"] = [];
  let position = start;
  while (position < raw.length) {
    const header = skillHeader.exec(raw.slice(position));
    if (!header) return;
    try {
      const [name, source, id, revision] = header.slice(1).map(value => JSON.parse(value) as string);
      skills.push({ name, source, id, revision });
    } catch { return; }
    let close = raw.indexOf("\n</skill>", position + header[0].length);
    for (;;) {
      if (close < 0) return;
      const end = close + "\n</skill>".length;
      if (end === raw.length) return skills;
      if (raw.startsWith("\n\n<skill", end)) {
        position = end + 2;
        break;
      }
      close = raw.indexOf("\n</skill>", end);
    }
  }
}

function projectUserMessage(raw: string): UserMessageProjection {
  let offset = 0;
  let fence: { character: string; length: number } | undefined;
  for (const line of raw.split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker) {
      if (marker[1][0] !== "`" || !marker[2].includes("`")) fence = { character: marker[1][0], length: marker[1].length };
    } else if (line.startsWith("<skill ") && (offset === 0 || raw.slice(offset - 2, offset) === "\n\n")) {
      const skills = skillSuffix(raw, offset);
      return skills ? { text: raw.slice(0, offset === 0 ? 0 : offset - 2), skills } : { text: raw, skills: [] };
    }
    offset += line.length + 1;
  }
  return { text: raw, skills: [] };
}

export function UserMessageBody({ children, theme, onOpenExternalUrl, onOpenFileLink }: {
  children: string;
  theme: "light" | "dark";
  onOpenExternalUrl?: (url: string) => void;
  onOpenFileLink?: (path: string) => void;
}) {
  const selection = parsePromptConversationSelections(stripGenUiModelContext(children));
  const { text, skills } = projectUserMessage(selection.visibleContent);
  const markdown = <MessageResponse className="conversation-markdown user-message-body" preserveLineBreaks theme={theme}
    onOpenExternalUrl={onOpenExternalUrl} onOpenFileLink={onOpenFileLink}>{text}</MessageResponse>;
  if (!skills.length && !selection.references.length) return markdown;
  return <div className="user-message-with-skills">
    <ConversationSelectionReferences references={selection.references} />
    {skills.map((skill, index) => <span key={`${skill.source}:${skill.id}:${skill.revision}:${index}`} className="user-message-skill">
      <Box size={16} aria-hidden="true" />{formatSkillMentionDisplayLabel(skill.name)}
    </span>)}
    {text && markdown}
  </div>;
}
