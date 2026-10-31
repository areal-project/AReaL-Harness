import { droppedFilePath } from "@/desktop-services.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { UiMessageError } from "@/i18n/IntlProvider.js";
import type { Action, Data } from "@/services.js";
import { useMemo, type MutableRefObject } from "react";
// LexicalChatInput 壳恢复后回归原始句柄类型（过渡的 ComposerInputHandle 最小面退役）。
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import {
  createWorkspaceFileComposerMention,
  type WorkspaceFileDragPayload,
  type ComposerFileMention,
} from "@/lib/workspaceFileDrag.js";

export type ComposerFileReferenceInput =
  | { source: "workspace"; payload: WorkspaceFileDragPayload }
  | { source: "native-local-directory"; path: string | null };

export function appendWorkspaceFileMentionToComposer(params: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  currentMarkdown: string;
  mention: ComposerFileMention;
  onTextChange: (text: string) => void;
}) {
  const { mention } = params;
  const separator =
    params.currentMarkdown.length > 0 && !/\s$/.test(params.currentMarkdown) ? " " : "";
  const nextText = `${params.currentMarkdown}${separator}${mention.markdown} `;

  params.onTextChange(nextText);
  params.inputApiRef.current?.appendFileMention(
    mention.name,
    mention.value,
    mention.markdown,
    mention.data,
  );
  params.inputApiRef.current?.focus();

  return nextText;
}

async function validateWorkspaceFileReference(
  action: Action,
  projectId: string,
  workspacePath: string,
  payload: WorkspaceFileDragPayload,
): Promise<WorkspaceFileDragPayload> {
  if (
    !payload ||
    payload.workspacePath !== workspacePath ||
    payload.workspaceIdentity ||
    typeof payload.relativePath !== "string" ||
    !["file", "directory"].includes(payload.type)
  ) {
    throw new UiMessageError({ id: "chat.composer.workspaceReferenceCurrentOnly" });
  }
  const parts = payload.relativePath.split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        [...part].some((character) => character.charCodeAt(0) < 32),
    ) ||
    /^[A-Za-z]:/.test(payload.relativePath) ||
    payload.path !== `${workspacePath}/${payload.relativePath}` ||
    payload.name !== parts.at(-1)
  ) {
    throw new UiMessageError({ id: "chat.composer.workspaceReferencePathInvalid" });
  }
  const listing = await action("workspace", {
    projectId,
    operation: "list",
    path: parts.slice(0, -1).join("/"),
    showAll: true,
  });
  const entry = listing.entries?.find(
    (entry: { name: string; dir: boolean }) => entry.name === payload.name,
  );
  if (!entry || entry.dir !== (payload.type === "directory")) {
    throw new UiMessageError({ id: "chat.composer.workspaceReferenceChanged" });
  }
  return payload;
}

export async function validateComposerFileReference(
  action: Action,
  projectId: string,
  workspacePath: string,
  input: ComposerFileReferenceInput,
): Promise<ComposerFileMention> {
  if (input.source === "workspace") {
    const payload = await validateWorkspaceFileReference(
      action,
      projectId,
      workspacePath,
      input.payload,
    );
    return createWorkspaceFileComposerMention(payload, workspacePath);
  }
  if (!input.path) throw new UiMessageError({ id: "chat.composer.directoryDropUnavailable" });
  const directory = await action("workspace", {
    projectId,
    operation: "localDirectoryReference",
    path: input.path,
  });
  return {
    name: directory.name,
    value: directory.path,
    markdown: buildFileMentionMarkdown(directory.path, directory.name, "directory"),
    data: { kind: "directory", path: directory.path },
  };
}

export interface ComposerWorkspaceFiles {
  owner: string;
  root: string;
  search: (query: string) => Promise<{
    entries: readonly { path: string; dir: boolean }[];
    truncated: boolean;
  }>;
}

export function useComposerWorkspaceFiles(action: Action, project: Data, scope: string) {
  const { id: projectId, root, core } = project;
  const connectionGeneration = core?.connectionGeneration;
  return useMemo(
    () =>
      root
        ? {
            owner: JSON.stringify([projectId, root, connectionGeneration, scope]),
            root,
            directory: (file: File | null): ComposerFileReferenceInput => ({
              source: "native-local-directory",
              path: file ? droppedFilePath(file) : null,
            }),
            validate: (input: ComposerFileReferenceInput) =>
              validateComposerFileReference(action, projectId, root, input),
            search: async (query: string) => {
              if (query.length > 256)
                throw new UiMessageError({ id: "chat.composer.fileQueryTooLong" });
              if (query) return action("workspace", { projectId, operation: "search", query });
              const result = await action("workspace", {
                projectId,
                operation: "list",
                path: "",
                showAll: true,
              });
              return {
                entries: result.entries.map((entry) => ({ path: entry.name, dir: entry.dir })),
                truncated: result.truncated,
              };
            },
          }
        : undefined,
    [action, projectId, root, connectionGeneration, scope],
  );
}
