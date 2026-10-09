import type { Data } from "./services.js";

export function goalBudgetMessage(reason: string | null | undefined): string | undefined {
  if (reason === "GOAL_TOKEN_BUDGET") return "Token 预算不足，无法继续执行。请调整预算后恢复。";
  if (reason === "GOAL_TIME_BUDGET") return "已达到目标活动时间上限，请调整停止条件后恢复。";
  return undefined;
}

type ToolKind = "read" | "edit" | "search" | "list" | "command" | "wait" | "tool";
// Only established public tools get semantic categories. Unknown/plugin tools
// retain their names; a name containing "read" does not establish its behavior.
const toolKinds: Readonly<Record<string, ToolKind>> = {
  fs_read: "read", read_file: "read", skill_read: "read", plan_read: "read",
  fs_create: "edit", fs_write: "edit", fs_apply_patch: "edit", fs_apply_patches: "edit",
  write_file: "edit", edit_file: "edit", apply_patch: "edit",
  fs_list: "list", search_files: "search",
  run_command: "command", verify_command: "command", terminate_process: "command",
  read_process: "read", wait_process: "wait", agent_wait: "wait", agent_wait_any: "wait",
};
const specificActions: Readonly<Record<string, string>> = {
  skill_read: "读取技能", plan_read: "读取计划",
  read_process: "读取进程输出", terminate_process: "停止进程",
  agent_spawn: "创建子智能体", agent_spawn_configured: "创建子智能体",
  agent_wait: "等待子智能体", agent_wait_any: "等待子智能体",
};
function toolAction(item: Data): string {
  if (Object.hasOwn(specificActions, item.tool)) return specificActions[item.tool];
  const { kind } = toolPresentation(item);
  return kind === "tool" && item.tool ? `调用 ${item.tool}` : categoryLabels[kind];
}
const categoryLabels: Record<ToolKind, string> = {
  read: "读取文件", edit: "修改文件", search: "查找文件", list: "列出目录",
  command: "运行命令", wait: "等待任务", tool: "调用工具",
};

/** Action categories in first-observed order, not inferred outcomes or file counts. */
export function executionSummary(items: Data[]): string {
  const labels = new Set<string>();
  for (const item of items) {
    if (item.type !== "dynamicToolCall") continue;
    labels.add(toolAction(item));
  }
  return [...labels].join(" · ") || (items.some(item => item.type === "reasoning") ? "思考" : "执行活动");
}

/** Counts projected activities, not output polls or raw invocation records. */
export function executionOutcome(items: Data[]) {
  const views = items.filter(item => item.type === "dynamicToolCall").map(toolPresentation);
  return { failures: views.filter(view => view.failed).length,
    unfinished: views.some(view => view.running || view.status === "结果待确认") };
}

function runningToolLabel(item: Data): string {
  return `正在${toolAction(item)}…`;
}

export function activityLabel(project: Data, threadId: string, turn: Data) {
  if (!project.state?.connected) return "连接已中断，任务状态待同步";
  if (project.state?.interactions?.[threadId]?.data?.some((i: Data) => i.status === "pending"))
    return "等待你的确认或回答";
  if (turn.modelRetry) {
    const subject = turn.modelRetry.purpose === "summary" ? "上下文整理遇到网络问题" : "模型连接遇到网络问题";
    return `${subject}，正在重试（第 ${turn.modelRetry.retry} 次）…`;
  }
  const items = processItems(turn.items ?? [], turn.status);
  const activeProcess = items.findLast((item: Data) => item.type === "dynamicToolCall" && toolPresentation(item).running);
  if (activeProcess) return runningToolLabel(activeProcess);
  const last = items
    .filter(
      (i: Data) => i.type === "dynamicToolCall" || (i.type === "agentMessage" && i.text?.trim())
        || (i.type === "reasoning" && [...(i.summary ?? []), ...(i.content ?? [])].some((text: string) => text.trim())),
    )
    .at(-1);
  if (last?.type === "reasoning") return "正在思考…";
  if (last?.type === "dynamicToolCall")
    return last.status === "inProgress" ? runningToolLabel(last) : "等待模型继续…";
  return last?.text?.trim() ? "正在生成回复…" : "等待模型响应…";
}
export function toolPresentation(item: Data) {
  const args = item.arguments ?? {};
  const name = item.tool ?? "工具";
  const kind: ToolKind = Object.hasOwn(toolKinds, name) ? toolKinds[name] : "tool";
  const result = item.processResult ?? commandResult(item);
  const outcome = item.execution?.outcome ?? item.status;
  const stopped = ["interrupted", "cancelled"].includes(outcome) || result.stopReason === "process terminated"
    || ["interrupted", "cancelled"].includes(result.commandStatus)
    || (result.commandStatus === "terminated" && result.stopReason == null && item.success !== false && !["failed", "error"].includes(outcome));
  const unsettled = item.processUnsettled || result.state === "unknown" || ["unknown", "pending"].includes(outcome);
  const failed = !stopped && !unsettled && (
    result.stopReason != null || result.commandStatus === "terminated" ||
    ["failed", "error"].includes(outcome) ||
    item.success === false ||
    (typeof item.execution?.exitCode === "number" && item.execution.exitCode !== 0) ||
    result.commandStatus === "failed" || (typeof result.exitCode === "number" && result.exitCode !== 0));
  const processRunning = ["run_command", "verify_command"].includes(name) && (result.commandStatus === "running" || result.state === "running");
  const running = !stopped && !unsettled && (item.status === "inProgress" || processRunning);
  const search = args.pattern ?? args.query;
  const target = kind === "search" && search != null
    ? `${search}${args.path ? ` · ${args.path}` : ""}`
    : args.path ?? args.file_path ?? args.command ?? args.argv?.join(" ") ?? args.query ?? args.pattern ?? name;
  return {
    kind,
    running,
    failed,
    label: specificActions[name] ?? (kind === "tool" ? `调用 ${name}` : name === "fs_create" ? "创建" : { read: "读取", edit: "编辑", search: "搜索", list: "列出", command: "运行", wait: "等待" }[kind]),
    detail: name.startsWith("agent_") && Object.hasOwn(specificActions, name) ? "" : String(target),
    status: running
      ? "执行中"
      : failed
        ? "失败"
        : unsettled
          ? "结果待确认"
          : stopped
          ? "已停止"
          : "已完成",
  };
}

