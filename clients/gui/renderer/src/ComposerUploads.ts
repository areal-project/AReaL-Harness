import type { Attachment } from "./services.js";
import type { Action } from "./services.js";
import {
  composerUploads,
  forgetComposerUploads,
  setComposerUploadState,
} from "./ComposerUploadState.js";

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
    const state = preparation.states.get(file);
    if (state?.state === "unknown") throw state.error;
    const inFlight = preparation.inFlight.get(file);
    if (inFlight) {
      attachments.push(await inFlight);
      continue;
    }
    const upload = async (): Promise<Attachment> => {
      try {
        setComposerUploadState(owner, file, { state: "reading" });
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (preparation.states.has(file))
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
        if (preparation.states.has(file)) {
          receipts.set(file, attachment);
          preparation.accepted.set(file, attachment);
          setComposerUploadState(owner, file, { state: "ready", receipt: attachment });
        }
        return attachment;
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const message = `${file.name}: ${reason}`;
        const error = Object.assign(new Error(message), cause, { message });
        if (preparation.states.has(file))
          setComposerUploadState(
            owner,
            file,
            (cause as { submissionUnknown?: boolean })?.submissionUnknown === true
              ? { state: "unknown", message, error }
              : { state: "failed", message },
          );
        throw error;
      }
    };
    const pending = upload();
    preparation.inFlight.set(file, pending);
    try {
      attachments.push(await pending);
    } finally {
      preparation.inFlight.delete(file);
      forgetComposerUploads(owner, []);
    }
  }
  return attachments;
}
