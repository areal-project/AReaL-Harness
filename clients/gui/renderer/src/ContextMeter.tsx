import { useI18n } from "./i18n/IntlProvider.js";
import { useState } from "react";
import { Button } from "./components/ui/button.js";
import type { ContextPart } from "../../packages/runtime-client/core.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./components/ui/popover.js";
import { contextLabels, tokenCount, useContextUsage } from "./contextUsage.js";
import { CloseIcon } from "./interfaceIcons.js";
import type { Action, Data } from "./services.js";

// 常显短列表（R-CHECK-019）：每类直接列出占用最多的几项，其余合并为一行，不再折叠。
const CATEGORY_CHILDREN = 3;
function Category({ part, total }: { part: ContextPart; total: number }) {
  const { t } = useI18n();
  const children = [...(part.children ?? [])].sort((a, b) => b.estimatedTokens - a.estimatedTokens);
  const rest = children.slice(CATEGORY_CHILDREN);
  return (
    <div className="context-category">
      <div className="context-category-row">
        <span className="context-category-name">
          <i className={`context-category-dot context-color-${part.kind}`} />
          {contextLabels[part.kind]}
        </span>
        <span className="context-category-value">≈{tokenCount(part.estimatedTokens)}</span>
        <span className="context-category-percent">
          {total > 0 ? Math.round((part.estimatedTokens / total) * 100) : 0}%
        </span>
      </div>
      {children.slice(0, CATEGORY_CHILDREN).map((child, index) => (
        <div className="context-category-child" key={`${child.name}:${index}`}>
          <span>{child.name}</span>
          <span>≈{tokenCount(child.estimatedTokens)}</span>
        </div>
      ))}
      {rest.length > 0 && (
        <div className="context-category-child">
          <span>{t("common.context.otherItems", { count: rest.length })}</span>
          <span>≈{tokenCount(rest.reduce((sum, child) => sum + child.estimatedTokens, 0))}</span>
        </div>
      )}
    </div>
  );
}

