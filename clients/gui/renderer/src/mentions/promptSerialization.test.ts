import { describe, expect, it } from "vite-plus/test";
import { createEditor, $getRoot } from "lexical";
import { PromptMentionNode, $isPromptMentionNode } from "./nodes/PromptMentionNode.js";
import {
  $createPromptParagraph,
  $getPromptMarkdown,
  createPromptMarkdownReader,
} from "./promptSerialization.js";
import { buildFileMentionMarkdown, parseMentionMarkdown } from "./mentionMarkdown.js";

function restore(markdown: string) {
  const editor = createEditor({
    nodes: [PromptMentionNode],
    onError: (error) => {
      throw error;
    },
  });
  editor.update(
    () => {
      $getRoot().append($createPromptParagraph(markdown));
    },
    { discrete: true },
  );
  return editor.getEditorState().read(() => ({
    markdown: $getPromptMarkdown(),
    mentions: $getRoot()
      .getAllTextNodes()
      .filter($isPromptMentionNode)
      .map((node) => node.getMention()),
  }));
}

describe("native directory markdown restoration", () => {
  it("reuses unchanged paragraphs and invalidates ancestors across edits and undo states", () => {
    const editor = createEditor({
      nodes: [PromptMentionNode],
      onError: (error) => {
        throw error;
      },
    });
    const reader = createPromptMarkdownReader();
    editor.update(
      () => {
        $getRoot().append($createPromptParagraph("stable"), $createPromptParagraph("editable"));
      },
      { discrete: true },
    );
    const first = editor.getEditorState();
    expect(reader.read(first)).toBe("stable\n\neditable");
    const stop = editor.registerUpdateListener(
      ({ editorState, prevEditorState, dirtyElements }) => {
        reader.invalidate(prevEditorState, dirtyElements.keys());
        reader.invalidate(editorState, dirtyElements.keys());
      },
    );
    editor.update(
      () => {
        $getRoot().getAllTextNodes().at(-1)!.setTextContent("changed");
      },
      { discrete: true },
    );
    expect(reader.read(editor.getEditorState())).toBe("stable\n\nchanged");
    editor.setEditorState(first);
    expect(reader.read(editor.getEditorState())).toBe("stable\n\neditable");
    editor.update(
      () => {
        $getRoot().getFirstChild()!.remove();
      },
      { discrete: true },
    );
    expect(reader.read(editor.getEditorState())).toBe("editable");
    stop();
  });
  it.each([
    "/external/me/中文 design (v2)#1",
    "/external/me/ folder>name\\tail ",
    "/external/me/@name",
    "/external/me/$name",
    "/external/me/literal%20%23",
    "/",
    "C:\\Users\\me\\design notes (v2)#1",
    "\\\\host\\share\\notes",
  ])("round trips the exact absolute directory %s", (path) => {
    const name = path.startsWith("/") ? path.split("/").at(-1) || path : "notes";
    const markdown = buildFileMentionMarkdown(path, name, "directory");
    const restored = restore(`Review ${markdown} please`);
    expect(restored.markdown).toBe(`Review ${markdown} please`);
    expect(restored.mentions).toHaveLength(1);
    expect(restored.mentions[0]).toMatchObject({
      category: "files",
      label: name,
      value: path,
      data: { path, kind: "directory" },
    });
    expect(restored.mentions[0].data).not.toHaveProperty("relativePath");
    expect(parseMentionMarkdown(markdown)).toEqual([{ type: "directory", label: name }]);
  });

  it("keeps old relative, plugin and session references and excludes web links", () => {
    const text =
      "[notes](./docs/notes/) [file](./src/index.ts) [@Tool](plugin://tool@store) [#chat](#sess_chat) [web](https://example.com/dir/)";
    const restored = restore(text);
    expect(restored.markdown).toBe(text);
    expect(restored.mentions.map((mention) => [mention.category, mention.value])).toEqual([
      ["files", "docs/notes/"],
      ["files", "src/index.ts"],
      ["plugins", "tool@store"],
      ["sessions", "chat"],
    ]);
    expect(restored.mentions[0].data).toEqual({ relativePath: "docs/notes/", kind: "directory" });
  });

  it("protects relative paths containing parentheses without changing their value", () => {
    const text = buildFileMentionMarkdown("docs/中文 (v2)#1", "中文 (v2)#1", "directory");
    expect(restore(text).mentions[0].data).toEqual({
      relativePath: "docs/中文 (v2)#1/",
      kind: "directory",
    });
    expect(parseMentionMarkdown(text)).toEqual([{ type: "directory", label: "中文 (v2)#1" }]);
  });
});
