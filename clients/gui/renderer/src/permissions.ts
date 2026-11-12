import type { Data } from "./services.js";
import type { MessageId } from "./i18n/messages.js";
export type PermissionPreset = "ask" | "autoReview" | "fullAccess";
export type PermissionMode =
  | PermissionPreset
  | "plan"
  | "auto"
  | "custom"
  | "readOnly"
  | "restricted"
  | "unsupported";
export const permissionChoices = [
  { id: "ask", labelId: "chat.permissions.ask", descriptionId: "chat.permissions.askDescription" },
  {
    id: "autoReview",
    labelId: "chat.permissions.autoReview",
    descriptionId: "chat.permissions.autoReviewDescription",
  },
  {
    id: "fullAccess",
    labelId: "chat.permissions.fullAccess",
    descriptionId: "chat.permissions.fullAccessDescription",
  },
] as const satisfies readonly {
  id: PermissionPreset;
  labelId: MessageId;
  descriptionId: MessageId;
}[];
// 未知工具继续审批；只豁免已知的内置读取操作，不按名称前缀猜测副作用。
export const readTools = [
  "fs_read",
  "fs_list",
  "read_file",
  "search_files",
  "skill_load",
  "skill_resource_read",
  "skill_read",
  "plan_read",
  "plan_update",
  "task_state",
  "read_process",
  "wait_process",
  "agent_read",
  "agent_wait",
  "agent_wait_any",
];
const planInstructions =
  "\n\n[AReaL Harness: plan mode]\n当前处于计划模式。只进行读取、分析、澄清和计划整理，不修改文件、不执行有副作用的操作、不启动写入任务。给出可执行的计划后结束本轮，等待用户批准。用户在界面点击批准并执行后才会切换到执行模式。\n[/AReaL Harness: plan mode]";
export function permissionOptions(mode: PermissionPreset, previous: Data = {}) {
  return { ...previous, permissionPreset: mode, approvalTools: [], preapprovedTools: [] };
}
export function planModeOptions(enabled: boolean, previous: Data = {}) {
  const prior = previous.appendInstructions ?? "";
  const instructions = prior.endsWith(planInstructions)
    ? prior.slice(0, -planInstructions.length)
    : prior;
  return {
    ...previous,
    readOnly: enabled,
    appendInstructions: instructions + (enabled ? planInstructions : ""),
  };
}
export function permissionMode(configuration: Data): PermissionMode {
  const options = configuration.options ?? {};
  if (configuration.readOnly || configuration.profile?.readOnly || options.readOnly) {
    return options.appendInstructions?.endsWith(planInstructions) ? "plan" : "readOnly";
  }
  if (["ask", "autoReview", "fullAccess"].includes(options.permissionPreset)) {
    const effective = configuration.permissions;
    if (!effective) return "unsupported";
    if (
      options.permissionPreset === "fullAccess" &&
      (!effective.fullAccessAvailable || effective.resources !== "deployment")
    )
      return "restricted";
    if (options.permissionPreset === "autoReview" && effective.reviewer !== "model") return "ask";
    return options.permissionPreset;
  }
  const approvals = options.approvalTools ?? [],
    approved = options.preapprovedTools ?? [];
  if (
    approvals.length === 1 &&
    approvals[0] === "*" &&
    approved.length === readTools.length &&
    readTools.every((name) => approved.includes(name))
  )
    return "ask";
  return approvals.length || approved.length ? "custom" : "auto";
}
export function canExecutePlan(config: Data, thread: Data, queue: Data = {}) {
  const last = thread.turns?.at(-1);
  // A current mode toggle cannot turn an older normal answer into a plan.
  // Core records the configuration used by each turn in authoritative history.
  return (
    permissionMode(config) === "plan" &&
    !config.profile?.readOnly &&
    last?.status === "completed" &&
    permissionMode(last.configuration ?? {}) === "plan" &&
    last.items?.some((item: Data) => item.type === "agentMessage" && item.text?.trim()) &&
    !(queue.items ?? []).some(
      (item: Data) => item.status === "pending" || item.status === "running",
    )
  );
}
