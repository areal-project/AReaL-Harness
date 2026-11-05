// @ts-check
"use strict";
const { workOverview } = require("./remote-core-decoder.cjs");
/** @typedef {import('./remote-core-decoder.cjs').Fields} Fields */
/** @typedef {{method:string,context:{projectId:string},params:{cursor?:string,limit?:number,filter?:string}}} OverviewRequest */
// 同一 Host 业务入口只读现有项目连接，不能通过概览启动/修复 Core。
const PAGE_BYTES = 128 * 1024;
const METHODS = ["host.describe", "project.list", "work.list", "attention.list"];
/** @param {Fields|null|undefined} value @param {string[]} keys */
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value?.[key]]),
  );
/** @param {string} code @param {string} message */
const failure = (code, message) => Object.assign(new Error(message), { code });
/** @param {InstanceType<typeof import('./remote.cjs').RemoteControl>} remote @param {string} peer @param {number} revision @param {string} projectId */
function authorize(remote, peer, revision, projectId) {
  const grant = remote.config?.deviceGrants?.find(
    (value) => value.devicePeerId === peer && value.status === "active",
  );
  if (!grant || grant.revision !== revision)
    throw failure("GRANT_CHANGED", "授权已变化，请重新连接");
  if (
    !grant.capabilities.includes("observe") ||
    !grant.projectIds.includes(projectId) ||
    !remote.backend.saved.some((value) => value.id === projectId)
  )
    throw failure("FORBIDDEN", "此项目未获授权");
  const project = remote.backend.projects?.get(projectId);
  if (
    !project?.client?.ready ||
    project.client.closed ||
    !project.model?.state?.connected ||
    project.resourceInitializing
  )
    throw failure("CORE_UNAVAILABLE", "项目 Core 当前不可用");
  if (!project.client.capabilities?.methods?.includes("areal/work/overview"))
    throw failure("CORE_INCOMPATIBLE", "此 Core 不支持工作概览，请在桌面升级");
  return { project, client: project.client };
}
/** @param {Fields} item */
function projectAttention(item) {
  return pick(item, [
    "attentionRef",
    "kind",
    "threadId",
    "turnId",
    "taskId",
    "runId",
    "interactionId",
    "questionId",
    "summary",
    "status",
  ]);
}
/** @param {import('./remote-core-decoder.cjs').WorkRow} row */
function projectWork(row) {
  return {
    ...pick(row, [
      "kind",
      "threadId",
      "parentThreadId",
      "taskId",
      "runId",
      "title",
      "sourceUpdatedAt",
      "attentionCount",
      "attentionComplete",
      "resultAvailable",
      "workerCount",
      "workersComplete",
      "summaryTruncated",
    ]),
    execution: pick(row.execution, ["state", "turnId", "turnStatus", "runStatus"]),
    attentionRefs: (row.attentionRefs ?? []).map(projectAttention),
    queue: pick(row.queue, ["pendingCount", "paused"]),
    workers: (row.workers ?? []).map((value) =>
      pick(value, ["threadId", "turnId", "status", "settled"]),
    ),
    // 能力声明只包括此构建已有的 Remote 方法，不能从原生可写能力推断远程操作。
    availableActions: [],
  };
}
/** @template T @param {InstanceType<typeof import('./remote.cjs').RemoteControl>} remote @param {string} peer @param {number} revision @param {OverviewRequest} request @param {(value:unknown)=>T} publish */
async function readOverview(remote, peer, revision, request, publish) {
  const projectId = request.context.projectId;
  const { project, client } = authorize(remote, peer, revision, projectId);
  const generation = project.service?.generation;
  /** @param {OverviewRequest['params']} params */
  const query = async (params) => {
    authorize(remote, peer, revision, projectId);
    let result;
    try {
      result = await client.request("areal/work/overview", params);
    } catch (error) {
      const invalid = error instanceof Error && "code" in error && error.code === -32602;
      throw failure(
        invalid ? "INVALID_PARAMS" : "CORE_UNAVAILABLE",
        invalid ? "无效的概览分页参数" : "项目 Core 读取失败",
      );
    }
    const { project: current } = authorize(remote, peer, revision, projectId);
    if (
      current !== project ||
      current.client !== client ||
      current.service?.generation !== generation
    )
      throw failure("CORE_UNAVAILABLE", "项目连接已变化，请刷新概览");
    return workOverview(result);
  };
  let result;
  if (request.method === "work.list") {
    const page = await query(request.params);
    result = {
      data: page.data.map(projectWork),
      nextCursor: page.nextCursor,
      complete: page.complete,
    };
  } else {
    // 注意事项游标同时记录 Core 工作页及页内位置，不缓存正文或另建持久 Inbox。
    let cursor,
      offset = 0;
    if (request.params.cursor !== undefined) {
      try {
        /** @type {unknown} */
        const value = JSON.parse(Buffer.from(request.params.cursor, "base64url").toString("utf8"));
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          (value[0] !== null && (typeof value[0] !== "string" || value[0].length > 256)) ||
          !Number.isInteger(value[1]) ||
          value[1] < 0 ||
          value[1] > 32
        )
          throw new Error();
        cursor = value[0] ?? undefined;
        offset = value[1];
      } catch {
        throw failure("INVALID_PARAMS", "无效的待处理分页参数");
      }
    }
    const limit = request.params.limit ?? 30;
    const data = [];
    let complete = false,
      summariesComplete = true;
    // 每次最多四个原生页，避免一次手机查询扫描全部 Task/Thread 多次。
    for (let pages = 0; pages < 4 && data.length < limit; pages++) {
      const page = await query({ filter: "attention", limit: 1, ...(cursor ? { cursor } : {}) });
      const row = page.data[0];
      if (!row) {
        complete = page.complete;
        break;
      }
      summariesComplete &&= row.attentionComplete;
      const refs = row.attentionRefs.slice(offset, offset + limit - data.length);
      data.push(...refs.map(projectAttention));
      offset += refs.length;
      if (offset < row.attentionRefs.length) break;
      offset = 0;
      cursor = page.nextCursor ?? undefined;
      if (page.complete) {
        complete = true;
        break;
      }
    }
    result = {
      data,
      nextCursor: complete
        ? null
        : Buffer.from(JSON.stringify([cursor ?? null, offset])).toString("base64url"),
      complete,
      summariesComplete,
    };
  }
  const response = { ...result, projectId, serviceGeneration: generation ?? null };
  if (Buffer.byteLength(JSON.stringify(response)) > PAGE_BYTES)
    throw failure("LIMIT_EXCEEDED", "概览超过页面预算，请减少每页条目");
  // 最后一次 await 之后同步校验并发布，不把已校验结果交回另一个异步 continuation。
  const { project: current } = authorize(remote, peer, revision, projectId);
  if (
    current !== project ||
    current.client !== client ||
    current.service?.generation !== generation
  )
    throw failure("CORE_UNAVAILABLE", "项目连接已变化，请刷新概览");
  return publish(response);
}
module.exports = { readOverview, METHODS, PAGE_BYTES };
