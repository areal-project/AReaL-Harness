import type { Data } from "./services.js";
export type PermissionMode = "plan" | "ask" | "auto";
export const permissionChoices = [
  { id: "plan", label: "计划", description: "先只读分析并制定计划，确认后再执行。" },
  { id: "ask", label: "修改前询问", description: "读取无需确认；修改、命令及外部工具执行前询问。" },
  { id: "auto", label: "自动编辑", description: "在已授权的工作区内自动编辑，仍遵守部署限制。" },
] as const;
// 未知工具继续审批；只豁免已知的内置读取操作，不按名称前缀猜测副作用。
export const readTools = ["fs_read", "fs_list", "read_file", "search_files", "skill_read", "plan_read", "plan_update", "task_state", "read_process", "wait_process", "agent_read", "agent_wait", "agent_wait_any"];
const planInstructions = "\n\n[AReaL Harness: plan mode]\n当前处于计划模式。只进行读取、分析、澄清和计划整理，不修改文件、不执行有副作用的操作、不启动写入任务。给出可执行的计划后结束本轮，等待用户批准。用户在界面点击批准并执行后才会切换到执行模式。\n[/AReaL Harness: plan mode]";
export function permissionOptions(mode: PermissionMode, previous: Data = {}) {
  if (mode === "plan") return planModeOptions(true, previous);
  const options = planModeOptions(false, previous);
  return { ...options, approvalTools: mode === "ask" ? ["*"] : [], preapprovedTools: mode === "ask" ? [...readTools] : [] };
}
export function planModeOptions(enabled: boolean, previous: Data = {}) {
  const prior = previous.appendInstructions ?? "";
  const instructions = prior.endsWith(planInstructions) ? prior.slice(0, -planInstructions.length) : prior;
  return { ...previous, readOnly: enabled, appendInstructions: instructions + (enabled ? planInstructions : "") };
}
export function permissionMode(configuration: Data): PermissionMode | "custom" | "readOnly" {
  const options = configuration.options ?? {};
  if (configuration.readOnly || configuration.profile?.readOnly || options.readOnly) {
    return options.appendInstructions?.endsWith(planInstructions) ? "plan" : "readOnly";
  }
  const approvals = options.approvalTools ?? [], approved = options.preapprovedTools ?? [];
  if (approvals.length === 1 && approvals[0] === "*" && approved.length === readTools.length && readTools.every(name => approved.includes(name))) return "ask";
  return approvals.length || approved.length ? "custom" : "auto";
}
export function canExecutePlan(config: Data, thread: Data, queue: Data = {}) {
  const last = thread.turns?.at(-1);
  // A current mode toggle cannot turn an older normal answer into a plan.
  // Core records the configuration used by each turn in authoritative history.
  return permissionMode(config) === "plan" && !config.profile?.readOnly && last?.status === "completed"
    && permissionMode(last.configuration ?? {}) === "plan"
    && last.items?.some((item: Data) => item.type === "agentMessage" && item.text?.trim())
    && !(queue.items ?? []).some((item: Data) => item.status === "pending" || item.status === "running");
}
