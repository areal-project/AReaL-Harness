import { UiMessageError } from "@/i18n/IntlProvider.js";
import type { Action } from "@/services.js";
import type { MutableRefObject } from "react";
// LexicalChatInput 壳恢复后回归原始句柄类型（过渡的 ComposerInputHandle 最小面退役）。
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import {
  createWorkspaceFileComposerMention,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";

export function appendWorkspaceFileMentionToComposer(params: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  currentMarkdown: string;
  payload: WorkspaceFileDragPayload;
  workspacePath: string;
  workspaceIdentity?: string;
  onTextChange: (text: string) => void;
}) {
  const mention = createWorkspaceFileComposerMention(
    params.payload,
    params.workspacePath,
    params.workspaceIdentity,
  );
  const separator =
    params.currentMarkdown.length > 0 && !/\s$/.test(params.currentMarkdown) ? " " : "";
  const nextText = `${params.currentMarkdown}${separator}${mention.markdown} `;

  params.onTextChange(nextText);
  params.inputApiRef.current?.appendFileMention(
    params.payload.name,
    mention.value,
    mention.markdown,
    mention.data,
  );
  params.inputApiRef.current?.focus();

  return nextText;
}

export async function validateWorkspaceFileReference(
  action: Action, projectId: string, workspacePath: string,
  payload: WorkspaceFileDragPayload,
): Promise<WorkspaceFileDragPayload> {
  if (!payload || payload.workspacePath !== workspacePath || payload.workspaceIdentity
    || typeof payload.relativePath !== "string" || !["file", "directory"].includes(payload.type)) {
    throw new UiMessageError({ id: "chat.composer.workspaceReferenceCurrentOnly" });
  }
  const parts = payload.relativePath.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.includes("\\") || /[\u0000-\u001f]/.test(part))
    || /^[A-Za-z]:/.test(payload.relativePath)
    || payload.path !== `${workspacePath}/${payload.relativePath}` || payload.name !== parts.at(-1)) {
    throw new UiMessageError({ id: "chat.composer.workspaceReferencePathInvalid" });
  }
  const listing = await action("workspace", { projectId, operation: "list", path: parts.slice(0, -1).join("/"), showAll: true });
  const entry = listing.entries?.find((entry: { name: string; dir: boolean }) => entry.name === payload.name);
  if (!entry || entry.dir !== (payload.type === "directory")) {
    throw new UiMessageError({ id: "chat.composer.workspaceReferenceChanged" });
  }
  return payload;
}
