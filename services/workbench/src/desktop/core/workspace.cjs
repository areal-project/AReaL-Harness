// @ts-check
"use strict";
const { validateWorkspaceResponse } = require("@areal/workbench/desktop-contract/workspace");
const { commandResponseError } = require("@areal/workbench/desktop-contract");
const files = require("../workspace-files.js");
const git = require("@areal/workspace-git");
const { createHash } = require("node:crypto");
const { modelRecord } = require("@areal/workbench/core-model-contract");
const {
  readObservationResult,
  readInheritedHistoryPage,
  readHistoryEntry,
} = require("./history-contract.cjs");
const MAX_FILE_BEFORE_BYTES = 8 * 1024 * 1024;

/** @param {import('./project-state.cjs').CoreProject} project @param {string} threadId @param {unknown} reference */
async function readFileBefore(project, threadId, reference) {
  if (!modelRecord(reference)) throw new Error("历史文件前像引用无效");
  const digest =
    typeof reference?.uri === "string" &&
    /^areal:\/\/blob\/([a-f0-9]{64})$/.exec(reference.uri)?.[1];
  if (
    !digest ||
    reference.mimeType !== "application/octet-stream" ||
    typeof reference.sizeBytes !== "number" ||
    !Number.isSafeInteger(reference.sizeBytes) ||
    reference.sizeBytes < 0 ||
    reference.sizeBytes > MAX_FILE_BEFORE_BYTES
  )
    throw new Error("历史文件前像引用无效");
  const { HostCoreClient } = require("@areal/workbench-service/host-core-client");
  if (!(project.client instanceof HostCoreClient))
    throw new Error("Host Core transport unavailable");
  const value = await project.client.blob({ operation: "read", threadId, uri: reference.uri });
  if (typeof value.base64 !== "string") throw new Error("历史文件前像响应不完整");
  const bytes = Buffer.from(value.base64, "base64"),
    size = bytes.length;
  if (size !== reference.sizeBytes || createHash("sha256").update(bytes).digest("hex") !== digest)
    throw new Error("历史文件前像与记录的大小或哈希不一致");
  return bytes;
}

