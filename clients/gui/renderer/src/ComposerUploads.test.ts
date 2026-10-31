import { describe, expect, it, vi } from "vite-plus/test";
import type { Action } from "./services.js";
import { uploadComposerFiles } from "./ComposerUploads.js";
import {
  composerUploadOwner,
  composerUploads,
  forgetComposerUploads,
} from "./ComposerUploadState.js";

const receipt = (id: string) => ({ uri: `core-media:${id}`, mimeType: "text/plain" });
describe("composer attachment preparation", () => {
  it("keeps successful receipts when another file fails and retries only the failed file", async () => {
    const owner = crypto.randomUUID();
    const files = [new File(["first"], "first.txt"), new File(["second"], "second.txt")];
    const action = vi.fn<Action>();
    const invoke = action as Action;
    action
      .mockResolvedValueOnce(receipt("first"))
      .mockRejectedValueOnce(new Error("upload denied"));
    await expect(
      uploadComposerFiles(invoke, "project", "thread", files, undefined, owner),
    ).rejects.toThrow("second.txt: upload denied");
    expect(composerUploads(owner).states.get(files[0])?.state).toBe("ready");
    expect(composerUploads(owner).states.get(files[1])?.state).toBe("failed");
    action.mockResolvedValueOnce(receipt("second"));
    const attachments = await uploadComposerFiles(
      invoke,
      "project",
      "thread",
      files,
      undefined,
      owner,
    );
    expect(attachments.map((attachment) => attachment.url)).toEqual([
      "core-media:first",
      "core-media:second",
    ]);
    expect(action).toHaveBeenCalledTimes(3);
    expect(composerUploads(owner).states.get(files[1])?.state).toBe("ready");
    forgetComposerUploads(owner, files);
  });

  it("shares in-flight preparation and waits for the upload receipt", async () => {
    const owner = crypto.randomUUID();
    const file = new File(["content"], "document.txt");
    let finish!: (value: ReturnType<typeof receipt>) => void;
    const action = vi.fn<Action>();
    const invoke = action as Action;
    action.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = uploadComposerFiles(invoke, "project", "thread", [file], undefined, owner);
    const second = uploadComposerFiles(invoke, "project", "thread", [file], undefined, owner);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(composerUploads(owner).states.get(file)?.state).toBe("uploading");
    finish(receipt("document"));
    expect(await first).toEqual(await second);
    forgetComposerUploads(owner, [file]);
  });

  it("does not reuse an old Core instance's media receipt", async () => {
    const file = new File(["content"], "document.txt");
    const firstOwner = composerUploadOwner(
      { id: "project", root: "/worktree", core: { instanceId: "first" } },
      "thread",
    );
    const secondOwner = composerUploadOwner(
      { id: "project", root: "/worktree", core: { instanceId: "second" } },
      "thread",
    );
    const action = vi.fn<Action>();
    const invoke = action as Action;
    action.mockResolvedValueOnce(receipt("first")).mockResolvedValueOnce(receipt("second"));
    await uploadComposerFiles(invoke, "project", "thread", [file], undefined, firstOwner);
    const result = await uploadComposerFiles(
      invoke,
      "project",
      "thread",
      [file],
      undefined,
      secondOwner,
    );
    expect(result[0].url).toBe("core-media:second");
    expect(action).toHaveBeenCalledTimes(2);
    forgetComposerUploads(firstOwner, [file]);
    forgetComposerUploads(secondOwner, [file]);
  });
});
