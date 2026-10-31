import type { Attachment } from "@areal/workbench/desktop-contract/conversation";
import type { Action } from "./services.js";
import { composerUploads, setComposerUploadState } from "./ComposerUploadState.js";

// 成功回执和准备状态属于同一个 Core 会话，失败重试只补尚未成功的文件。
export async function uploadComposerFiles(
  action: Action,
  projectId: string,
  threadId: string,
  files: File[],
  accepted?: Map<File, Attachment>,
  owner = JSON.stringify([projectId, threadId]),
) {
  const preparation = composerUploads(owner);
  const receipts = accepted ?? preparation.accepted;
  for (const file of files) {
    if (!preparation.states.has(file)) setComposerUploadState(owner, file, { state: "pending" });
  }
  const attachments: Attachment[] = [];
  for (const file of files) {
    const existing = receipts.get(file);
    if (existing) {
      setComposerUploadState(owner, file, { state: "ready", receipt: existing });
      attachments.push(existing);
      continue;
    }
    const inFlight = preparation.inFlight.get(file);
    if (inFlight) {
      attachments.push(await inFlight);
      continue;
    }
    const upload = async (): Promise<Attachment> => {
      try {
        setComposerUploadState(owner, file, { state: "reading" });
        const bytes = new Uint8Array(await file.arrayBuffer());
        setComposerUploadState(owner, file, { state: "uploading" });
        const media = await action("media", {
          projectId,
          threadId,
          operation: "upload",
          mime: file.type || "application/octet-stream",
          bytes,
        });
        const attachment: Attachment = {
          type: media.mimeType.startsWith("image/")
            ? "image"
            : media.mimeType.startsWith("audio/")
              ? "audio"
              : "file",
          url: media.uri,
          name: file.name,
          mimeType: media.mimeType,
        };
        receipts.set(file, attachment);
        preparation.accepted.set(file, attachment);
        setComposerUploadState(owner, file, { state: "ready", receipt: attachment });
        return attachment;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const message = `${file.name}: ${reason}`;
        setComposerUploadState(owner, file, { state: "failed", message });
        throw new Error(message);
      }
    };
    const pending = upload();
    preparation.inFlight.set(file, pending);
    try {
      attachments.push(await pending);
    } finally {
      preparation.inFlight.delete(file);
    }
  }
  return attachments;
}
