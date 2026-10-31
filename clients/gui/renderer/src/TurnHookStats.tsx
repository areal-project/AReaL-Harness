import { useI18n } from "./i18n/IntlProvider.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";
import { HookStatsIcon } from "./interfaceIcons.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";
import type { Data } from "./services.js";

/** Read-only projection of this Core turn's execution journal. Configuration is
 * not an execution; opening/expanding records never issues a backend command. */
export function TurnHookStats({ turn }: { turn: Data }) {
  const { t } = useI18n();
  const runs = (turn.items ?? []).flatMap((item: Data) =>
    item.type === "dynamicToolCall"
      ? (item.execution?.hooks ?? []).map((hook: Data) => ({
          hook,
          tool: item.tool,
          itemId: item.id,
        }))
      : [],
  );
  const blocked = (hook: Data) => hook.outcome === "succeeded" && hook.result?.decision === "block";
  const unknown = runs.filter(({ hook }: Data) => hook.outcome === "unknown").length;
  const labels: Record<string, string> = {
    succeeded: "已完成",
    failed: "失败",
    running: "运行中",
    cancelled: "已取消",
    unknown: "结果未知",
  };
  const counts = [
    ["运行次数", runs.length],
    ["已阻止", runs.filter(({ hook }: Data) => blocked(hook)).length],
    ["失败", runs.filter(({ hook }: Data) => hook.outcome === "failed").length],
    ...(unknown ? [["结果未知", unknown]] : []),
  ];
  return (
    <Dialog>
      <DialogTrigger className="icon-button" aria-label="钩子统计" title="钩子统计">
        <HookStatsIcon width={14} height={14} />
      </DialogTrigger>
      <DialogContent className="hook-stats-dialog" overlayClassName="hook-stats-overlay">
        <DialogTitle className="hook-stats-title">钩子统计</DialogTitle>
        <dl className="hook-stats-counts">
          {counts.map(([label, count]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{count}</dd>
            </div>
          ))}
        </dl>
        <div className="hook-stats-history">
          <h3 id={`hook-history-${turn.id}`}>运行历史</h3>
          {runs.length ? (
            <ul aria-labelledby={`hook-history-${turn.id}`}>
              {runs.map(({ hook, tool, itemId }: Data, index: number) => (
                <li key={`${itemId}:${hook.operationId}:${index}`}>
                  <div className="hook-stats-row">
                    <span className="hook-stats-status">
                      {blocked(hook) ? "已阻止" : (labels[hook.outcome] ?? "状态未知")}
                    </span>
                    <span className="hook-stats-event">
                      {hook.event}
                      <span>{hook.name}</span>
                      <span>{tool}</span>
                    </span>
                  </div>
                  <SettingsDisclosure
                    className="hook-stats-details"
                    title={t("common.hooks.result")}
                  >
                    <pre aria-label={t("common.hooks.result")}>
                      {hook.result == null
                        ? "Core 未返回结果"
                        : JSON.stringify(hook.result, null, 2)}
                    </pre>
                  </SettingsDisclosure>
                </li>
              ))}
            </ul>
          ) : (
            <p>本轮没有钩子运行记录。</p>
          )}
        </div>
        <DialogDescription className="hook-stats-scope">
          仅包含 Core 返回的本轮工具钩子记录。
        </DialogDescription>
      </DialogContent>
    </Dialog>
  );
}