/** Keep event order; only adjacent public reasoning shares a disclosure. */
export function timelineItems(items: Data[]): Data[] {
  const result: Data[] = [];
  let reasoningGroup: Data | undefined;
  for (const item of items) {
    if (item.type === "modelContext" || (item.type === "agentMessage" && !item.text?.trim())) continue;
    if (item.type === "reasoning") {
      if (![...(item.summary ?? []), ...(item.content ?? [])].some((text: string) => text.trim())) continue;
      if (!reasoningGroup) {
        reasoningGroup = { id: `reasoning:${item.id}`, type: "reasoningGroup", items: [] };
        result.push(reasoningGroup);
      }
      reasoningGroup.items.push(item);
    } else {
      reasoningGroup = undefined;
      result.push(item);
    }
  }
  return result;
}

/** Parse only public tool results, never provider context. */
export function commandResult(item: Data): Data {
  if (!["run_command", "verify_command", "read_process", "terminate_process"].includes(item.tool)) return {};
  for (const part of item.contentItems ?? []) {
    try {
      const value = JSON.parse(part.text);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch { /* Non-JSON tool output remains available in details. */ }
  }
  return {};
}

const startsProcess = (item: Data) => item.type === "dynamicToolCall" && ["run_command", "verify_command"].includes(item.tool);
const hasProcessState = (result: Data) => ["running", "exited", "unknown"].includes(result.state)
  || ["running", "succeeded", "failed", "terminated", "cancelled", "interrupted"].includes(result.commandStatus);

/** One-to-one projection of a single turn. Only an unambiguous earlier Core
 * process start can own observations. Preserve raw members and explicit stop /
 * failed-read actions; consumers may hide processOwnerId rows, never delete them.
 */
export function processItems(items: Data[], turnStatus?: string): Data[] {
  const results = items.map(commandResult);
  const starts = new Map<string, number[]>();
  items.forEach((item, index) => {
    const key = results[index].processId;
    if (!startsProcess(item) || typeof key !== "string" || !key) return;
    starts.set(key, [...(starts.get(key) ?? []), index]);
  });
  const members = new Map<number, number[]>();
  const owners = new Map<number, string>();
  items.forEach((item, index) => {
    if (item.type !== "dynamicToolCall" || !["read_process", "terminate_process"].includes(item.tool)) return;
    const result = results[index], argumentKey = item.arguments?.processId;
    if (argumentKey && result.processId && argumentKey !== result.processId) return;
    const candidates = starts.get(result.processId ?? argumentKey);
    if (candidates?.length !== 1 || candidates[0] >= index) return;
    const start = candidates[0];
    members.set(start, [...(members.get(start) ?? []), index]);
    // A read that reports the process's nonzero exit is one process failure.
    // A read request error without process state stays independently visible.
    if (item.tool === "read_process" && (hasProcessState(result) || item.status === "inProgress")) owners.set(index, items[start].id);
  });
  return items.map((item, index) => {
    if (owners.has(index)) return { ...item, processOwnerId: owners.get(index) };
    if (!startsProcess(item) || typeof results[index].processId !== "string" || !results[index].processId) return item;
    const indices = [index, ...(members.get(index) ?? [])];
    const records = indices.map(i => items[i]);
    const states = indices.map(i => results[i]).filter(hasProcessState);
    const latest = states.at(-1) ?? results[index];
    const pages: Data[] = [];
    for (const i of indices) {
      if (items[i].tool === "terminate_process") continue;
      const page = results[i];
      if (i !== index && !hasProcessState(page)) continue;
      // Opaque Core cursors may prove an identical page, never compare or infer
      // byte offsets. Equal text without a cursor can be legitimate new output.
      const duplicate = typeof page.nextCursor === "string" && pages.some(previous => previous.nextCursor === page.nextCursor && previous.stdout === page.stdout && previous.stderr === page.stderr);
      if (!duplicate) pages.push(page);
    }
    return { ...item, processRecords: records, processResult: latest, processObservations: pages,
      processOutputIncomplete: indices.some(i => results[i].gap || results[i].truncated || results[i].outputIntegrity === "incomplete"),
      processOutputPending: [...indices].reverse().map(i => results[i]).find(page => typeof page.outputReadComplete === "boolean")?.outputReadComplete === false,
      processUnsettled: latest.state === "unknown" || (!!turnStatus && turnStatus !== "inProgress" && (latest.commandStatus === "running" || latest.state === "running")),
    };
  });
}

/** Compose readable conversation nodes from Core items without changing their identity or order. */
export function executionSegments(items: Data[], turnStatus: string): Data[] {
  const result: Data[] = [];
  let group: Data | undefined;
  for (const item of processItems(items, turnStatus)) {
    if (item.processOwnerId) continue;
    if (item.type === "modelContext" || (item.type === "agentMessage" && !item.text?.trim())) continue;
    if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "agentMedia") {
      result.push(item);
      group = undefined;
      continue;
    }
    if (!group) { group = { id: `execution:${item.id}`, type: "executionGroup", items: [] }; result.push(group); }
    group.items.push(item);
  }
  return result;
}
/** Only Core's explicit continuation origin identifies scheduler-authored input. */
export function goalContinuationLabel(turn: { goal?: { origin?: string; sequence?: number } }): string | null {
  return turn.goal?.origin === "continuation" ? `目标自动继续 · 第 ${turn.goal.sequence} 轮` : null;
}

