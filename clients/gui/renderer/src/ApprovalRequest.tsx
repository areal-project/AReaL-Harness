import { useI18n } from "./i18n/IntlProvider.js";
import { useRef, useState } from "react";
import { Callout, Kbd } from "@areal/ui";
import { Button } from "./components/ui/button.js";
import { DecisionCard } from "./DecisionCard.js";
import { ChevronDown, CornerDownLeft, Globe, SquareTerminal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import type { Action, Data } from "./services.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";
import { errorText } from "./errors/errorCopy.js";

/** Acknowledgement locks this request; only a Core projection removes it or advances execution. */
export function ApprovalRequest({
  item,
  projectId,
  action,
}: {
  item: Data;
  projectId: string;
  action: Action;
}) {
  const { t } = useI18n();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [error, setError] = useState("");
  const canRemember = item.effectivePermissions?.rememberAllowed === true;
  const isBrowser = item.tool === "browser_v1";
  const browserPlan = isBrowser ? item.effectiveArguments?.plan : null;
  const respond = async (decision: "deny" | "allowOnce" | "allowSession" | "allowProject") => {
    if (inFlight.current || submitted || unknown) return;
    if ((decision === "allowSession" || decision === "allowProject") && !canRemember) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action("respond", {
        projectId,
        threadId: item.threadId,
        requestId: item.requestId,
        decision,
      });
      setSubmitted(true);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (failure.submissionUnknown) setUnknown(true);
      setError(failure.submissionUnknown ? t("errors.approvalUnknown") : errorText(t, cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await action("manage", { projectId, threadId: item.threadId, operation: "interactions" });
      setUnknown(false);
      setError("");
    } catch (cause) {
      setError(`${t("errors.approvalRefreshFailed")}${errorText(t, cause)}`);
    } finally {
      setBusy(false);
    }
  };
  const locked = busy || submitted || unknown;
  const permissionJustification =
    typeof item.effectiveArguments?.permissionRequest?.justification === "string"
      ? item.effectiveArguments.permissionRequest.justification
      : undefined;
  const summary = [
    item.reason,
    item.justification,
    permissionJustification,
    item.effectiveArguments?.purpose,
  ].find((value) => typeof value === "string" && value.trim());
  const argvCommand = Array.isArray(item.effectiveArguments?.argv)
    ? item.effectiveArguments.argv
        .filter((part: unknown): part is string => typeof part === "string")
        .map((part: string) => (/\s/.test(part) ? JSON.stringify(part) : part))
        .join(" ")
    : "";
  const command =
    typeof item.effectiveArguments?.command === "string"
      ? item.effectiveArguments.command
      : argvCommand
        ? argvCommand
        : browserPlan?.operation === "command" && browserPlan.parameters?.command != null
          ? JSON.stringify(browserPlan.parameters.command, null, 2)
          : "";
  const isTerminal = Boolean(command) || item.tool === "run_command";
  const fallbackActionLabel = isBrowser
    ? "执行浏览器操作"
    : isTerminal
      ? "运行命令"
      : `执行 ${item.tool}`;
  return (
    <DecisionCard
      kind="approval"
      label={isBrowser ? "浏览器" : isTerminal ? "终端" : "工具"}
      icon={isBrowser ? <Globe /> : <SquareTerminal />}
      busy={busy}
      error={error}
      onKeyDown={(e) => {
        if (
          e.key !== "Escape" ||
          e.defaultPrevented ||
          locked ||
          !(e.target as HTMLElement).closest(".decision-card")
        )
          return;
        e.preventDefault();
        e.stopPropagation();
        void respond("deny");
      }}
      message={submitted ? "已提交，等待执行状态更新。" : undefined}
      detailsLabel={t("decision.requestDetails")}
      detailsExpandLabel={t("settings.settingsDisclosure.expand")}
      detailsCollapseLabel={t("settings.settingsDisclosure.collapse")}
      details={
        <>
          <dl className="approval-request-context">
            {typeof item.reason === "string" && item.reason && (
              <div>
                <dt>{t("decision.reason")}</dt>
                <dd>{item.reason}</dd>
              </div>
            )}
            {typeof item.justification === "string" &&
              item.justification &&
              item.justification !== item.reason && (
                <div>
                  <dt>{t("decision.justification")}</dt>
                  <dd>{item.justification}</dd>
                </div>
              )}
            {typeof item.effectiveArguments?.purpose === "string" &&
              item.effectiveArguments.purpose && (
                <div>
                  <dt>{t("decision.purpose")}</dt>
                  <dd>{item.effectiveArguments.purpose}</dd>
                </div>
              )}
          </dl>

          {browserPlan ? (
            <div className="approval-preview approval-browser-preview">
              <p>
                页面：{browserPlan.url}
                {browserPlan.origin ? `（${browserPlan.origin}）` : ""}
              </p>
              <p>
                操作：{browserPlan.action?.kind ?? browserPlan.operation}
                {browserPlan.target
                  ? ` · ${browserPlan.target.role} ${browserPlan.target.name} [${browserPlan.target.ref}]`
                  : ""}
              </p>
              {browserPlan.operation === "command" && (
                <pre>
                  {JSON.stringify(
                    {
                      command: browserPlan.parameters?.command,
                      pages: browserPlan.target?.pages,
                    },
                    null,
                    2,
                  )}
                </pre>
              )}
              {Array.isArray(browserPlan.steps) && (
                <ol aria-label="本次批准的浏览步骤" className="list-decimal pl-5">
                  {browserPlan.steps.map((step: Data, index: number) => (
                    <li key={index}>
                      {step.action?.kind ?? step.operation}
                      {step.target?.ref
                        ? ` · ${step.target.role} ${step.target.name} [${step.target.ref}]`
                        : ""}
                      {step.action?.kind === "wait"
                        ? ` · ${step.action.timeoutMs} 毫秒 · ${step.action.condition ? JSON.stringify(step.action.condition) : "固定延时"}`
                        : ""}
                      {step.action?.kind === "scroll"
                        ? ` · 滚动视口：${step.action.deltaX}, ${step.action.deltaY}`
                        : ""}
                      {step.action?.kind === "selectOption"
                        ? ` · 选项值：${step.action.value}`
                        : ""}
                      {step.action?.kind === "setChecked"
                        ? ` · 选中：${step.action.checked ? "是" : "否"}`
                        : ""}
                      {step.action?.kind === "fill" ? ` · 填写：${step.action.value}` : ""}
                      {["press", "pressAt"].includes(step.action?.kind)
                        ? ` · 按键：${step.action.key}`
                        : ""}
                      {["clickAt", "pressAt"].includes(step.action?.kind)
                        ? ` · 截图坐标：${step.action.x}, ${step.action.y}`
                        : ""}
                      {step.action?.kind === "drag"
                        ? ` · 截图拖动：${step.action.fromX}, ${step.action.fromY} → ${step.action.toX}, ${step.action.toY}`
                        : ""}
                    </li>
                  ))}
                </ol>
              )}
              {browserPlan.operation === "openDocument" && browserPlan.document?.scope && (
                <div>
                  <p>
                    {t("operations.documentFile")}
                    {browserPlan.document.scope.canonicalFile}
                  </p>
                  <p>
                    {browserPlan.document.scope.kind === "workspaceDirectory"
                      ? `${t("operations.documentDirectory")}${browserPlan.document.scope.canonicalRoot}`
                      : t("operations.documentExactFile")}
                  </p>
                  {browserPlan.document.scope.kind === "workspaceDirectory" && (
                    <p>{t("operations.documentStaticScope")}</p>
                  )}
                </div>
              )}
              {browserPlan.targetUrl && (
                <p>
                  目标地址：{browserPlan.targetUrl}（{browserPlan.targetOrigin}）
                </p>
              )}
              {browserPlan.action?.kind === "wait" && (
                <p>
                  等待：{browserPlan.action.timeoutMs} 毫秒 ·{" "}
                  {browserPlan.action.condition
                    ? JSON.stringify(browserPlan.action.condition)
                    : "固定延时"}
                </p>
              )}
              {browserPlan.action?.kind === "scroll" && (
                <p>
                  {t("operations.scrollViewport")}
                  {browserPlan.action.deltaX}, {browserPlan.action.deltaY}
                </p>
              )}
              {browserPlan.action?.kind === "selectOption" && (
                <p>
                  {t("operations.optionValue")}
                  {browserPlan.action.value}
                </p>
              )}
              {browserPlan.action?.kind === "setChecked" && (
                <p>
                  {t("operations.checked")}
                  {browserPlan.action.checked ? t("operations.yes") : t("operations.no")}
                </p>
              )}
              {browserPlan.action?.kind === "fill" && <p>填写：{browserPlan.action.value}</p>}
              {browserPlan.action?.kind === "press" && <p>按键：{browserPlan.action.key}</p>}
              {browserPlan.target?.semantics?.kind === "public_search" && (
                <div>
                  <p>搜索内容：{browserPlan.target.semantics.query}</p>
                  <SettingsDisclosure title="本次提交的表单字段">
                    <pre>
                      {JSON.stringify(browserPlan.target.semantics.submittedFields, null, 2)}
                    </pre>
                  </SettingsDisclosure>
                </div>
              )}
              <Callout tone="warning">目标页面或控件变化后，本次批准会失效。</Callout>
            </div>
          ) : (
            <pre className="approval-preview">
              {JSON.stringify(item.effectiveArguments, null, 2)}
            </pre>
          )}
          {canRemember && (
            <SettingsDisclosure className="approval-scope-details" title="授权范围说明">
              <p>
                {browserPlan
                  ? browserPlan.targetOrigin
                    ? t("common.approval.rememberPage")
                    : "记住的授权绑定当前页面、控制代次和具体操作；人工接管后重新审批。"
                  : t("common.approval.rememberArgs")}
              </p>
            </SettingsDisclosure>
          )}
        </>
      }
      footer={
        unknown ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void refresh()}
          >
            核对待审批状态
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={t("decision.denyShortcut", { label: t("decision.deny") })}
              disabled={locked}
              onClick={() => void respond("deny")}
            >
              {t("decision.deny")}
              <Kbd variant="secondary">Esc</Kbd>
            </Button>
            {canRemember ? (
              <div className="approval-split">
                <Button
                  type="button"
                  size="sm"
                  aria-label="允许一次"
                  disabled={locked}
                  onClick={() => void respond("allowOnce")}
                >
                  {busy ? "提交中…" : "允许一次"}
                  <Kbd variant="primary">
                    <CornerDownLeft size={12} />
                  </Kbd>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        type="button"
                        size="icon-sm"
                        aria-label="更多授权范围"
                        disabled={locked}
                      >
                        <ChevronDown />
                      </Button>
                    }
                  />
                  <DropdownMenuContent side="top" align="end" sideOffset={8} className="w-72">
                    <DropdownMenuItem disabled={locked} onClick={() => void respond("allowOnce")}>
                      <span className="flex flex-col items-start gap-0.5 py-1">
                        <span>允许一次</span>
                        <small className="text-ui-sm text-foreground-subtle">仅批准本次请求</small>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={locked}
                      onClick={() => void respond("allowSession")}
                    >
                      <span className="flex flex-col items-start gap-0.5 py-1">
                        <span>本任务允许此操作</span>
                        <small className="text-ui-sm text-foreground-subtle">
                          仅适用于当前任务的相同操作
                        </small>
                      </span>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={locked}
                      onClick={() => void respond("allowProject")}
                    >
                      <span className="flex flex-col items-start gap-0.5 py-1">
                        <span>本项目允许此操作</span>
                        <small className="text-ui-sm text-foreground-subtle">
                          仅适用于当前项目的相同操作
                        </small>
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={locked}
                onClick={() => void respond("allowOnce")}
              >
                {busy ? "提交中…" : "允许一次"}
                <Kbd variant="primary">
                  <CornerDownLeft size={12} />
                </Kbd>
              </Button>
            )}
          </>
        )
      }
    >
      <h3 className="decision-card-title">{summary || `是否允许${fallbackActionLabel}？`}</h3>
      <p className="approval-target">
        {isBrowser
          ? (browserPlan?.document?.scope?.canonicalFile ??
            browserPlan?.targetOrigin ??
            browserPlan?.origin ??
            browserPlan?.url)
          : (item.effectiveArguments?.cwd ?? item.effectiveArguments?.path)}
      </p>
      {command && (
        <pre className="approval-command-summary" aria-label={t("decision.commandPreview")}>
          <code>{command}</code>
        </pre>
      )}
    </DecisionCard>
  );
}
