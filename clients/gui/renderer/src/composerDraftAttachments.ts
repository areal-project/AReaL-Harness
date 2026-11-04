import type { ComposerDraftAttachment } from "./ComposerAttachments.js";
import { composerDraftStorage } from "./composerDraftStorage.js";
import { snapShotFile } from "./snapshots/source.js";

class AttachmentDrafts extends Map<string, ComposerDraftAttachment[]> {
  override get(key: string) {
    if (super.has(key)) return super.get(key);
    const raw = composerDraftStorage.getItem(`${key}:attachments`);
    if (!raw) return undefined;
    try {
      const entries: unknown = JSON.parse(raw);
      if (
        !Array.isArray(entries) ||
        entries.some(
          (entry) =>
            !entry ||
            (entry.kind === "pasted-text"
              ? typeof entry.text !== "string"
              : entry.kind !== "missing-file" ||
                typeof entry.name !== "string" ||
                typeof entry.type !== "string" ||
                typeof entry.size !== "number" ||
                typeof entry.lastModified !== "number"),
        )
      )
        throw new Error("Invalid attachment draft");
      super.set(key, entries);
      return entries as ComposerDraftAttachment[];
    } catch {
      // 损坏记录也保留可见阻断，不能当成没有附件继续发送。
      const entries: ComposerDraftAttachment[] = [
        { kind: "missing-file", name: "", size: 0, type: "", lastModified: 0 },
      ];
      super.set(key, entries);
      return entries;
    }
  }

  override set(key: string, entries: ComposerDraftAttachment[]) {
    // 文件句柄不能跨进程恢复；仅保存重附提示，不复制文件正文或本机路径。
    // 原生截图由现有 IndexedDB 所有者恢复字节，避免额外生成待重附副本。
    const persisted = entries
      .filter((entry) => "kind" in entry || !snapShotFile(entry))
      .map((entry) =>
        "kind" in entry
          ? entry
          : {
              kind: "missing-file",
              name: entry.name,
              size: entry.size,
              type: entry.type,
              lastModified: entry.lastModified,
            },
      );
    if (persisted.length)
      composerDraftStorage.setItem(`${key}:attachments`, JSON.stringify(persisted));
    else composerDraftStorage.removeItem(`${key}:attachments`);
    return super.set(key, entries);
  }

  override delete(key: string) {
    composerDraftStorage.removeItem(`${key}:attachments`);
    return super.delete(key);
  }
}

export const attachmentDrafts = new AttachmentDrafts();

export const sending = new Set<string>();
