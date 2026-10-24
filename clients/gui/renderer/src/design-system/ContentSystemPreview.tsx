import { useState } from "react";
import { ApprovalRequest } from "../ApprovalRequest.js";
import { AskUserQuestion } from "../AskUserQuestion.js";
import { ConversationContentView } from "../ConversationContentView.js";
import { projectConversationContent, conversationContentToText } from "../conversationContent.js";
import { MessageResponse } from "../components/ai-elements/message.js";
import { TurnProgress } from "../TurnProgress.js";
import { TurnExecution } from "../TurnExecution.js";
import type { Action, Data } from "../services.js";

const nativeExamples = [
  { type: "metric", title: "完成进度", value: "24", unit: "项", note: "仅显示汇总数据" },
  { type: "key-value", title: "任务信息", items: [{ label: "工作区", value: "当前项目" }, { label: "状态", value: "待核对" }] },
  { type: "table", title: "检查结果", columns: ["项目", "结果"], rows: [["边界", "通过"], ["长文本", "完整保留"]] },
  { type: "bar-chart", title: "耗时对比", unit: "秒", items: [{ label: "解析", value: 12 }, { label: "展示", value: 5 }] },
  { type: "timeline", title: "处理步骤", items: [{ label: "读取", text: "核对输入来源" }, { label: "展示", text: "保留原始记录" }] },
  { type: "callout", title: "核对提醒", text: "模型内容只能展示，不能新增执行权限。", tone: "info" },
];
const fence = (value: unknown) => "```areal-ui\n" + JSON.stringify({ version: 1, ...value as object }) + "\n```\n";
const markdown = "正文与公式 $E=mc^2$，价格 $5-$10，代码 `$HOME`。\n\n$$\\ce{H2 + O2 -> H2O}$$\n\n```mermaid\nflowchart LR\n A[输入] --> B[展示]\n```\n\n";
const requests: Record<string, Data> = {
  shell: { tool: "shell", reason: "是否允许检查工作区中的文件？", effectiveArguments: { command: "python3 scripts/check.py --mode review " + "--note=原始参数保留 ".repeat(15), cwd: "/preview", purpose: "仅演示审批，不运行命令" }, effectivePermissions: { rememberAllowed: true } },
  browser: { tool: "browser_v1", reason: "是否允许填写当前页面？", effectiveArguments: { plan: { url: "https://example.com", origin: "https://example.com", operation: "fill", target: { name: "搜索", role: "textbox", ref: "a1" }, action: { kind: "fill", value: "示例" } } } },
  computer: { tool: "computer_v1", reason: "是否允许点击指定应用？", effectiveArguments: { plan: { operation: "click", target: { app: { name: "示例应用" } }, parameters: { x: 50, y: 80 } } } },
  file: { tool: "fs_create", reason: "是否允许创建说明文件？", effectiveArguments: { path: "/preview/说明.md", text: "仅本地样例，不创建文件" } },
};
// Long requests exercise the same production approval adapter; no command is executed.
const longReason = "是否允许检查当前目标？完整理由应在详情中阅读。".repeat(60) + " REASON_END";
const longCommand = "const result = await page.evaluate(() => { " + "console.log('保留完整命令'); ".repeat(180) + " }); COMMAND_END";
requests["browser-long"] = { tool: "browser_v1", reason: longReason, effectiveArguments: { purpose: "浏览器长请求示例", plan: { operation: "command", url: "https://example.com/" + "long-path/".repeat(80) + "TARGET_END", parameters: { command: { method: "evaluate", expression: longCommand } } } }, effectivePermissions: { rememberAllowed: true } };
requests["shell-long"] = { tool: "shell", justification: longReason, effectiveArguments: { command: longCommand, cwd: "/workspace/" + "目录/".repeat(100) + "TARGET_END" }, effectivePermissions: { rememberAllowed: true } };
requests["computer-long"] = { tool: "computer_v1", reason: longReason, effectiveArguments: { plan: { operation: "click", target: { app: { name: "应用名称".repeat(100) + "TARGET_END" } }, parameters: { text: longCommand } } } };
requests["file-long"] = { tool: "fs_create", effectiveArguments: { purpose: longReason, path: "/workspace/" + "目录/".repeat(100) + "TARGET_END", text: longCommand } };
function Decisions({ kind, state, questionMode }: { kind: string; state: string; questionMode: string }) {
  const [responses, setResponses] = useState(0);
  const action = (async (name: string) => {
    if (name === "manage") throw new Error("预览没有 Core 连接，草稿继续保留。");
    setResponses(value => value + 1);
    if (state === "busy") return new Promise(() => {});
    if (state === "unknown") throw Object.assign(new Error("模拟结果未知"), { submissionUnknown: true });
    if (state === "failed") throw new Error("模拟明确未受理");
    return {};
  }) as Action;
  const options = questionMode === "free" ? [] : questionMode === "long" ? ["完整阅读，自动换行并保持选择状态。".repeat(20), "需要调整"] : ["先核对边界", "先检查布局"];
  const questions = [{ id: "first", title: "希望先检查哪一项？", options, allowFreeText: true }, ...(questionMode === "multi" ? [{ id: "second", title: "还有什么需要补充？", options: [], allowFreeText: true }] : [])];
  return <><section aria-label="审批预览"><ApprovalRequest item={{ requestId: "preview-approval", threadId: "preview", ...requests[kind] }} projectId="preview" action={action} /></section>
    <section aria-label="提问预览"><AskUserQuestion item={{ requestId: "preview-question", threadId: "preview", questions }} projectId="preview" action={action} /></section>
    <p aria-label="预览调用记录">响应次数：{responses}。所有动作仅在本页记录。</p></>;
}
export function ContentSystemPreview({ dark }: { dark: boolean }) {
  const [mode, setMode] = useState("ready"), [kind, setKind] = useState("shell"), [state, setState] = useState("ready"), [questionMode, setQuestionMode] = useState("single");
  const source = mode === "diagram-error" ? '```mermaid\nthis is not a diagram\n```' : mode === "diagram-streaming" ? '```mermaid\nflowchart LR\n A[输入] --> B[' : mode === "streaming" ? '```areal-ui\n{"version":1,"type":"metric"' : mode === "invalid" ? '```areal-ui\n{"version":1,"type":"html","html":"<script>bad()</script>"}\n```' : markdown + nativeExamples.map(fence).join("\n");
  const streaming = mode === "streaming" || mode === "diagram-streaming";
  const blocks = projectConversationContent(source, !streaming, streaming);
  const failed = { id: "failed-tool", type: "dynamicToolCall", tool: "browser_v1", success: false, status: "completed", arguments: { operation: "command" }, contentItems: [{ type: "text", text: "审批拒绝" }] };
  return <section className="design-preview-panel content-system-preview" aria-label="内容与决策系统">
    <h2>内容与决策</h2><p>生产共享组件 · 本地状态样例。不会创建制品、调用服务或执行命令。</p>
    <div className="design-preview-controls">
      <label>内容状态<select aria-label="内容状态" value={mode} onChange={e => setMode(e.target.value)}>{["ready", "streaming", "invalid", "diagram-error", "diagram-streaming"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>审批类型<select aria-label="审批类型" value={kind} onChange={e => setKind(e.target.value)}>{Object.keys(requests).map(value => <option key={value}>{value}</option>)}</select></label>
      <label>响应状态<select aria-label="响应状态" value={state} onChange={e => setState(e.target.value)}>{["ready", "busy", "failed", "unknown"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>问题类型<select aria-label="问题类型" value={questionMode} onChange={e => setQuestionMode(e.target.value)}>{["single", "multi", "free", "long"].map(value => <option key={value}>{value}</option>)}</select></label>
    </div>
    <section aria-label="过程预览"><TurnProgress turn={{ id: "example", status: "completed", durationMs: 929000 }} connected settled summaryAvailable failures={1} unfinished={false} failureDetails={<pre>{JSON.stringify(failed, null, 2)}</pre>}><TurnExecution items={[failed]} turn={{ status: "completed" }} project={{}} threadId="preview" renderItem={() => <p>不应默认出现的失败工具行</p>} /></TurnProgress></section>
    <Decisions key={`${kind}:${state}:${questionMode}`} kind={kind} state={state} questionMode={questionMode} />
    <section aria-label="混合内容预览"><ConversationContentView blocks={blocks} markdown={text => <MessageResponse streaming={streaming} theme={dark ? "dark" : "light"}>{text}</MessageResponse>} interactive={() => <p>交互页面由原有制品宿主打开；此离线样例没有制品。</p>} /></section>
    <details><summary>查看文字降级</summary><pre className="content-system-plain">{conversationContentToText(blocks)}</pre></details>
  </section>;
}
