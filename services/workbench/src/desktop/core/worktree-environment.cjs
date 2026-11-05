// @ts-check
"use strict";
const { randomUUID } = require("node:crypto");
const {
  readEnvironmentProcess,
  readEnvironmentOutput,
} = require("@areal/workbench/desktop-contract/workspace-worktrees");
const {
  responses,
} = require("@areal/workbench/desktop-contract/generated/management-processes-protocol");
/** @typedef {import('./worktrees.cjs').EnvironmentAttempt} Attempt */
const TIMEOUT_MS = 600000;
const OUTPUT_BYTES = 65536;
const terminal = new Set(["succeeded", "failed", "cancelled"]);

/** @param {import('./worktrees.cjs').EnvironmentScript|undefined} script @param {string} [platform] */
function platformScript(script, platform = process.platform) {
  const configured = script ?? { default: "" };
  const key = platform === "darwin" ? "macos" : platform === "linux" ? "linux" : undefined;
  const selected = key && configured[key]?.trim() ? configured[key] : configured.default;
  if (selected?.trim() && !key) throw new Error("此平台不支持 Worktree 环境脚本");
  return selected?.trim() ? selected : "";
}

class WorktreeEnvironment {
  /** @param {InstanceType<typeof import('./worktrees.cjs').CoreWorktrees>} owner */
  constructor(owner) {
    this.owner = owner;
  }
  /** @param {import('./worktrees.cjs').WorktreeOperation} operation @param {'setup'|'cleanup'|'actions'} slot @param {string} script @param {{requestId?:string,actionId?:string,recover?:boolean,observeOnly?:boolean}} [options] @returns {Promise<Attempt|null>} */
  async execute(
    operation,
    slot,
    script,
    { requestId = randomUUID(), actionId, recover = false, observeOnly = false } = {},
  ) {
    const owner = this.owner,
      backend = owner.backend;
    let attempt = slot === "actions" ? operation.actions?.[requestId] : operation[slot];
    if (attempt && terminal.has(attempt.status)) return attempt;
    /** @param {Partial<Attempt>} patch @returns {Promise<Attempt>} */
    const save = async (patch) => {
      if (!attempt) throw new Error("环境脚本尝试尚未建立");
      const next = { ...attempt, ...patch };
      attempt = next;
      await owner.update(operation.requestId, (value) =>
        slot === "actions"
          ? { ...value, actions: { ...value.actions, [requestId]: next } }
          : { ...value, [slot]: next },
      );
      return next;
    };
    if (!operation.executionProjectId || !operation.threadId)
      throw new Error("工作树执行身份尚未确认");
    const project =
      backend.projects.get(operation.executionProjectId) ??
      (await backend.start(operation.executionProjectId));
    if (!project.client) throw new Error("Core 连接不可用");
    if (!attempt) {
      if (recover) return null;
      attempt = {
        requestId,
        kind: slot === "actions" ? "action" : slot,
        ...(actionId ? { actionId } : {}),
        script,
        status: "running",
        startedAt: new Date().toISOString(),
        timeoutMs: TIMEOUT_MS,
        output: "",
      };
      await save({});
      try {
        const source = backend.saved.find((project) => project.id === operation.projectId);
        if (!source || !operation.record) throw new Error("工作树来源尚未确认");
        const result = await backend.submit(
          project,
          "areal/process/start",
          {
            threadId: operation.threadId,
            lifetime: "thread",
            cwd: project.root,
            argv: [
              "/usr/bin/env",
              `AREAL_WORKTREE_PATH=${operation.record.directory}`,
              `AREAL_PROJECT_PATH=${source.root}`,
              `AREAL_WORKTREE_BRANCH=${operation.record.branch}`,
              "/bin/sh",
              "-c",
              script,
            ],
            timeoutMs: TIMEOUT_MS,
          },
          { requestId },
        );
        if (!responses.processStart(result)) throw new Error("环境脚本受理回执尚未确认");
        await save({ processId: result.id, receipt: result });
      } catch (error) {
        await save({
          status: "unknown",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!attempt.processId) {
      try {
        const receipt = await backend.readSubmission(project, "areal/process/start", {
          requestId: attempt.requestId,
          threadId: operation.threadId,
        });
        if (receipt.confirmed && "result" in receipt && responses.processStart(receipt.result))
          await save({
            processId: receipt.result.id,
            receipt: receipt.result,
            status: "running",
          });
      } catch (error) {
        await save({ message: error instanceof Error ? error.message : String(error) });
      }
      if (!attempt.processId)
        return save({
          status: "unknown",
          message: attempt.message ?? "环境脚本受理回执尚未确认，不会重新运行",
        });
    }
    const target = { threadId: operation.threadId, id: attempt.processId };
    const deadline = Date.now() + TIMEOUT_MS + 15000;
    try {
      do {
        const cancel =
          slot === "setup" && owner.records.get(operation.requestId)?.intent === "cancel";
        if (cancel && !attempt.terminateRequestId && !observeOnly) {
          await save({ terminateRequestId: randomUUID() });
          try {
            await backend.submit(project, "areal/process/terminate", target, {
              requestId: attempt.terminateRequestId,
            });
          } catch (error) {
            await save({ message: error instanceof Error ? error.message : String(error) });
          }
        }
        const observed = await project.client.request("areal/process/get", target, {
          decode: readEnvironmentProcess,
        });
        let output = attempt.output ?? "";
        const page = await project.client.request(
          "areal/process/read",
          {
            ...target,
            after: attempt.cursor ?? null,
            maxBytes: OUTPUT_BYTES,
            waitMs: 0,
          },
          { decode: readEnvironmentOutput },
        );
        for (const chunk of page.chunks ?? [])
          output += Buffer.from(chunk.dataBase64, "base64").toString("utf8");
        await save({
          output: Buffer.from(output).subarray(-OUTPUT_BYTES).toString("utf8"),
          cursor: page.nextCursor,
          outputTruncated:
            attempt.outputTruncated ||
            Buffer.byteLength(output) > OUTPUT_BYTES ||
            page.gap ||
            page.truncated ||
            (observed.runtime?.state === "exited" && !page.closed),
          runtime: observed.runtime,
          managed: observed.process,
        });
        const runtime = observed.runtime;
        if (runtime?.state === "exited" && runtime.cleanupConfirmed === true) {
          if (observed.process?.cleanupConfirmed !== true) {
            if (!attempt.closeRequestId && !observeOnly) {
              await save({ closeRequestId: randomUUID() });
              try {
                await backend.submit(project, "areal/process/terminate", target, {
                  requestId: attempt.closeRequestId,
                });
              } catch (error) {
                await save({ message: error instanceof Error ? error.message : String(error) });
              }
            }
            const closed = await project.client.request("areal/process/get", target, {
              decode: readEnvironmentProcess,
            });
            await save({ managed: closed.process });
            if (closed.process?.cleanupConfirmed !== true)
              return save({
                status: "unknown",
                message: "脚本进程已退出，但受管 scope 关闭尚未确认",
              });
          }
          return save({
            status: cancel
              ? "cancelled"
              : runtime.exitCode === 0 && !runtime.stopReason
                ? "succeeded"
                : "failed",
            finishedAt: new Date().toISOString(),
            exitCode: runtime.exitCode,
            message:
              runtime.stopReason ??
              (runtime.exitCode ? `脚本退出码 ${runtime.exitCode}` : undefined),
          });
        }
        if (runtime?.state === "unknown" || observed.process?.state === "unknown")
          return save({ status: "unknown", message: "环境脚本结果或资源清理尚未确认" });
        if (recover) return save({ status: "running" });
        await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      return save({ status: "unknown", message: "环境脚本超时后的终止结果尚未确认" });
    } catch (error) {
      return save({
        status: "unknown",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
module.exports = { WorktreeEnvironment, platformScript };