export function ContextMeter({
  project,
  thread,
  action,
  anchor,
}: {
  project: Data;
  thread?: Data;
  action: Action;
  anchor?: HTMLElement | null;
}) {
  const { t } = useI18n();
  const { result, busy, error, read } = useContextUsage(project, thread, action);
  const [open, setOpen] = useState(false);
  const reading = result?.contextUsage,
    budget = reading?.budget,
    estimate = reading?.kind === "ready" ? reading.estimate : null;
  const percent =
    estimate && budget && budget.windowTokens > 0
      ? Math.min(100, (estimate.tokens / budget.windowTokens) * 100)
      : null;
  const reservePercent =
    percent !== null && budget
      ? Math.min(100 - percent, (budget.outputReserveTokens / budget.windowTokens) * 100)
      : 0;
  const available =
    estimate && budget && budget.windowTokens > 0
      ? Math.max(0, budget.inputLimitTokens - estimate.tokens)
      : null;
  const capacitySource = budget
    ? {
        account: "账号报告",
        provider: "供应商报告",
        user: "生效容量",
        modelDefault: "参考默认值",
        fallback: "后备配置",
        model: "模型配置",
      }[budget.windowSource]
    : "";
  const reportOrigin = budget?.reportedWindowSource ?? budget?.windowSource;
  const reportedSource =
    reportOrigin === "account"
      ? "账号报告"
      : reportOrigin === "provider"
        ? "供应商报告"
        : "报告容量";
  const label =
    estimate && budget
      ? `上下文 ${tokenCount(estimate.tokens)} / ${budget.windowTokens > 0 ? tokenCount(budget.windowTokens) : t("chat.context.unlimited")} Token`
      : "查看上下文";
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void read();
      }}
    >
      <PopoverTrigger
        className="context-meter-trigger"
        aria-label={t("chat.context.occupancy")}
        title={label}
        data-testid="context-meter"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle className="context-ring-track" cx="12" cy="12" r="8" />
          <circle
            className="context-ring-value"
            cx="12"
            cy="12"
            r="8"
            pathLength="100"
            strokeDasharray={`${percent ?? 0} 100`}
          />
        </svg>
      </PopoverTrigger>
      <PopoverContent
        anchor={anchor}
        side="top"
        sideOffset={10}
        align="end"
        className="context-usage-popover context-meter-popover"
        data-testid="context-popover"
      >
        <div className="context-usage-header">
          <PopoverTitle>{t("chat.context.title")}</PopoverTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="context-usage-close"
            aria-label={t("chat.context.close")}
            onClick={() => setOpen(false)}
          >
            <CloseIcon size={16} />
          </Button>
        </div>
        <div className="context-usage-total">
          <strong>
            {percent !== null
              ? `${Math.round(percent)}%`
              : estimate
                ? `≈${tokenCount(estimate.tokens)}`
                : "—"}
            <small>
              {estimate
                ? percent !== null
                  ? t("chat.context.usedEstimate")
                  : t("chat.context.inputEstimate")
                : t("chat.context.noEstimate")}
            </small>
          </strong>
          <span>
            {estimate ? `≈${tokenCount(estimate.tokens)} / ` : ""}
            {budget?.windowTokens
              ? tokenCount(budget.windowTokens)
              : budget
                ? t("chat.context.unlimited")
                : "—"}{" "}
            Token
          </span>
        </div>
        {percent !== null && (
          <div className="context-capacity" aria-label={t("chat.context.allocation")}>
            <span className="context-capacity-input" style={{ width: `${percent}%` }} />
            <span className="context-capacity-reserve" style={{ width: `${reservePercent}%` }} />
          </div>
        )}
        {budget && (
          <>
            <div className="context-budget">
              <span>
                {t("chat.context.input", {
                  tokens: estimate ? `≈${tokenCount(estimate.tokens)}` : "—",
                })}
              </span>
              <span>
                {t("chat.context.reserve", { tokens: tokenCount(budget.outputReserveTokens) })}
              </span>
              <span>
                {t("chat.context.available", {
                  tokens: available !== null ? `≈${tokenCount(available)}` : "—",
                })}
              </span>
            </div>
            <div className="context-budget" aria-label={t("chat.context.source")}>
              <span>
                {budget.reportedWindowTokens != null ? reportedSource : capacitySource}{" "}
                {budget.reportedWindowTokens != null
                  ? tokenCount(budget.reportedWindowTokens)
                  : budget.windowTokens
                    ? tokenCount(budget.windowTokens)
                    : t("chat.context.unlimited")}
              </span>
              <span>
                {t("chat.context.userBudget", {
                  tokens:
                    budget.userBudgetTokens != null
                      ? tokenCount(budget.userBudgetTokens)
                      : t("chat.context.unset"),
                })}
              </span>
            </div>
            <div className="context-model">{reading?.basis.model}</div>
            {budget.userBudgetTokens != null &&
              budget.reportedWindowTokens != null &&
              budget.userBudgetTokens > budget.reportedWindowTokens && (
                <p className="context-model" role="status">
                  {t("chat.context.budgetCapped")}
                </p>
              )}
          </>
        )}
        {estimate && (
          <>
            <div className="context-composition-heading">
              <span>{t("chat.context.composition")}</span>
              <span>{t("chat.context.allEstimated")}</span>
            </div>
            <div className="context-composition" aria-label={t("chat.context.categories")}>
              {estimate.parts.map((part) => (
                <span
                  key={part.kind}
                  className={`context-color-${part.kind}`}
                  style={{ flexGrow: part.estimatedTokens }}
                  title={`${contextLabels[part.kind]} · ≈${tokenCount(part.estimatedTokens)}`}
                />
              ))}
            </div>
            <div className="context-categories">
              {estimate.parts.map((part) => (
                <Category part={part} total={estimate.tokens} key={part.kind} />
              ))}
            </div>
          </>
        )}
        {reading?.kind === "unavailable" && (
          <p role="status">
            {
              {
                awaitingRequest: "正在组装上下文",
                instructionBasisChanged: "模型配置已变更，等待新的上下文",
                modelUnavailable: "模型当前不可用",
              }[reading.reason]
            }
          </p>
        )}
        {!reading && !error && (
          <p role="status">{busy ? t("chat.context.reading") : t("chat.context.empty")}</p>
        )}
        {error && <p role="alert">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