// 分类只来自 Core 的结构化终态，不按错误正文反推执行事实。
const turnOutcomeLabels: Readonly<Record<string, string>> = {
  LLM_CONTEXT_WINDOW_EXCEEDED: "上下文超出限制",
  LLM_OUTPUT_TOKEN_LIMIT_EXCEEDED: "模型因输出长度限制结束响应",
  LLM_RESPONSE_TIMEOUT: "模型响应超时",
  AGENT_MAX_TURNS_EXCEEDED: "已达到模型执行轮数上限",
  AGENT_RUN_TIMEOUT: "已达到任务活动时间上限",
  LLM_RESPONSE_FAILED: "模型响应失败",
  HARNESS_INTERNAL_ERROR: "Harness 内部错误",
};

/** 图片 400 只给检查建议；结构化 code 优先，旧历史保持原展示。 */
export function turnFailureMessage(turn: Data): string {
  const message = turn.error?.message;
  const outcome = turn.error?.outcome;
  if (outcome?.code === "GOAL_TOKEN_BUDGET" && outcome.source === "core_goal_token_budget") return goalBudgetMessage("GOAL_TOKEN_BUDGET")!;
  if (outcome?.code === "AGENT_RUN_TIMEOUT" && outcome.details?.goalDeadlineReached === true) return goalBudgetMessage("GOAL_TIME_BUDGET")!;
  if (typeof outcome?.code === "string" && outcome.code) {
    const label = Object.hasOwn(turnOutcomeLabels, outcome.code) ? turnOutcomeLabels[outcome.code] : "未知终止原因";
    const imageAdvice = outcome.details?.httpStatus === 400 && turn.items?.some((item: Data) =>
      item.type === "userMessage" && item.content?.some((part: Data) => part.type === "image"),
    ) ? "。这条消息包含图片，请确认所选模型支持图片输入，或移除图片后重试。" : "";
    return `${label}（${outcome.code}）${message ? `：${message}` : ""}${imageAdvice}`;
  }
  const budget = goalBudgetMessage(message);
  if (budget) return budget;
  if (message === "turn deadline exceeded") return "任务执行超时，可重新发送或新建任务。";
  if (message === "model HTTP status 400 Bad Request" && turn.items?.some((item: Data) =>
    item.type === "userMessage" && item.content?.some((part: Data) => part.type === "image"),
  )) return `${message}。这条消息包含图片，请确认所选模型支持图片输入，或移除图片后重试。`;
  return message ?? JSON.stringify(turn.error);
}
