import {
  $createParagraphNode,
  $createTextNode,
  $createLineBreakNode,
  type ParagraphNode,
  $getCharacterOffsets,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type LexicalNode,
  type RangeSelection,
} from "lexical";
import {
  $createPromptMentionNode,
  $isPromptMentionNode,
} from "@/mentions/nodes/PromptMentionNode.js";

import { parsePluginStableId, parseSessionThreadId } from "./mentionMarkdown.js";

/** 编辑器文本用于光标；业务输出显式读取 canonical，不能覆写 TextNode 文本语义。 */
export function $getPromptMarkdown(node: LexicalNode = $getRoot()): string {
  if ($isPromptMentionNode(node)) return node.getMarkdown();
  if (!$isElementNode(node)) return node.getTextContent();
  const children = node.getChildren();
  return children
    .map(
      (child, index) =>
        $getPromptMarkdown(child) +
        ($isElementNode(child) && !child.isInline() && index < children.length - 1 ? "\n\n" : ""),
    )
    .join("");
}

/** 与 Lexical RangeSelection 的段落/端点规则一致，仅将实际选中的 token 换为 canonical。 */
export function $getPromptSelectionMarkdown(selection: RangeSelection): string {
  if (selection.isCollapsed()) return "";
  const nodes = selection.getNodes();
  const [anchorOffset, focusOffset] = $getCharacterOffsets(selection);
  const forward = selection.anchor.isBefore(selection.focus);
  const start = forward ? anchorOffset : focusOffset;
  const end = forward ? focusOffset : anchorOffset;
  let result = "";
  let previousWasElement = true;
  for (const [index, node] of nodes.entries()) {
    if ($isElementNode(node) && !node.isInline()) {
      if (!previousWasElement) result += "\n";
      previousWasElement = !node.isEmpty();
      continue;
    }
    previousWasElement = false;
    let text = node.getTextContent();
    if ($isTextNode(node)) {
      let from = index === 0 ? start : 0;
      let to = index === nodes.length - 1 ? end : text.length;
      // 两个 element point 包住同一个文本节点时，offset 是子节点索引而不是字符。
      if (
        nodes.length === 1 &&
        selection.anchor.type === "element" &&
        selection.focus.type === "element" &&
        selection.anchor.offset !== selection.focus.offset
      ) {
        from = 0;
        to = text.length;
      }
      text = text.slice(from, to);
      if (text && $isPromptMentionNode(node)) text = node.getMarkdown();
    }
    result += text;
  }
  return result;
}

/** 剪切与复制都将相交 token 视为整体，但不能扩张仅触碰边界的选区。 */
export function $getAtomicPromptSelection(selection: RangeSelection): RangeSelection {
  const normalized = selection.clone();
  if (normalized.isCollapsed()) return normalized;
  const [start, end] = normalized.isBackward()
    ? [normalized.focus, normalized.anchor]
    : [normalized.anchor, normalized.focus];
  const startNode = start.getNode();
  const endNode = end.getNode();
  if (
    start.type === "text" &&
    $isPromptMentionNode(startNode) &&
    start.offset < startNode.getTextContentSize()
  ) {
    start.set(start.key, 0, "text");
  }
  if (end.type === "text" && $isPromptMentionNode(endNode) && end.offset > 0) {
    end.set(end.key, endNode.getTextContentSize(), "text");
  }
  return normalized;
}

// Literal TextNode newlines do not produce a final empty line, and adjacent
// zero-margin Paragraph nodes collapse a canonical double newline visually.
// Match keyboard/paste line boxes without changing the serialized draft text.
export function $appendPromptTextLines(paragraph: ParagraphNode, text: string) {
  for (const [index, line] of text.split("\n").entries()) {
    if (index) paragraph.append($createLineBreakNode());
    if (line) paragraph.append($createTextNode(line));
  }
}

export const INLINE_PROMPT_MENTION_PATTERN = /\[((?:\\.|[^\\\]])*)\]\(/g;

export function $createPromptParagraph(text: string) {
  const paragraph = $createParagraphNode();
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PROMPT_MENTION_PATTERN)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const destinationStart = start + match[0].length;
    const angleDestination = text[destinationStart] === "<";
    let depth = 1;
    let destinationEnd = destinationStart + (angleDestination ? 1 : 0);
    for (; destinationEnd < text.length; destinationEnd += 1) {
      const character = text[destinationEnd];
      if (character === "\\") {
        destinationEnd += 1;
        continue;
      }
      if (angleDestination) {
        if (character === ">") break;
        continue;
      }
      if (character === "(") depth += 1;
      if (character === ")" && --depth === 0) break;
    }
    if (destinationEnd >= text.length || (angleDestination && text[destinationEnd + 1] !== ")"))
      continue;
    const markdownEnd = destinationEnd + (angleDestination ? 2 : 1);
    const destination = text.slice(destinationStart + (angleDestination ? 1 : 0), destinationEnd);
    const pluginId = parsePluginStableId(destination);
    const threadId = parseSessionThreadId(destination);
    const relativePath =
      destination.startsWith("./") && !match[1]?.startsWith("$")
        ? destination.slice(2).replace(/\\(.)/g, "$1")
        : undefined;
    if (!pluginId && !threadId && !relativePath) continue;
    if (start > cursor) $appendPromptTextLines(paragraph, text.slice(cursor, start));
    const label = (match[1]?.replace(/\\(.)/g, "$1") ?? "").replace(
      pluginId ? /^@/ : threadId ? /^#/ : /^@/,
      "",
    );
    paragraph.append(
      $createPromptMentionNode({
        id: pluginId
          ? `plugin:${pluginId}`
          : threadId
            ? `session:${threadId}`
            : `file:${relativePath}`,
        category: pluginId ? "plugins" : threadId ? "sessions" : "files",
        label,
        value: pluginId ?? threadId ?? relativePath!,
        markdown: text.slice(start, markdownEnd),
        ...(pluginId
          ? { data: { pluginId } }
          : relativePath
            ? { data: { relativePath, kind: relativePath.endsWith("/") ? "directory" : "file" } }
            : {}),
      }),
    );
    cursor = markdownEnd;
  }
  if (cursor < text.length) $appendPromptTextLines(paragraph, text.slice(cursor));
  return paragraph;
}
