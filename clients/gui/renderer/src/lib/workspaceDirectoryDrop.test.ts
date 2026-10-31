import { describe, expect, it, vi } from "vite-plus/test";
import { droppedWorkspaceDirectory } from "./workspaceFileComposer.js";
vi.mock("@/lib/workspaceFileDrag.js", () => ({ createWorkspaceFileComposerMention: vi.fn() }));
vi.mock("@/desktop-services.js", () => ({ droppedFilePath: vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  UiMessageError: class extends Error {
    constructor(public descriptor: { id: string }) {
      super(descriptor.id);
    }
  },
}));
describe("native folder references", () => {
  it("uses the current execution root and keeps folder names with spaces", () => {
    expect(
      droppedWorkspaceDirectory("/worktrees/task/docs/design notes", "/worktrees/task"),
    ).toEqual({
      type: "directory",
      workspacePath: "/worktrees/task",
      path: "/worktrees/task/docs/design notes",
      relativePath: "docs/design notes",
      name: "design notes",
    });
  });
  it("rejects a sibling worktree and path-prefix lookalikes", () => {
    expect(() =>
      droppedWorkspaceDirectory("/worktrees/task-other/docs", "/worktrees/task"),
    ).toThrow("chat.composer.workspaceReferenceCurrentOnly");
  });
  it("explains why remote and browser sessions cannot resolve native paths", () => {
    expect(() => droppedWorkspaceDirectory(null, "/worktrees/task")).toThrow(
      "chat.composer.directoryDropUnavailable",
    );
  });
});
