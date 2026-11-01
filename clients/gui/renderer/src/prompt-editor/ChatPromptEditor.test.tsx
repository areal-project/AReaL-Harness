import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LexicalChatInput } from "../LexicalChatInput.js";
import type { ComposerFileReferenceInput } from "../lib/workspaceFileComposer.js";
import { ChatPromptEditor } from "./ChatPromptEditor.js";

type EditorProps = ComponentProps<typeof ChatPromptEditor>;
const observed = vi.hoisted(() => ({
  input: undefined as ComponentProps<typeof LexicalChatInput> | undefined,
}));
vi.mock("@/LexicalChatInput.js", () => ({
  LexicalChatInput: (props: ComponentProps<typeof LexicalChatInput>) => {
    observed.input = props;
    return null;
  },
}));
vi.mock("./ComposerSurface.js", () => ({
  ComposerSurface: ({ editor }: { editor: ReturnType<typeof createElement> }) => editor,
  ComposerToolbar: () => null,
}));
vi.mock("@/prompt-editor/useComposerToolbarFit.js", () => ({
  useComposerToolbarFit: () => ({ current: null }),
}));
vi.mock("@/desktop-services.js", () => ({ droppedFilePath: vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
  UiMessageError: class extends Error {
    constructor(public descriptor: { id: string }) {
      super(descriptor.id);
    }
  },
}));

function clipboard(entries: { file: File; directory: boolean }[]) {
  const items = entries.map(({ file, directory }) => ({
    kind: "file",
    getAsFile: vi.fn(() => file),
    webkitGetAsEntry: vi.fn(() => ({ isDirectory: directory })),
  }));
  return {
    event: {
      clipboardData: {
        types: entries.length ? ["Files"] : ["text/plain"],
        files: entries.map(({ file }) => file),
        items,
      } as unknown as DataTransfer,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    },
    items,
  };
}

function render(overrides: Partial<EditorProps> = {}) {
  const onPaste = vi.fn();
  const onFileDrop = vi.fn();
  const resolveWorkspaceDirectory = vi.fn((file: File | null): ComposerFileReferenceInput => ({
    source: "native-local-directory",
    path: file ? `/external/${file.name}` : null,
  }));
  renderToStaticMarkup(
    createElement(ChatPromptEditor, {
      workspacePath: "/workspace",
      taskId: "thread",
      submitLabel: "Send",
      enableExternalFileDrop: true,
      enableWorkspaceFileDrop: true,
      validateWorkspaceFile: vi.fn(),
      resolveWorkspaceDirectory,
      onSubmit: vi.fn(),
      onPaste,
      onFileDrop,
      ...overrides,
    }),
  );
  return { onPaste, onFileDrop, resolveWorkspaceDirectory, paste: observed.input!.onPaste! };
}

describe("composer native file paste intake", () => {
  beforeEach(() => {
    observed.input = undefined;
  });

  it("resolves a pasted directory before it can enter attachment preparation", () => {
    const fixture = render();
    const folder = new File([], "design notes");
    const transfer = clipboard([{ file: folder, directory: true }]);
    fixture.paste(transfer.event);
    expect(transfer.event.preventDefault).toHaveBeenCalled();
    expect(fixture.resolveWorkspaceDirectory).toHaveBeenCalledWith(folder);
    expect(fixture.onPaste).not.toHaveBeenCalled();
    expect(fixture.onFileDrop).not.toHaveBeenCalled();
    expect(transfer.items[0].webkitGetAsEntry).toHaveBeenCalledTimes(1);
  });

  it.each(["image.png", "notes.txt"])("keeps ordinary %s on the existing paste path", (name) => {
    const fixture = render();
    const transfer = clipboard([{ file: new File(["file"], name), directory: false }]);
    fixture.paste(transfer.event);
    expect(fixture.onPaste).toHaveBeenCalledWith(transfer.event);
    expect(fixture.onFileDrop).not.toHaveBeenCalled();
    expect(fixture.resolveWorkspaceDirectory).not.toHaveBeenCalled();
    expect(transfer.event.preventDefault).not.toHaveBeenCalled();
  });

  it("keeps plain text on the existing paste path", () => {
    const fixture = render();
    const transfer = clipboard([]);
    fixture.paste(transfer.event);
    expect(fixture.onPaste).toHaveBeenCalledWith(transfer.event);
    expect(transfer.event.preventDefault).not.toHaveBeenCalled();
  });

  it("routes a mixed transfer to directory references and ordinary file intake", () => {
    const fixture = render();
    const transfer = clipboard([
      { file: new File([], "folder"), directory: true },
      { file: new File(["file"], "notes.txt"), directory: false },
    ]);
    fixture.paste(transfer.event);
    expect(transfer.event.preventDefault).toHaveBeenCalled();
    expect(fixture.resolveWorkspaceDirectory).toHaveBeenCalledWith(
      transfer.event.clipboardData.files[0],
    );
    expect(fixture.onPaste).not.toHaveBeenCalled();
    expect(fixture.onFileDrop).toHaveBeenCalledWith([transfer.event.clipboardData.files[1]]);
  });

  it("accepts external directory intake without treating it as an attachment", () => {
    const resolveWorkspaceDirectory = vi.fn((): ComposerFileReferenceInput => ({
      source: "native-local-directory",
      path: "/other-workspace/folder",
    }));
    const fixture = render({ resolveWorkspaceDirectory });
    const transfer = clipboard([{ file: new File([], "folder"), directory: true }]);
    fixture.paste(transfer.event);
    expect(resolveWorkspaceDirectory).toHaveBeenCalled();
    expect(fixture.onPaste).not.toHaveBeenCalled();
    expect(fixture.onFileDrop).not.toHaveBeenCalled();
  });

  it("consumes directories when native directory resolution is unavailable", () => {
    const fixture = render({ resolveWorkspaceDirectory: undefined });
    const transfer = clipboard([{ file: new File([], "folder"), directory: true }]);
    fixture.paste(transfer.event);
    expect(transfer.event.preventDefault).toHaveBeenCalled();
    expect(fixture.onPaste).not.toHaveBeenCalled();
  });

  it("keeps ordinary files when native directory resolution is unavailable", () => {
    const fixture = render({ resolveWorkspaceDirectory: undefined });
    const file = new File(["file"], "notes.txt");
    const transfer = clipboard([
      { file: new File([], "folder"), directory: true },
      { file, directory: false },
    ]);
    fixture.paste(transfer.event);
    expect(transfer.event.preventDefault).toHaveBeenCalled();
    expect(fixture.onFileDrop).toHaveBeenCalledWith([file]);
    expect(fixture.onPaste).not.toHaveBeenCalled();
  });

  it("does not resolve or attach a directory while the composer is disabled", () => {
    const fixture = render({ disabled: true });
    const transfer = clipboard([{ file: new File([], "folder"), directory: true }]);
    fixture.paste(transfer.event);
    expect(fixture.resolveWorkspaceDirectory).not.toHaveBeenCalled();
    expect(fixture.onPaste).not.toHaveBeenCalled();
    expect(fixture.onFileDrop).not.toHaveBeenCalled();
  });
});
