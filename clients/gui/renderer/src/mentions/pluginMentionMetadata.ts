import type { LexicalEditor } from "lexical";
import { PROGRAMMATIC_UPDATE_TAG } from "../lib/editorUpdateTags.js";
import {
  $createPromptMentionNode,
  PromptMentionNode,
  type PromptMentionPayload,
} from "./nodes/PromptMentionNode.js";

export function registerPluginMentionMetadata(
  editor: LexicalEditor,
  mentions: readonly PromptMentionPayload[],
) {
  const stop = editor.registerNodeTransform(PromptMentionNode, (node) => {
    if (node.getMention().category !== "plugins") return;
    const mention = mentions.find((entry) => entry.value === node.getMention().value);
    if (
      mention &&
      (node.getMarkdown() !== mention.markdown ||
        (node.getMention().description ?? "") !== (mention.description ?? ""))
    )
      node.replace($createPromptMentionNode(mention));
  });
  editor.update(() => {}, { tag: PROGRAMMATIC_UPDATE_TAG });
  return stop;
}