/** 用户直接操作的桌面文件／Git 功能，复用原有路径与 revision 校验。 */
/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {Record<string,unknown>} request */
async function executeWorkspaceCommand(backend, request) {
  if (typeof request.operation === "string" && request.operation.startsWith("worktree")) {
    const reading = ["worktreeList", "worktreeOptions", "worktreeRead"].includes(request.operation);
    const result = await backend.hostCall(
      reading ? "worktree.read" : "worktree.command",
      reading ? request : { commandId: require("node:crypto").randomUUID(), request },
    );
    backend.saved = await backend.host.list();
    await backend.library.reload();
    await backend.worktrees.reloadNative();
    backend.onChange();
    return result;
  }
  const project = backend.saved.find((item) => item.id === request.projectId);
  if (!project) throw new Error("未知工作区");
  switch (request.operation) {
    case "localDirectoryReference": {
      const path = require("node:path");
      if (typeof request.path !== "string" || !path.isAbsolute(request.path))
        throw new Error("无效本机目录路径");
      const stat = await require("node:fs/promises").stat(request.path);
      if (!stat.isDirectory()) throw new Error("引用路径不是目录");
      return {
        path: request.path,
        name: path.basename(request.path) || request.path,
        type: "directory",
      };
    }
    case "list": {
      if (typeof request.path !== "string") throw new Error("无效目录");
      const { listDirectory } = await import("../bridge/filetree.js");
      const result = await listDirectory(project.root, request.path, {
        showAll: request.showAll === true,
      });
      if (!result) throw new Error("目录不存在或不在工作区内");
      return result;
    }
    case "search": {
      const { searchFiles } = await import("../bridge/filetree.js");
      return searchFiles(project.root, request.query);
    }
    case "read":
      if (typeof request.path !== "string") throw new Error("无效文件路径");
      return files.readText(project.root, request.path);
    case "save":
      if (typeof request.path !== "string") throw new Error("无效文件路径");
      return files.saveText(project.root, request.path, request.text, request.revision);
    case "review":
      return git.review(project.root, backend.home, {
        scope: request.scope ?? "unstaged",
        ref: request.ref,
      });
    case "reviewCommits":
      return git.reviewCommits(project.root);
    case "reviewBranches":
      return git.reviewBranches(project.root);
    case "turnReview": {
      if (typeof request.threadId !== "string" || typeof request.turnId !== "string")
        throw new Error("请选择已完成的任务轮次");
      const live = await backend.start(project.id);
      if (!live.client) throw new Error("Core 连接不可用");
      const result = backend.supportsBoundedHistory(live.client)
        ? { thread: live.model.state.threads[request.threadId] }
        : await live.client.request(
            "thread/read",
            { threadId: request.threadId, includeTurns: true },
            { decode: readObservationResult },
          );
      let turn = result.thread?.turns?.find((turn) => turn.id === request.turnId);
      if (!turn && result.thread?.conversation?.kind === "fork") {
        // Read only the target-owned frozen prefix; never substitute the source's live history.
        /** @type {string|null|undefined} */
        let cursor;
        let partial = "";
        /** @type {string|undefined} */
        let partialItemId;
        do {
          const page = await live.client.request(
            "areal/conversation/history",
            {
              threadId: request.threadId,
              view: "inherited",
              maxBytes: 262144,
              ...(cursor ? { cursor } : {}),
            },
            { decode: readInheritedHistoryPage },
          );
          if (
            !modelRecord(result.thread.conversation.historySeed) ||
            page.snapshotId !== result.thread.conversation.historySeed.snapshotId
          )
            throw new Error("继承历史快照已变化");
          for (let entry of page.data ?? []) {
            if (entry.fragment) {
              if (
                entry.fragment.offsetUtf8 !== Buffer.byteLength(partial) ||
                (partial && partialItemId !== entry.sourceItemId)
              )
                throw new Error("继承历史分片不连续");
              partialItemId = entry.sourceItemId;
              partial += entry.fragment.text;
              const bytes = Buffer.byteLength(partial);
              if (bytes > entry.fragment.totalBytes) throw new Error("继承历史分片长度无效");
              if (bytes < entry.fragment.totalBytes) continue;
              entry = readHistoryEntry(JSON.parse(partial));
              partial = "";
              partialItemId = undefined;
            } else if (partial) throw new Error("继承历史分片不连续");
            if (entry.sourceTurnId !== request.turnId) continue;
            turn ??= {
              ...entry.turn,
              id: request.turnId,
              status: entry.sourceTurnStatus,
              items: [],
            };
            (turn.items ??= []).push(entry.item);
          }
          if (page.complete) {
            if (partial) throw new Error("继承历史分片不完整");
            break;
          }
          if (!page.nextCursor || page.nextCursor === cursor) throw new Error("继承历史游标未推进");
          cursor = page.nextCursor;
        } while (cursor);
      }
      if (!turn) throw new Error("轮次不属于当前任务");
      if (
        turn.items?.some(
          (item) =>
            (request.itemId === undefined || item.id === request.itemId) &&
            item.type === "historyDeferred" &&
            item.originalType === "dynamicToolCall",
        )
      )
        throw new Error("请先加载本轮的完整工具内容，再查看文件变更。");
      const fileBefores = new Map();
      for (const item of turn.items ?? []) {
        if (request.itemId !== undefined && item.id !== request.itemId) continue;
        if (
          item.type !== "dynamicToolCall" ||
          typeof item.tool !== "string" ||
          !["fs_write", "fs_create", "fs_apply_patch", "fs_apply_patches"].includes(item.tool) ||
          item.status !== "completed" ||
          item.success !== true ||
          !modelRecord(item.execution) ||
          item.execution.backend !== "runtime" ||
          item.execution?.outcome !== "succeeded" ||
          item.execution.fileBefore === undefined
        )
          continue;
        fileBefores.set(
          item.id,
          await readFileBefore(live, request.threadId, item.execution.fileBefore),
        );
      }
      return git.reviewTurnFiles(project.root, turn, {
        itemId: request.itemId,
        fileBefores,
        allowPartial: true,
      });
    }
    case "status":
      return git.fileStatus(project.root);
    case "info":
      return git.workspaceInfo(project.root, backend.home);
    case "gitState":
      return git.gitState(project.root, backend.home);
    case "gitStage":
    case "gitUnstage":
    case "gitCommit":
    case "gitPush":
      return git.gitChange(project.root, backend.home, request);
    default:
      throw new Error("不支持的工作区操作");
  }
}
/** @param {InstanceType<typeof import('./backend.cjs').CoreBackend>} backend @param {import('@areal/workbench/desktop-contract/workspace').WorkspaceRequest} request */
async function workspaceCommand(backend, request) {
  const result = await executeWorkspaceCommand(backend, request);
  try {
    validateWorkspaceResponse(request, result);
  } catch (cause) {
    throw commandResponseError("workspace", request, cause);
  }
  return result;
}
module.exports = { workspaceCommand };
