import { useI18n } from "./i18n/IntlProvider.js";
import { useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { DecisionCard } from "./DecisionCard.js";
import { ChevronDown, CornerDownLeft, Globe, SquareTerminal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
import type { Action, Data } from "./services.js";

/** Acknowledgement locks this request; only a Core projection removes it or advances execution. */
export function ApprovalRequest({ item, projectId, action }: { item: Data; projectId: string; action: Action }) {
  const { t } = useI18n();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const canRemember = item.effectivePermissions?.rememberAllowed === true;
  const isBrowser = item.tool === "browser_v1";
  const isComputer = item.tool === "computer_v1";
  const computerPlan = isComputer ? item.effectiveArguments?.plan : null;
  const browserPlan = isBrowser ? item.effectiveArguments?.plan : null;
  const respond = async (decision: "deny" | "allowOnce" | "allowSession" | "allowProject") => {
    if (inFlight.current || submitted || unknown) return;
    if ((decision === "allowSession" || decision === "allowProject") && !canRemember) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      await action("respond", { projectId, threadId: item.threadId, requestId: item.requestId, decision });
      setSubmitted(true);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (failure.submissionUnknown) setUnknown(true);
      setError(failure.submissionUnknown ? "审批结果未确认。请先读取 Core 当前待处理状态，不会自动重复提交。" : failure.message || "审批提交失败，请重试。");
    } finally { inFlight.current = false; setBusy(false); }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await action("manage", { projectId, threadId: item.threadId, operation: "interactions" });
      setUnknown(false); setError("");
    } catch (cause) { setError(`无法核对审批状态。${(cause as Error).message}`); }
    finally { setBusy(false); }
  };
  const locked = busy || submitted || unknown;
  const summary = [item.reason, item.justification, item.effectiveArguments?.purpose].find(value => typeof value === "string" && value.trim());
  const command = typeof item.effectiveArguments?.command === "string" ? item.effectiveArguments.command
    : browserPlan?.operation === "command" && browserPlan.parameters?.command != null ? JSON.stringify(browserPlan.parameters.command, null, 2) : "";
  return <DecisionCard kind="approval" label={isComputer ? t("chat.approval.computer") : isBrowser ? "浏览器" : item.effectiveArguments?.command ? "终端" : "工具"}
    icon={isBrowser ? <Globe /> : <SquareTerminal />} busy={busy} error={error}
    onKeyDown={(e) => {
      if (e.key !== "Escape" || e.defaultPrevented || locked || !(e.target as HTMLElement).closest(".decision-card")) return;
      e.preventDefault();
      e.stopPropagation();
      void respond("deny");
    }}
    message={submitted ? "已提交，等待执行状态更新。" : undefined}
    detailsLabel={t("decision.requestDetails")}
    details={<>
    <dl className="approval-request-context">
      {typeof item.reason === "string" && item.reason && <div><dt>{t("decision.reason")}</dt><dd>{item.reason}</dd></div>}
      {typeof item.justification === "string" && item.justification && item.justification !== item.reason && <div><dt>{t("decision.justification")}</dt><dd>{item.justification}</dd></div>}
      {typeof item.effectiveArguments?.purpose === "string" && item.effectiveArguments.purpose && <div><dt>{t("decision.purpose")}</dt><dd>{item.effectiveArguments.purpose}</dd></div>}
    </dl>

    {computerPlan && <div className="approval-preview">
      <p>{t('chat.approval.computerTarget')} · {computerPlan.target?.app?.name ?? computerPlan.target?.name ?? computerPlan.origin}</p>
      <pre>{JSON.stringify({ operation: computerPlan.operation, parameters: computerPlan.parameters }, null, 2)}</pre>
    </div>}
    {!isComputer && (browserPlan ? <div className="approval-preview approval-browser-preview">
      <p>页面：{browserPlan.url}{browserPlan.origin ? `（${browserPlan.origin}）` : ""}</p>
      <p>操作：{browserPlan.action?.kind ?? browserPlan.operation}{browserPlan.target ? ` · ${browserPlan.target.role} ${browserPlan.target.name} [${browserPlan.target.ref}]` : ""}</p>
      {browserPlan.operation === "command" && <pre>{JSON.stringify({ command: browserPlan.parameters?.command, pages: browserPlan.target?.pages }, null, 2)}</pre>}
      {Array.isArray(browserPlan.steps) && <ol aria-label="本次批准的浏览步骤" className="list-decimal pl-5">
        {browserPlan.steps.map((step: Data, index: number) => <li key={index}>
          {step.action?.kind ?? step.operation}
          {step.target?.ref ? ` · ${step.target.role} ${step.target.name} [${step.target.ref}]` : ""}
          {step.action?.kind === "wait" ? ` · ${step.action.timeoutMs} 毫秒 · ${step.action.condition ? JSON.stringify(step.action.condition) : "固定延时"}` : ""}
          {step.action?.kind === "scroll" ? ` · 滚动视口：${step.action.deltaX}, ${step.action.deltaY}` : ""}
          {step.action?.kind === "selectOption" ? ` · 选项值：${step.action.value}` : ""}
          {step.action?.kind === "setChecked" ? ` · 选中：${step.action.checked ? "是" : "否"}` : ""}
          {step.action?.kind === "fill" ? ` · 填写：${step.action.value}` : ""}
          {["press", "pressAt"].includes(step.action?.kind) ? ` · 按键：${step.action.key}` : ""}
          {["clickAt", "pressAt"].includes(step.action?.kind) ? ` · 截图坐标：${step.action.x}, ${step.action.y}` : ""}
          {step.action?.kind === "drag" ? ` · 截图拖动：${step.action.fromX}, ${step.action.fromY} → ${step.action.toX}, ${step.action.toY}` : ""}
        </li>)}
      </ol>}
      {browserPlan.targetUrl && <p>目标地址：{browserPlan.targetUrl}（{browserPlan.targetOrigin}）</p>}
      {browserPlan.action?.kind === "wait" && <p>等待：{browserPlan.action.timeoutMs} 毫秒 · {browserPlan.action.condition ? JSON.stringify(browserPlan.action.condition) : "固定延时"}</p>}
      {browserPlan.action?.kind === "scroll" && <p>{t("operations.scrollViewport")}{browserPlan.action.deltaX}, {browserPlan.action.deltaY}</p>}
      {browserPlan.action?.kind === "selectOption" && <p>{t("operations.optionValue")}{browserPlan.action.value}</p>}
      {browserPlan.action?.kind === "setChecked" && <p>{t("operations.checked")}{browserPlan.action.checked ? t("operations.yes") : t("operations.no")}</p>}
      {browserPlan.action?.kind === "fill" && <p>填写：{browserPlan.action.value}</p>}
      {browserPlan.action?.kind === "press" && <p>按键：{browserPlan.action.key}</p>}
      {browserPlan.target?.semantics?.kind === "public_search" && <div>
        <p>搜索内容：{browserPlan.target.semantics.query}</p>
        <details><summary>本次提交的表单字段</summary><pre>{JSON.stringify(browserPlan.target.semantics.submittedFields, null, 2)}</pre></details>
      </div>}
      <p>目标页面或控件变化后，本次批准会失效。</p>
    </div> : <pre className="approval-preview">{JSON.stringify(item.effectiveArguments, null, 2)}</pre>)}
    {canRemember && <details className="approval-scope-details"><summary>授权范围说明</summary><p>{browserPlan
      ? browserPlan.targetOrigin
        ? "记住的授权绑定当前页面、控制代次、目标和具体内容；人工接管或内容变化后重新审批。"
        : "记住的授权绑定当前页面、控制代次和具体操作；人工接管后重新审批。"
      : "记住的授权只适用于相同参数及权限条件，可在任务菜单的“已保存授权”中撤销。"}</p></details>}
    </>}
    footer={unknown ? <Button type="button" className="decision-button" variant="outline" disabled={busy} onClick={() => void refresh()}>核对待审批状态</Button> : <>
      <Button type="button" className="decision-button" variant="outline" aria-label="拒绝" disabled={locked} onClick={() => void respond("deny")}>拒绝<kbd aria-hidden="true">Esc</kbd></Button>
      {canRemember ? <div className="approval-split">
        <Button type="button" className="decision-button decision-primary" aria-label="允许一次" disabled={locked} onClick={() => void respond("allowOnce")}>{busy ? "提交中…" : "允许一次"}<kbd aria-hidden="true"><CornerDownLeft size={12} /></kbd></Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button type="button" className="decision-button approval-scope-trigger" aria-label="更多授权范围" disabled={locked}><ChevronDown /></Button>} />
          <DropdownMenuContent side="top" align="end" sideOffset={8} className="approval-scope-menu">
            <DropdownMenuItem disabled={locked} onClick={() => void respond("allowOnce")}>允许一次<small>仅批准本次请求</small></DropdownMenuItem>
            <DropdownMenuItem disabled={locked} onClick={() => void respond("allowSession")}>本任务允许此操作<small>仅适用于当前任务的相同操作</small></DropdownMenuItem>
            <DropdownMenuItem disabled={locked} onClick={() => void respond("allowProject")}>本项目允许此操作<small>仅适用于当前项目的相同操作</small></DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div> : <Button type="button" className="decision-button decision-primary" disabled={locked} onClick={() => void respond("allowOnce")}>{busy ? "提交中…" : "允许一次"}<kbd aria-hidden="true"><CornerDownLeft size={12} /></kbd></Button>}
    </>}>

    <h3 className="decision-card-title">{summary || (isComputer ? t("chat.approval.computerQuestion") : `是否允许${isBrowser ? "执行浏览器操作" : `执行 ${item.tool}`}？`)}</h3>
    <p className="approval-target">{isComputer ? computerPlan?.target?.app?.name ?? computerPlan?.target?.name ?? computerPlan?.origin : isBrowser ? browserPlan?.targetOrigin ?? browserPlan?.origin ?? browserPlan?.url : item.effectiveArguments?.cwd ?? item.effectiveArguments?.path}</p>
    {command && <pre className="approval-command-summary" aria-label={t("decision.commandPreview")}><code>{command}</code></pre>}

  </DecisionCard>;
}
