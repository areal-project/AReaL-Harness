import { projectNativeContent, contentToText, type ContentBlock } from "@areal/ui/content";

export type ConversationContentBlock = ContentBlock;

// 共享展示投影只读原消息；制品校验与实际页面生命周期仍由原宿主拥有。
export function projectConversationContent(
  source: string,
  _completed: boolean,
  streaming = !_completed,
): ConversationContentBlock[] {
  return projectNativeContent(source, streaming);
}
export function conversationContentToText(blocks: readonly ConversationContentBlock[]): string {
  return contentToText(blocks);
}
