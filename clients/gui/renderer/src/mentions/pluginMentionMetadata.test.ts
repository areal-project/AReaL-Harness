import { describe, expect, it } from "vite-plus/test";
import { $getRoot, $getSelection, $isRangeSelection, createEditor } from "lexical";
import { PromptMentionNode, $isPromptMentionNode } from "./nodes/PromptMentionNode.js";
import { $createPromptParagraph, $getPromptMarkdown } from "./promptSerialization.js";
import { buildPluginMentionMarkdown } from "./mentionMarkdown.js";
import { registerPluginMentionMetadata } from "./pluginMentionMetadata.js";

const mention = (name: string) => ({
  id: "plugin:tool@market",
  category: "plugins" as const,
  label: name,
  value: "tool@market",
  markdown: buildPluginMentionMarkdown(name, "tool@market"),
  description: `${name} description`,
});

describe("plugin reference metadata", () => {
  it.each([true, false])("normalizes pasted references with a catalog loaded first=%s", (first) => {
    const editor = createEditor({
      nodes: [PromptMentionNode],
      onError(error) {
        throw error;
      },
    });
    const current = mention("Current name");
    let stop = first ? registerPluginMentionMetadata(editor, [current]) : () => {};
    let caretKey: string;
    editor.update(
      () => {
        const paragraph = $createPromptParagraph(
          `before ${buildPluginMentionMarkdown("Old label", current.value)} after [file](./file.ts)`,
        );
        $getRoot().append(paragraph);
        const tail = paragraph.getLastChild()!;
        tail.selectEnd();
        caretKey = tail.getKey();
      },
      { discrete: true },
    );
    if (!first) stop = registerPluginMentionMetadata(editor, [current]);
    editor.update(() => {}, { discrete: true });
    const read = () =>
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        return {
          markdown: $getPromptMarkdown(),
          mentions: $getRoot()
            .getAllTextNodes()
            .filter($isPromptMentionNode)
            .map((node) => node.getMention()),
          caret: $isRangeSelection(selection) ? selection.anchor.key : null,
        };
      });
    expect(read().markdown).toBe(`before ${current.markdown} after [file](./file.ts)`);
    expect(read().mentions[0]).toMatchObject(current);
    expect(read().caret).toBe(caretKey!);
    stop();
    const renamed = mention("Renamed tool");
    stop = registerPluginMentionMetadata(editor, [renamed]);
    editor.update(() => {}, { discrete: true });
    expect(read().markdown).toBe(`before ${renamed.markdown} after [file](./file.ts)`);
    expect(read().mentions[0]).toMatchObject(renamed);
    expect(read().caret).toBe(caretKey!);
    stop();
  });
});
