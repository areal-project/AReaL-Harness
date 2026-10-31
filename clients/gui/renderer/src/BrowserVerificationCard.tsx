import { useI18n } from "./i18n/IntlProvider.js";
import { commandResult } from "./conversationPresentation.js";
import { verifiedWrittenFiles } from "./TurnFileSummary.js";
import { SentAttachment } from "./MessageAttachment.js";
import { Button } from "./components/ui/button.js";
import type { Action, Data } from "./services.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";

function recordedResult(item: Data): Data | null {
  if (item?.type !== "dynamicToolCall" || item.status !== "completed" || item.success !== true)
    return null;
  for (const part of item.contentItems ?? []) {
    if (part.type !== "inputText" && part.type !== "text") continue;
    try {
      const value = JSON.parse(part.text);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      /* Keep the original Item available in conversation. */
    }
  }
  return null;
}

/** A read-only view of Core Items. It never upgrades a command exit or image to page success. */
export function BrowserVerificationCard({
  thread,
  projectId,
  action,
  onReview,
  onTool,
  trialActive = false,
}: {
  thread: Data;
  projectId: string;
  action: Action;
  onReview: (turnId: string) => void;
  onTool: (itemId: string) => void;
  trialActive?: boolean;
}) {
  const { t } = useI18n();
  const entries: { turn: Data; item: Data; index: number }[] = [];
  for (const turn of thread.turns ?? [])
    for (const item of turn.items ?? []) entries.push({ turn, item, index: entries.length });
  const browser = entries.filter(
    (entry) =>
      entry.item.tool === "browser_v1" &&
      ["observe", "capture"].includes(entry.item.arguments?.operation) &&
      recordedResult(entry.item),
  );
  const latest = browser.at(-1);
  const latestCapture = browser
    .filter((entry) => entry.item.arguments?.operation === "capture")
    .at(-1);
  const diagnostics = entries.filter(
    (entry) =>
      entry.item.tool === "browser_v1" &&
      entry.item.arguments?.operation === "diagnostics" &&
      recordedResult(entry.item),
  );
  const latestDiagnostics = diagnostics.at(-1);
  const writes = entries.filter((entry) => verifiedWrittenFiles([entry.item]).size > 0);
  const change = writes.at(-1);
  const checks = entries.filter(
    (entry) =>
      ["verify_command", "read_process"].includes(entry.item.tool) &&
      commandResult(entry.item)?.verification?.schema === "areal.verification.v1",
  );
  const check = checks.at(-1);
  const services = entries.filter((entry) =>
    ["development_service_start", "development_service_inspect"].includes(entry.item.tool),
  );
  // 首次回执之前保留折叠摘要的位置，避免展示观察结果时改变刚采集的原生视口。
  const observation = latest ? recordedResult(latest.item) : null;
  const capture = (latestCapture?.item.contentItems ?? []).find(
    (part: Data) =>
      part.type === "arealMedia" &&
      part.modality === "image" &&
      typeof part.media?.uri === "string",
  );
  const checkResult = check ? commandResult(check.item) : null;
  const receipt =
    checkResult?.verification?.schema === "areal.verification.v1" ? checkResult.verification : null;
  const checkAfterChange = !change || (!!check && check.index > change.index);
  const observedAfterChange = !!latest && (!change || latest.index > change.index);
  const capturedAfterChange = !!latestCapture && (!change || latestCapture.index > change.index);
  const changedFiles = change ? [...verifiedWrittenFiles([change.item]).keys()] : [];
  const recentService = services.at(-1);
  const itemLink = (item: Data, label: string) => (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => onTool(item.id)}
      title={`Core Item ${item.id}`}
      className="h-auto max-w-full justify-start truncate px-1"
    >
      {label} · {item.id}
    </Button>
  );
  return (
    <SettingsDisclosure
      className="border-t border-border p-3 text-ui-sm"
      aria-label="浏览器验证结果"
      title="浏览器验证结果"
    >
      <p className="text-foreground-subtle">{t("common.browserVerification.source")}</p>
      {trialActive && <p role="status">{t("common.browserVerification.trialActive")}</p>}
      <dl className="mt-2 grid gap-2">
        <div>
          <dt className="font-medium">行为检查</dt>
          <dd>
            {receipt && checkAfterChange
              ? receipt.sourceUnchanged === true && receipt.exitCode === 0
                ? "命令检查通过；同页业务断言尚未验证"
                : receipt.exitCode !== 0
                  ? `命令检查失败（退出码 ${receipt.exitCode}）`
                  : "检查期间源码变化，结果待核对"
              : "未验证当前改动；需要明确的行为断言"}
          </dd>
          {check && itemLink(check.item, "检查回执")}
        </div>
        <div>
          <dt className="font-medium">页面观察</dt>
          <dd>
            {!latest
              ? "尚未观察当前页"
              : observedAfterChange
                ? `${observation?.url ?? "当前页"} · ${observation?.capturedAt ?? "采集时间未知"}`
                : "最近页面观察早于源码改动，需要等待已知状态或 HMR 后重新观察"}
          </dd>
          {latest && itemLink(latest.item, "观察回执")}
          {latestCapture && latestCapture !== latest && itemLink(latestCapture.item, "截图回执")}
          {capture && (
            <SentAttachment
              part={{ type: "image", uri: capture.media.uri, name: "页面截图" }}
              projectId={projectId}
              threadId={thread.id}
              action={action}
            />
          )}
        </div>
        {latestDiagnostics && (
          <div>
            <dt className="font-medium">页面诊断</dt>
            <dd>
              {(() => {
                const result = recordedResult(latestDiagnostics.item)!;
                return `${result.kind === "network" ? "网络" : "Console"} · ${result.events?.length ?? 0} 条 · ${result.loss ? "存在缺口" : "无已知缺口"}`;
              })()}
            </dd>
            {itemLink(latestDiagnostics.item, "诊断来源与回执")}
          </div>
        )}
        <div>
          <dt className="font-medium">视觉判断</dt>
          <dd>{capture && capturedAfterChange ? "已采集截图，尚待判断" : "未验证当前改动"}</dd>
        </div>
        <div>
          <dt className="font-medium">源码差异</dt>
          <dd>
            {change ? (
              <>
                <span>{changedFiles.join("、")}</span>{" "}
                <Button size="sm" variant="ghost" onClick={() => onReview(change.turn.id)}>
                  查看本轮差异
                </Button>
                {itemLink(change.item, "写入回执")}
              </>
            ) : (
              "没有关联的 Core 文件写入回执"
            )}
          </dd>
        </div>
        {recentService && (
          <div>
            <dt className="font-medium">开发服务</dt>
            <dd>{itemLink(recentService.item, "受管进程回执")}</dd>
          </div>
        )}
        <div>
          <dt className="font-medium">未验证项</dt>
          <dd>页面加载的构建身份、刷新后的行为、人工视觉结论。</dd>
        </div>
      </dl>
    </SettingsDisclosure>
  );
}
