// @ts-check
"use strict";
const { createHash } = require("node:crypto");
const { messageInput } = require("./media.cjs");
const { resolveNewConversationModel } = require("@areal/workbench/model-selection");

const { modelRecord } = require("@areal/workbench/core-model-contract");
const { readTask } = require("@areal/workbench/desktop-contract/management-tasks");
const { readTaskDraftTarget } = require("./task-draft-target.cjs");
/** @typedef {import('./project-state.cjs').CoreProject} Project */
/** @typedef {import('@areal/workbench/core-model-contract').CoreThread} Thread */
/** @typedef {import('@areal/workbench/core-model-contract').CoreTurn} Turn */
/** @typedef {ReturnType<typeof import('./task-draft-target.cjs').taskDraftTarget>} Target */
/** @typedef {Record<string,unknown> & {action?:string,taskId?:string,expectedRevision?:number,objective?:string,scheduleV2?:Record<string,unknown>,mode?:string,threadId?:string}} Proposal */
const marker = "AREAL_TASK_DRAFT_V1";
const operations = new Set([
  "taskDraftHistory",
  "taskDraftStart",
  "taskDraftRead",
  "taskDraftSend",
  "taskDraftConfirm",
]);
/** @param {string} value */
const hash = (value) => createHash("sha256").update(value).digest("hex");
// 创建按配置会话去重，编辑按配置轮次去重；执行身份始终取自宿主保存的目标。
/** @param {string} threadId @param {string} purpose */
const key = (threadId, purpose) => {
  const hex = hash(`${marker}:${threadId}:${purpose}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const targetPrefix = "Current scheduled task: ";
/** @param {Thread} thread @param {Project} [project] @returns {Target|null} */
function targetOf(thread, project) {
  const line = draftInstructions(thread, project)
    .split("\n")
    .find((value) => value.startsWith(targetPrefix));
  if (!line) return null;
  /** @type {unknown} */
  const value = JSON.parse(line.slice(targetPrefix.length));
  return readTaskDraftTarget(value);
}
/** @param {Thread} thread @param {Project} [project] */
function draftInstructions(thread, project) {
  const configuration = project?.configurations?.[thread.id] ?? thread.desktop?.configuration;
  if (!isTaskDraftConfiguration(configuration))
    throw new Error("这不是有效的任务配置会话，请重新创建。");
  return configuration.options.appendInstructions;
}

/** @param {unknown} value @param {string} label @param {number} [max] */
function text(value, label, max = 4000) {
  if (typeof value !== "string" || !value.trim() || [...value].length > max)
    throw new Error(`${label}需要 1–${max} 个字符`);
  return value.trim();
}
/** @param {Record<string,unknown>} value @param {unknown} zone @param {Target|null} current @param {string[]} users */
function scheduleIntent(value, zone, current, users) {
  let intent = value.scheduleV2;
  if (value.scheduleV2 && value.schedule) throw new Error("请只提供一份执行计划。");
  if (!intent && value.schedule) {
    const old = value.schedule;
    if (!modelRecord(old)) throw new Error("模型返回的执行时间无效。");
    if (current?.scheduleV2?.rule.kind === "calendar" && old.intervalSeconds === undefined)
      throw new Error("修改日历时刻需要完整日历计划，请重新描述安排。");
    if (
      Object.keys(old).some((field) => !["at", "intervalSeconds"].includes(field)) ||
      typeof old.at !== "string"
    )
      throw new Error("模型返回的执行时间无效。");
    const interval =
      old.intervalSeconds === undefined
        ? (current?.schedule?.intervalSeconds ??
          (current?.scheduleV2?.rule.kind === "interval"
            ? current.scheduleV2.rule.intervalSeconds
            : undefined))
        : old.intervalSeconds;
    const offset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(old.at);
    const civil = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/.test(old.at);
    if (!offset && !civil) throw new Error("模型返回的时间缺少明确日期，请补充说明。");
    const rule = {
      ...(offset
        ? { kind: interval ? "intervalIso" : "onceIso", atIso: old.at }
        : {
            kind: interval ? "intervalLocal" : "onceLocal",
            timeZone: zone,
            localTime: old.at.slice(11, 16),
            date: { kind: "date", date: old.at.slice(0, 10) },
          }),
      ...(interval != null ? { intervalSeconds: interval } : {}),
    };
    intent = { version: 1, rule };
  }
  if (!modelRecord(intent) || !modelRecord(intent.rule) || typeof intent.rule.kind !== "string")
    throw new Error("定时任务需要明确的执行时间。");
  const latest =
    users.findLast((message) =>
      /(工作日|周一至周五|周一到周五|每月|月末|月底|每天|每日|每周|每\s*\d+\s*(小时|天|周|分钟|秒)|一次性|仅一次)/.test(
        message,
      ),
    ) ?? "";
  if (
    ["interval", "intervalLocal", "intervalIso"].includes(intent.rule?.kind) &&
    /(工作日|周一至周五|周一到周五|每月|月末|月底)/.test(latest)
  )
    throw new Error("工作日或每月安排不能换算成固定秒间隔，请补充说明日历安排。");
  return {
    ...intent,
    misfire: intent.misfire ?? { kind: "skip", maxLatenessSeconds: 300 },
    overlap: intent.overlap ?? "skip",
  };
}
/** @param {Record<string,unknown>} value @param {string[]} userMessages @param {Target|null} target @returns {Proposal} */
function proposal(value, userMessages, target) {
  if (target) {
    const binding = { taskId: target.taskId, expectedRevision: target.expectedRevision };
    if (
      value.kind === "control" &&
      typeof value.action === "string" &&
      ["pause", "resume", "cancel"].includes(value.action)
    )
      return { ...binding, action: value.action };
    if (
      value?.kind !== "proposal" ||
      Object.keys(value).some(
        (field) =>
          ![
            "kind",
            "message",
            "objective",
            "schedule",
            "scheduleV2",
            "interactionMode",
            "timeZone",
          ].includes(field),
      )
    )
      throw new Error("当前只能修改任务内容和时间，或暂停／恢复／取消任务。");
    if (value.interactionMode !== undefined && value.interactionMode !== target.interactionMode)
      throw new Error("此次修改不能改变任务权限或提问策略。");
    /** @type {Proposal} */
    const patch = { ...binding };
    if (value.objective !== undefined) patch.objective = text(value.objective, "任务目标");
    if (value.schedule !== undefined || value.scheduleV2 !== undefined) {
      patch.scheduleV2 = scheduleIntent(value, value.timeZone, target, userMessages);
    }
    if (patch.objective === undefined && patch.scheduleV2 === undefined)
      throw new Error("没有可保存的修改，请说明要调整的内容。");
    return patch;
  }
  if (!value || value.kind !== "proposal")
    throw new Error("模型没有返回可确认的安排，请补充说明后重试。");
  const objective = text(value.objective, "任务目标");
  const scheduleV2 = scheduleIntent(value, value.timeZone, null, userMessages);
  const limits = value.limits ?? {};
  if (!modelRecord(limits)) throw new Error("模型返回的停止条件无效。");
  const allowed = ["tokenBudget", "maxTurns", "maxActiveSeconds"];
  if (Object.keys(limits).some((field) => !allowed.includes(field)))
    throw new Error("模型返回了不支持的停止条件。");
  for (const [field, limit] of Object.entries(limits)) {
    const quote = modelRecord(value.limitSources) ? value.limitSources[field] : undefined;
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit <= 0 ||
      typeof quote !== "string" ||
      !quote.trim() ||
      !userMessages.some((message) => message.includes(quote))
    )
      throw new Error("停止条件缺少你的明确说明，请补充后重新生成。");
  }
  return { mode: "scheduled", objective, interactionMode: "interactive", scheduleV2, ...limits };
}
/** @param {string} raw */
function parseReply(raw) {
  try {
    /** @type {unknown} */
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1"));
    if (!modelRecord(value)) throw new Error("安排结构无效");
    return value;
  } catch {
    throw new Error("模型未返回有效的任务安排，请补充说明后重试。");
  }
}
/** @param {unknown} configuration @returns {configuration is Record<string,unknown> & {options:Record<string,unknown> & {appendInstructions:string}}} */
const isTaskDraftConfiguration = (configuration) =>
  modelRecord(configuration) &&
  modelRecord(configuration.options) &&
  typeof configuration.options.appendInstructions === "string" &&
  configuration.options.appendInstructions.startsWith(`${marker}\n`);
/** @param {Turn} turn */
const userText = (turn) =>
  (turn.items ?? [])
    .filter((item) => item.type === "userMessage")
    .flatMap((item) =>
      (item.content ?? []).flatMap((c) =>
        modelRecord(c) && c.type === "text" && typeof c.text === "string" ? [c.text] : [],
      ),
    )
    .join("\n");
/** @param {Project} project @param {unknown} threadId @param {string|undefined} turnId */
function receiptFor(project, threadId, turnId) {
  return Object.values(project.outcomes ?? {}).find(
    (value) =>
      value.accepted === true &&
      value.draftThreadId === threadId &&
      value.turnId === turnId &&
      value.taskId,
  );
}
/** @param {Thread} thread @param {Turn} turn @param {Project} project @param {string[]} users @param {Target|null} target @param {string} zone */
function turnProjection(thread, turn, project, users, target, zone) {
  if (turn.status === "inProgress") return { message: null, proposal: null, error: "" };
  const receipt = receiptFor(project, thread.id, turn.id);
  if (receipt)
    return {
      message:
        receipt.taskDraftMessage ??
        (receipt.method === "areal/task/create" ? "已创建任务。" : "已保存修改。"),
      proposal: null,
      error: "",
    };
  try {
    if (turn.status !== "completed")
      throw new Error("模型未完成这次安排。你的描述已保留，可以补充说明后重试。");
    const raw = (turn.items ?? [])
      .filter((item) => item.type === "agentMessage" && item.phase !== "commentary")
      .at(-1)?.text;
    const answer = parseReply(typeof raw === "string" ? raw : "");
    if (
      typeof answer.kind !== "string" ||
      !["question", "proposal", ...(target ? ["control"] : [])].includes(answer.kind)
    )
      throw new Error("模型返回的安排格式无效，请重新描述。");
    if (answer.kind === "question")
      return { message: text(answer.message, "模型回复"), proposal: null, error: "" };
    const result = proposal({ ...answer, timeZone: zone }, users, target);
    const failure = project.outcomes?.[key(thread.id, `failed:${turn.id}`)];
    return {
      message:
        failure?.taskDraftMessage ??
        (turn === (thread.turns ?? []).at(-1) ? "正在保存安排。" : "此安排未保存。"),
      proposal: result,
      error: failure?.taskDraftError ?? "",
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { message: `这次安排未保存。${message}`, proposal: null, error: message };
  }
}
/** @param {Thread} thread @param {Project} project */
function view(thread, project) {
  const turns = thread.turns ?? [],
    last = turns.at(-1),
    messages = [];
  const target = targetOf(thread, project);
  /** @type {string[]} */
  const users = [];
  const zone = draftInstructions(thread, project).split("\n")[1].slice("Time zone: ".length);
  let result = null,
    error = "";
  const projections = new Map();
  for (const turn of turns) {
    const user = userText(turn);
    users.push(user);
    if (user) messages.push({ id: `${turn.id}:user`, role: "user", text: user });
    const projection = turnProjection(thread, turn, project, users, target, zone);
    projections.set(turn.id, projection);
    if (projection.message)
      messages.push({ id: `${turn.id}:assistant`, role: "assistant", text: projection.message });
    if (turn === last) {
      result = projection.proposal;
      error = projection.error;
    }
  }
  return {
    threadId: thread.id,
    turnId: last?.id ?? null,
    running: last?.status === "inProgress",
    messages,
    proposal: result,
    digest: result ? hash(JSON.stringify(result)) : null,
    error,
    timeZone: zone,
    projections,
  };
}
// Only the display projection is decoded; the saved Core transcript remains intact.
/** @param {Thread} thread @param {Project} project */
function displayThread(thread, project) {
  const { projections } = view(thread, project);
  return {
    ...thread,
    turns: (thread.turns ?? []).map((turn) => {
      const last = (turn.items ?? [])
        .filter((item) => item.type === "agentMessage" && item.phase !== "commentary")
        .at(-1);
      return {
        ...turn,
        items: (turn.items ?? []).flatMap((item) => {
          if (item.type !== "agentMessage") return [item];
          const message = projections.get(turn.id)?.message;
          return item === last && message ? [{ ...item, text: message }] : [];
        }),
      };
    }),
  };
}

/** @param {InstanceType<typeof import("./backend.cjs").CoreBackend>} backend @param {Project} project @param {import("@areal/workbench/desktop-contract/management-tasks").TaskRequest} request @returns {Promise<unknown>} */
async function manageTaskDraft(backend, project, request) {
  /** @type {Record<string,unknown>} */
  const payload = {
    ...request,
    projectId: project.logicalProjectId ?? project.id,
    executionProjectId: project.id,
  };
  delete payload.logicalProjectId;
  let modelNotice;
  if (request.operation === "taskDraftStart") {
    const selection = resolveNewConversationModel(
      backend.providers.catalog(project.models ?? [], project),
      backend.providers.lastAcceptedModel,
      true,
    );
    const model = selection.candidate;
    modelNotice = selection.notice;
    if (model?.providerId === "areal_openai") await backend.providers.ensureSubscription(project);
    if (model?.providerId) payload.model = { providerId: model.providerId, modelId: model.modelId };
    payload.parameters = {
      ...model?.parameters,
      ...(selection.rememberedEffort != null
        ? { reasoningEffort: selection.rememberedEffort }
        : {}),
    };
  }
  if (request.operation === "taskDraftSend") {
    payload.input = messageInput(backend, request);
    for (const key of ["text", "attachments", "mcpContent", "conversationQuotes"])
      delete payload[key];
  }
  const reading = request.operation === "taskDraftRead" || request.operation === "taskDraftHistory";
  const value = await backend.hostCall(reading ? "tasks.read" : "tasks.command", payload);
  if (request.operation === "taskDraftConfirm") project.model.setTask(readTask(value));
  if (modelRecord(value) && typeof value.threadId === "string" && !reading)
    await backend.refreshAfterAdmission(project, value.threadId);
  return modelNotice && modelRecord(value) ? { ...value, modelNotice } : value;
}
module.exports = {
  manageTaskDraft,
  taskDraftOperations: operations,
  isTaskDraftConfiguration,
  displayTaskDraftThread: displayThread,
};
