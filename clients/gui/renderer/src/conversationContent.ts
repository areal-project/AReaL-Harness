import { projectGenUiReferences, type GenUiPart } from "@areal/gen-ui/references";
import { projectNativeContent, contentToText, type ContentBlock } from "@areal/ui/content";

export type ConversationContentBlock = ContentBlock | { kind: "interactive"; reference: Extract<GenUiPart, { kind: "ui" }>["reference"]; offset: number; raw: string };

// 共享展示投影只读原消息；制品校验与实际页面生命周期仍由原宿主拥有。
export function projectConversationContent(source: string, completed: boolean, streaming = !completed): ConversationContentBlock[] {
  const blocks: ConversationContentBlock[] = [];
  let cursor = 0;
  for (const part of projectGenUiReferences(source, completed)) {
    if (part.kind === "text") {
      for (const block of projectNativeContent(part.text, streaming)) blocks.push({ ...block, offset: block.offset + cursor });
      cursor += part.text.length;
    } else {
      blocks.push(part.kind === "ui" ? { kind: "interactive", reference: part.reference, offset: part.offset, raw: part.raw } : { kind: part.kind === "pending" && streaming ? "pending" : "unsupported", offset: part.offset, raw: part.raw });
      cursor = part.offset + part.raw.length;
    }
  }
  return blocks;
}
export function conversationContentToText(blocks: readonly ConversationContentBlock[]): string {
  return blocks.map(block => block.kind === "interactive" ? `[互动内容：${block.reference.title ?? "交互回答"}]` : contentToText([block])).join("");
}
