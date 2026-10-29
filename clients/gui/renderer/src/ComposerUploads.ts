import type { Attachment } from "@areal/workbench/desktop-contract/conversation";
import type { Action } from "./services.js";
// 发送和队列更新共用上传边界，编辑中现存 Core 引用不经过此函数。
export async function uploadComposerFiles(
  action: Action,
  projectId: string,
  threadId: string,
  files: File[],
  accepted?: Map<File, Attachment>,
) {
  const attachments: Attachment[] = [];
  for (const file of files) {
    const existing = accepted?.get(file);
    if (existing) {
      attachments.push(existing);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`无法读取附件 ${file.name}：${reason}`);
    }
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
    accepted?.set(file, attachment);
    attachments.push(attachment);
  }
  return attachments;
}
