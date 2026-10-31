import { Input } from "@areal/ui";
import { useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";
import type { Action, Data } from "./services.js";
import { hasUnknownToolOutcome, uninspectedToolCalls } from "./toolInspection.js";
import { FeedbackNotice } from "./FeedbackNotice.js";
import { useI18n } from "./i18n/IntlProvider.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";

/** Core owns both the UNKNOWN journal and the operator's inspection. Acknowledging
 * records facts only: it never retries the operation or changes its outcome. */
export function UnknownToolInspection({
  item,
  project,
  thread,
  action,
  open: controlledOpen,
  onOpenChange,
  compact = false,
}: {
  item: Data;
  project: Data;
  thread: Data;
  action: Action;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [localOpen, setLocalOpen] = useState(false),
    [inspection, setInspection] = useState("");
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => {
    setLocalOpen(value);
    onOpenChange?.(value);
  };
  const [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const locked = useRef(false);
  const connected = !!project.state?.connected;
  const confirmed = item.execution?.inspection;
  const unknown = hasUnknownToolOutcome(item);
  const browser = item.tool === "browser_v1";
  const active = thread.turns?.some((turn: Data) => turn.status === "inProgress");
  const bytes = new TextEncoder().encode(inspection.trim()).length;
  const archived =
    thread.desktop?.archived && thread.conversation?.policy?.kind !== "sideExecutableV2";
  const disabled = busy || !connected || active || archived || !!confirmed;
  useEffect(() => {
    if (!connected) setChecked(false);
  }, [connected]);
  if (!unknown) return null;
  const params = { projectId: project.id, threadId: thread.id };
  const confirm = async () => {
    if (disabled || !checked || bytes < 1 || bytes > 1024 || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await action("manage", {
        ...params,
        operation: "toolAcknowledge",
        itemId: item.id,
        inspection: inspection.trim(),
      });
      setOpen(false);
    } catch (cause) {
      setError(`核查未确认，请刷新原记录后核对；不会自动重试。${(cause as Error).message}`);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const refresh = async () => {
    if (locked.current || !connected) return;
    locked.current = true;
    setBusy(true);
    try {
      await action("open", params);
      setError("");
    } catch (cause) {
      setError(`刷新失败，仍显示上次记录。${(cause as Error).message}`);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  return (
    <div className={compact ? undefined : "notice"}>
      {!compact && (
        <p>
          {confirmed
            ? browser
              ? t("operations.browserInspected")
              : "UNKNOWN · 已记录人工核查，原结果仍未知。"
            : browser
              ? t("operations.browserUnconfirmed")
              : "UNKNOWN · 工具或钩子结果未确认，核查前会话保持阻塞。"}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          setOpen(value);
          if (value) setChecked(false);
        }}
      >
        {!compact && (
          <DialogTrigger render={<Button variant="outline" size="sm" />}>
            {browser
              ? t("operations.browserInspect")
              : confirmed
                ? "查看 UNKNOWN 核查"
                : "核查 UNKNOWN"}
          </DialogTrigger>
        )}
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogTitle>
            {browser ? t("operations.browserInspect") : "核查工具结果 UNKNOWN"}
          </DialogTitle>
          <DialogDescription>
            {browser ? t("operations.browserInspectionHelp") : t("common.inspection.help")}
          </DialogDescription>
          <SettingsDisclosure
            open={browser ? undefined : true}
            title={t("operations.inspectionDetails")}
          >
            <dl className="grid gap-1 text-compact-body break-all">
              <dt>原工具</dt>
              <dd>{item.tool}</dd>
              <dt>执行项</dt>
              <dd>{item.id}</dd>
              <dt>操作</dt>
              <dd>{item.execution.operationId}</dd>
              <dt>历史状态</dt>
              <dd>
                {item.execution.outcome}
                {item.execution.hooks?.some((hook: Data) => hook.outcome === "unknown")
                  ? " · 钩子 UNKNOWN"
                  : ""}
                {item.execution.plugin?.operations?.some(
                  (operation: Data) => operation.outcome === "unknown",
                )
                  ? " · 插件 UNKNOWN"
                  : ""}
              </dd>
            </dl>
            <div>
              <h3>原操作参数</h3>
              <pre
                className="whitespace-pre-wrap break-all text-compact-caption"
                aria-label="原操作参数"
              >
                {JSON.stringify(item.arguments, null, 2)}
              </pre>
            </div>
            <SettingsDisclosure title="Core 原始结果与核查事实">
              <pre
                className="whitespace-pre-wrap break-all text-compact-caption"
                aria-label="Core 原始结果"
              >
                {JSON.stringify({ output: item.contentItems, execution: item.execution }, null, 2)}
              </pre>
            </SettingsDisclosure>
          </SettingsDisclosure>
          {confirmed ? (
            <div role="status">
              <h3>已保存的核查说明</h3>
              <p className="whitespace-pre-wrap break-words">{confirmed}</p>
            </div>
          ) : (
            <>
              <label>
                核查说明
                <Textarea
                  aria-label="核查说明"
                  value={inspection}
                  onChange={(event) => setInspection(event.target.value)}
                  disabled={busy}
                  placeholder={
                    browser
                      ? t("operations.browserInspectionPlaceholder")
                      : "记录已检查的文件、进程及观察到的事实；不确定时不要确认。"
                  }
                />
              </label>
              <p className="text-compact-caption">{bytes} / 1024 UTF-8 字节</p>
              <label className="flex items-center gap-2">
                <Input
                  unstyled
                  data-slot={undefined}
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => setChecked(event.target.checked)}
                  disabled={disabled}
                />
                {browser ? t("operations.browserInspectionChecked") : "已核查实际文件或进程"}
              </label>
              {!connected && <p role="status">连接中断，不能确认。恢复连接后刷新原记录。</p>}
              {active && <p role="status">会话仍在执行，结算后才能确认。</p>}
            </>
          )}
          {error && <p role="alert">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              取消核查
            </Button>
            <Button variant="outline" disabled={busy || !connected} onClick={() => void refresh()}>
              刷新原记录
            </Button>
            {!confirmed && (
              <Button
                disabled={disabled || !checked || bytes < 1 || bytes > 1024}
                onClick={() => void confirm()}
              >
                确认已核查
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 核对不发送草稿；只有 Core 保存核对事实后才移除当前入口。 */
export function useToolInspection(
  project: Data,
  thread: Data,
  action: Action,
  onClose: () => void,
) {
  const { t } = useI18n();
  const [inspectionId, setInspectionId] = useState<string | null>(null);
  const pending = uninspectedToolCalls(thread);
  const selected = pending.find((item) => item.id === inspectionId);
  const running = thread.turns?.some((turn: Data) => turn.status === "inProgress");
  const request = () => {
    if (!pending.length) return false;
    setInspectionId(pending[0].id);
    return true;
  };
  const submitLabel = (editingQueue: boolean, creatingGoal: boolean, canContinue: boolean) =>
    editingQueue
      ? "保存排队消息"
      : !running && pending.length
        ? t("operations.inspectBeforeSend")
        : creatingGoal
          ? "开始目标"
          : canContinue
            ? "继续执行"
            : "发送";
  return {
    submitLabel,
    request,
    notice: (
      <>
        {!running && pending.length > 0 && (
          <FeedbackNotice
            transient={false}
            tone="warning"
            message={t(
              pending[0].tool === "browser_v1"
                ? "operations.browserRecovery"
                : "operations.toolRecovery",
            )}
            actions={
              <Button
                variant="outline"
                size="sm"
                disabled={!project.state?.connected}
                onClick={request}
              >
                {t("operations.inspectToContinue")}
              </Button>
            }
          />
        )}
        {selected && (
          <UnknownToolInspection
            key={selected.id}
            compact
            open
            item={selected}
            project={project}
            thread={thread}
            action={action}
            onOpenChange={(open) => {
              if (!open) {
                setInspectionId(null);
                onClose();
              }
            }}
          />
        )}
      </>
    ),
  };
}
