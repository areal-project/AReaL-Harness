import sampleImage from "../../../../../docs/assets/tui.png";
import type { Action, Data } from "../services.js";

export type SystemPhase = "running" | "completed" | "attention";
export type AgentMode = "mixed" | "completed" | "attention";
export function previewSubagents(mode: AgentMode) {
  const names = ["对话布局检查", "活动合同核对", "资源归属检查", "Worktree 交付审计", "等待状态核对", "后端实现检查", "正确性复查", "Electron 路径检查", "提交审查", "界面实现核对", "来源输入检查", "键盘与焦点检查", "窄窗布局检查", "主题和字号检查", "历史阅读检查", "操作边界核对"];
  return names.map((name, index) => ({ id: ["layout", "contract", "review"][index] ?? `agent-${index}`, name,
    state: index === 0 && mode !== "completed" ? (mode === "attention" ? "attention" as const : "running" as const) : "completed" as const,
    timeLabel: index === 0 && mode !== "completed" ? "刚刚" : `${54 + index}m ago`,
  }));
}
export type PreviewSource = { id: string; kind: "image" | "web" | "file"; name: string; location: string; note?: string };

export const previewSources: PreviewSource[] = [
  { id: "reference", kind: "image", name: "对话流参考.png", location: "用户提供 · 本地示例图片" },
  { id: "raft", kind: "web", name: "Raft 设计系统", location: "github.com/botiverse/raft-design" },
  { id: "brief", kind: "file", name: "对话流设计规范.md", location: "design-system/conversation-flow.md" },
  { id: "notes", kind: "file", name: "交互标注.md", location: "参考材料 / 交互标注.md" },
  { id: "unavailable", kind: "web", name: "历史页面引用", location: "example.com/reference", note: "该页面的历史快照不可用" },
];

export const previewProject = {
  id: "conversation-system-preview", root: "/preview/AReaL-Harness", pending: [],
  configurations: { main: { model: { providerId: "preview", modelId: "fixture" } } },
  models: [{ providerId: "preview", modelId: "fixture", displayName: "本地预览" }],
  state: { connected: true, threads: {}, interactions: {}, queues: {} },
};

// This fixture can only read its bundled image. It has no Desktop/Core connection.
export const previewMedia = (async (name: string, params: Data) => {
  if (name !== "media" || params.operation !== "read" || params.uri !== "areal://blob/system-image")
    throw new Error("设计预览仅提供本地图片读取。");
  const response = await fetch(sampleImage);
  if (!response.ok) throw new Error("示例图片读取失败");
  return { bytes: new Uint8Array(await response.arrayBuffer()), mime: "image/png" };
}) as Action;

function file(id: string, tool: string, path: string): Data {
  return { id, type: "dynamicToolCall", tool, arguments: { path }, status: "completed", success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify({ path: `workspace://repo/${path}`, size: 128, sha256: "a".repeat(64) }) }] };
}

export function systemActivities(phase: SystemPhase, revision: number): Data[] {
  const outcome = phase === "running" ? { commandStatus: "running" }
    : phase === "attention" ? { state: "unknown" } : { commandStatus: "succeeded", exitCode: 0 };
  const command = "pnpm --dir clients/gui typecheck --filter " + "conversation_reading_and_disclosure_".repeat(7);
  return [
    { id: "system-command", type: "dynamicToolCall", tool: "run_command", arguments: { command, cwd: "/preview/AReaL-Harness" },
      status: phase === "running" ? "inProgress" : "completed", success: phase === "completed" ? true : undefined,
      processResult: outcome, processUnsettled: phase === "attention",
      contentItems: [{ type: "inputText", text: JSON.stringify({ ...outcome,
        stdout: `> tsc --noEmit\n${Array.from({ length: 5 + revision * 3 }, (_, index) => `检查片段 ${index + 1}：已保留命令与输出的顺序。`).join("\n")}\n${phase === "completed" ? "类型检查通过。" : phase === "attention" ? "连接中断，退出结果尚未确认。" : "正在检查对话组件…"}` }) }] },
    ...Array.from({ length: 29 }, (_, index) => file(`system-read-${index}`, "fs_read", index === 0
      ? `src/${"very_long_conversation_reference_".repeat(6)}.tsx` : `src/conversation/section-${index + 1}.tsx`)),
  ];
}

export const editedActivity = file("system-edit", "fs_write", "src/conversation/ActivityGroup.tsx");
export const readActivity = file("system-design-read", "fs_read", "design/conversation-flow.md");
export const verificationActivity = { id: "system-edit-verification", type: "dynamicToolCall", tool: "run_command",
  arguments: { command: "node scripts/design-system-catalog.mjs", cwd: "/preview/AReaL-Harness" }, status: "completed", success: true,
  contentItems: [{ type: "inputText", text: JSON.stringify({ stdout: "设计目录引用检查通过。", commandStatus: "succeeded", exitCode: 0 }) }] };
export const editReview = async () => ({ turnId: "system-turn", scope: "tool", itemId: "system-edit",
  diff: "-const collapsed = false;\n+const collapsed = true;",
  files: [{ path: "src/conversation/ActivityGroup.tsx", additions: 1, deletions: 1,
    beforeText: "const collapsed = false;\n", afterText: "const collapsed = true;\n" }] });
