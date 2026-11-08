import { useI18n } from "./i18n/IntlProvider.js";
import { useState } from "react";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./components/ui/popover.js";
import {
  generationRate,
  generationStats,
  modelUsage,
  tokenCount,
  useContextUsage,
} from "./contextUsage.js";
import type { Action, Data } from "./services.js";

export function TurnUsage({
  project,
  thread,
  turn,
  action,
  inherited = false,
}: {
  project: Data;
  thread: Data;
  turn: Data;
  action: Action;
  inherited?: boolean;
}) {
  const { t, intl } = useI18n();
  const [open, setOpen] = useState(false),
    [scope, setScope] = useState<"session" | "turn">("session");
  const { result, busy, error } = useContextUsage(project, thread, action, open && !inherited);
  const usage = modelUsage(turn.usage),
    generation = generationStats(turn.generation),
    rate = generationRate(generation);
  // 没有可信用量时不放占位入口（design/spec/components/conversation-turn.yaml）。
  if (turn.status === "inProgress" || !usage) return null;
  const session = !inherited && scope === "session";
  const shownUsage = session ? result?.sessionUsage.usage : usage,
    shownGeneration = session ? result?.sessionUsage.generation : generation;
  const shownRate = generationRate(shownGeneration);
  const incomplete = session
    ? !result || result.sessionUsage.unknownTurns > 0 || result.sessionUsage.partialTurns > 0
    : !usage || !generation || generation.missingUsageRequests > 0;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="turn-usage-trigger"
        aria-label={t("chat.usage.open")}
        data-testid="turn-usage"
      >
        {tokenCount(usage.inputTokens + usage.outputTokens)} Token
        {rate !== null &&
          ` · ${intl.formatNumber(rate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} tok/s`}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="context-usage-popover"
        data-testid="turn-usage-popover"
      >
        <PopoverTitle>{t("chat.usage.title")}</PopoverTitle>
        {!inherited && (
          <div className="usage-scope" role="group" aria-label={t("chat.usage.scope")}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={scope === "session"}
              onClick={() => setScope("session")}
            >
              {t("chat.usage.session")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={scope === "turn"}
              onClick={() => setScope("turn")}
            >
              {t("chat.usage.turn")}
            </Button>
          </div>
        )}
        {inherited && <p>{t("chat.usage.inherited")}</p>}
        <dl className="usage-details">
          <div>
            <dt>{incomplete ? t("chat.usage.confirmed") : t("chat.usage.total")}</dt>
            <dd>
              {shownUsage
                ? intl.formatNumber(shownUsage.inputTokens + shownUsage.outputTokens)
                : "—"}
            </dd>
          </div>
          <div>
            <dt>{t("chat.usage.input")}</dt>
            <dd>{shownUsage ? intl.formatNumber(shownUsage.inputTokens) : "—"}</dd>
          </div>
          <div>
            <dt>{t("chat.usage.cachedInput")}</dt>
            <dd>{shownUsage ? intl.formatNumber(shownUsage.cachedInputTokens) : "—"}</dd>
          </div>
          <div>
            <dt>{t("chat.usage.output")}</dt>
            <dd>{shownUsage ? intl.formatNumber(shownUsage.outputTokens) : "—"}</dd>
          </div>
          <div>
            <dt>{t("chat.usage.rate")}</dt>
            <dd>
              {shownRate === null
                ? "—"
                : `${intl.formatNumber(shownRate, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} tok/s`}
            </dd>
          </div>
          {shownGeneration && (
            <div>
              <dt>{t("chat.usage.coverage")}</dt>
              <dd>
                {t("chat.usage.requests", {
                  measured: shownGeneration.measuredRequests,
                  total: shownGeneration.measuredRequests + shownGeneration.unmeasuredRequests,
                })}
              </dd>
            </div>
          )}
        </dl>
        {incomplete && (
          <p className="usage-status">
            {session && busy ? t("chat.usage.reading") : t("chat.usage.incomplete")}
          </p>
        )}
        {session && error && <p role="alert">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}
