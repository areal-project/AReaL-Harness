import { describe, expect, it, vi } from "vite-plus/test";
import { validateComposerFileReference } from "./workspaceFileComposer.js";
import { readWorkspaceFileDragPayload, WORKSPACE_FILE_DRAG_MIME } from "./workspaceFileDrag.js";
vi.mock("@/desktop-services.js", () => ({ droppedFilePath: vi.fn() }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  UiMessageError: class extends Error {
    constructor(public descriptor: { id: string }) {
      super(descriptor.id);
    }
  },
}));

describe("native folder references", () => {
  it.each(["/external/中文 design (v2)#1", "/workspace/docs", "/external/ folder\\name> ", "/"])(
    "preserves the native absolute path %s",
    async (path) => {
      const name = path.split("/").at(-1) || path;
      const action = vi.fn().mockResolvedValue({ path, name, type: "directory" });
      const mention = await validateComposerFileReference(action, "project", "/workspace", {
        source: "native-local-directory",
        path,
      });
      expect(mention).toMatchObject({ name, value: path, data: { kind: "directory", path } });
      expect(mention.data).not.toHaveProperty("relativePath");
      expect(action).toHaveBeenCalledWith("workspace", {
        projectId: "project",
        operation: "localDirectoryReference",
        path,
      });
    },
  );

  it("explains unavailable native paths before making a metadata request", async () => {
    const action = vi.fn();
    await expect(
      validateComposerFileReference(action, "project", "/workspace", {
        source: "native-local-directory",
        path: null,
      }),
    ).rejects.toThrow("chat.composer.directoryDropUnavailable");
    expect(action).not.toHaveBeenCalled();
  });

  it("keeps internal tree references relative after checking the current workspace", async () => {
    const action = vi.fn().mockResolvedValue({
      path: "docs",
      entries: [{ name: "notes", dir: true, size: 0, hidden: false }],
      truncated: false,
      total: 1,
    });
    const mention = await validateComposerFileReference(action, "project", "/workspace", {
      source: "workspace",
      payload: {
        type: "directory",
        workspacePath: "/workspace",
        path: "/workspace/docs/notes",
        relativePath: "docs/notes",
        name: "notes",
      },
    });
    expect(mention.markdown).toBe("[notes](./docs/notes/)");
    expect(mention.data.relativePath).toBe("docs/notes");
  });

  it("does not let untrusted internal MIME claim native scope", async () => {
    const action = vi.fn();
    const payload = readWorkspaceFileDragPayload({
      types: [WORKSPACE_FILE_DRAG_MIME],
      getData: () =>
        JSON.stringify({
          source: "native-local-directory",
          type: "directory",
          workspacePath: "/workspace",
          path: "/external/folder",
          relativePath: "folder",
          name: "folder",
        }),
    } as unknown as DataTransfer);
    expect(payload).not.toBeNull();
    await expect(
      validateComposerFileReference(action, "project", "/workspace", {
        source: "workspace",
        payload: payload!,
      }),
    ).rejects.toThrow("chat.composer.workspaceReferencePathInvalid");
    expect(action).not.toHaveBeenCalled();
  });
});
