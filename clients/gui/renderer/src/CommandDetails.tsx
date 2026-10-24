import { CommandDetails as DetailsView } from "@areal/ui/wip";
import { useI18n } from "./i18n/IntlProvider.js";
import { CopyTextAction } from "./MessageActions.js";
import { commandResult, toolPresentation } from "./conversationPresentation.js";
import type { Data } from "./services.js";
import { ToolCallDuration } from "./ToolCallDuration.js";

/** Input / collected output / Core outcome, with original member records one
 * disclosure deeper. This view never requests more output or executes commands.
 */
export function CommandDetails({ item }: { item: Data }) {
  const { t } = useI18n();
  const view = toolPresentation(item);
  const output = commandResult(item);
  const process = item.processResult ?? output;
  const command = item.arguments?.command ?? item.arguments?.argv?.join(" ") ?? "";
  const rawText = (item.contentItems ?? []).map((part: Data) => part.text ?? "").join("\n");
  const pages: Data[] = item.processObservations ?? [output];
  const text = pages.map(page => [page.stdout, page.stderr].filter(Boolean).join("")).filter(Boolean).join("")
    || (output.error ? JSON.stringify(output.error, null, 2) : typeof output.prefix === "string" ? output.prefix : !Object.keys(output).length ? rawText : "");
  const reads = (item.processRecords ?? []).filter((record: Data) => record.tool === "read_process").length;
  return <DetailsView heading={t("chat.command.details")} status={view.status + (process.exitCode != null ? ` · 退出码 ${process.exitCode}` : "")} failed={view.failed} directory={item.arguments?.cwd} command={command} output={text} placeholder={view.running ? "等待输出…" : "无文本输出"}
    commandCopy={command && <CopyTextAction text={command} noun="命令" className="command-copy" iconSize={14} />}
    outputCopy={text && <CopyTextAction text={text} noun="输出" className="command-copy" iconSize={14} />}
    metadata={<>{reads > 0 && <span>{reads} 次输出读取</span>}<ToolCallDuration item={item} /></>} notices={<>
    {(item.processOutputIncomplete || output.truncated) && <p className="command-output-notice" role="status">部分输出缺失或已截断</p>}
    {item.processOutputPending && <p className="command-output-notice" role="status">输出尚未收集完整</p>}
    {process.stopReason && <p className="command-output-notice">停止原因：{process.stopReason}</p>}

    </>} raw={<details className="command-raw"><summary>原始记录</summary><pre>{JSON.stringify(item.processRecords ?? [item], null, 2)}</pre></details>} />;
}
