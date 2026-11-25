import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TitleTooltip,
} from "@areal/ui";
import { currentErrorText } from "../errors/currentErrorText.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Plus, X } from "lucide-react";
import type { Action, Data } from "../services.js";
import { TerminalSession } from "./TerminalSession.js";
import { sidePaneTerminalSessionRegistry } from "./sidePaneTerminalSessionRegistry.js";
import {
  addTerminal,
  closeTerminal,
  ensureTerminal,
  recordTerminalFailure,
  selectTerminal,
  terminalFailure,
  terminalLifecycle,
  terminalLifetime,
  terminalOwner,
  terminalServices,
  terminalTitle,
  useTerminalWorkspace,
} from "./terminalWorkspace.js";
const noop = () => {};

export function TerminalPane({
  project,
  thread,
  action,
  onError,
  onLink,
  terminalId,
  onClosed,
  canStart,
}: {
  project: Data;
  thread: Data;
  action: Action;
  onError: (s: string) => void;
  onLink: (url: string) => void;
  terminalId?: string;
  onClosed?: (id: string) => void;
  canStart: boolean;
}) {
  const { t } = useI18n();
  const owner = terminalOwner(project.id, thread.id),
    state = useTerminalWorkspace(owner);
  const id = terminalId ?? state.active;
  const [nextLifetime, setNextLifetime] = useState<"turn" | "thread">("thread");
  useEffect(() => {
    if (!terminalId) ensureTerminal(owner);
    else selectTerminal(owner, terminalId);
  }, [owner, terminalId]);
  const services = useMemo(
    () => terminalServices(action, project.id, thread.id, onError),
    [owner, action, onError],
  );
  const lifecycleOwner = `${owner}:${id}`;
  const { generation, restarting } = useSyncExternalStore(terminalLifecycle.subscribe, () =>
    terminalLifecycle.snapshot(lifecycleOwner),
  );
  const key = `${lifecycleOwner}:${generation}`,
    closing = state.closing.includes(id);
  const failure = terminalFailure(owner, id) ?? services.terminalService.creationFailure(key);
  const [processStatus, setProcessStatus] = useState<{
    key: string;
    runtime?: import("../services.js").ManagementResponseMap["process"]["runtime"];
    cleanupConfirmed?: boolean;
    partialOutput?: boolean;
    error?: string;
  } | null>(null);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    setProcessStatus(null);
    const read = async () => {
      const processId = sidePaneTerminalSessionRegistry.get(key)?.terminalId;
      if (processId && project.state?.connected) {
        try {
          const value = await action("manage", {
            projectId: project.id,
            threadId: thread.id,
            operation: "process",
            id: processId,
          });
          if (live)
            setProcessStatus({
              key,
              runtime: value.runtime,
              cleanupConfirmed: value.process.cleanupConfirmed,
              partialOutput: services.terminalService.hasPartialOutput(processId),
            });
        } catch (cause) {
          // Old Runtime handles cannot supply execution state, but Core's
          // historical record still owns the independently confirmed cleanup.
          const records = await action("manage", {
            projectId: project.id,
            threadId: thread.id,
            operation: "processes",
          }).catch(() => null);
          const process = records?.data?.find((item: Data) => item.id === processId);
          if (live)
            setProcessStatus({
              key,
              cleanupConfirmed: process?.cleanupConfirmed,
              partialOutput: services.terminalService.hasPartialOutput(processId),
              error: (cause as Error).message,
            });
        }
      }
      if (live) timer = setTimeout(read, 1000);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [key, project.id, thread.id, project.state?.connected, action, services]);
  const status = processStatus?.key === key ? processStatus : null;
  const [recovery, setRecovery] = useState({ key: "", busy: false, message: "" });
  const recovering = recovery.key === key && recovery.busy;
  const recoveryMessage = recovery.key === key ? recovery.message : "";
  const recover = async () => {
    if (recovering) return;
    setRecovery({ key, busy: true, message: "" });
    let message = "";
    try {
      if (await services.terminalService.recover(key)) recordTerminalFailure(owner, id);
      else message = "尚未找到创建收据，请稍后再次核对；不会重建终端。";
    } catch (error) {
      message = (error as Error).message;
    } finally {
      setRecovery((current) => (current.key === key ? { key, busy: false, message } : current));
    }
  };
  const ready =
    canStart ||
    sidePaneTerminalSessionRegistry.has(key) ||
    services.terminalService.hasAttempt(key);
  const restart = () => {
    if (!id || closing || failure?.unknown || !canStart) return;
    void terminalLifecycle
      .restart(lifecycleOwner, async (current) => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const entry = sidePaneTerminalSessionRegistry.get(`${lifecycleOwner}:${current}`);
        if (!entry?.terminalId && !failure) throw new Error("终端仍在创建，请稍后重开。");
        if (entry?.terminalId) await services.terminalService.dispose({ id: entry.terminalId });
        if (entry) sidePaneTerminalSessionRegistry.release(entry.key);
        recordTerminalFailure(owner, id);
      })
      .then(() => {
        if (terminalLifecycle.snapshot(lifecycleOwner).generation !== generation)
          services.terminalService.forget(key);
      })
      .catch((error) => onError(currentErrorText(error)));
  };
  const close = async () => {
    try {
      await closeTerminal(owner, id);
      onClosed?.(id);
    } catch (error) {
      onError((error as Error).message);
    }
  };
  return (
    <section
      className="terminal-pane flex h-full min-h-0 flex-col overflow-hidden bg-background"
      style={{ padding: 0 }}
    >
      {!terminalId && (
        <div className="panel-toolbar flex shrink-0 items-center gap-1">
          <div
            role="tablist"
            aria-label="终端实例"
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
          >
            {state.ids.map((value) => (
              <Button
                variant={value === id ? "secondary" : "ghost"}
                size="sm"
                type="button"
                key={value}
                role="tab"
                aria-selected={value === id}
                className="shrink-0"
                onClick={() => selectTerminal(owner, value)}
              >
                {terminalTitle(owner, value, project.root)}
              </Button>
            ))}
          </div>
          <Select
            value={nextLifetime}
            onValueChange={(value) => setNextLifetime(value === "turn" ? "turn" : "thread")}
          >
            <TitleTooltip title={"Turn 终端需要正在执行的任务，范围由 Core 校验"}>
              <SelectTrigger size="sm" aria-label="新终端保留范围">
                <SelectValue>
                  {nextLifetime === "turn"
                    ? t("common.terminal.lifetimeTurn")
                    : t("common.terminal.lifetimeThread")}
                </SelectValue>
              </SelectTrigger>
            </TitleTooltip>
            <SelectContent>
              <SelectItem value="thread">{t("common.terminal.lifetimeThread")}</SelectItem>
              <SelectItem value="turn">{t("common.terminal.lifetimeTurn")}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="新建终端"
            onClick={() => addTerminal(owner, nextLifetime)}
          >
            <Plus size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label="关闭当前终端"
            disabled={!id || closing || restarting}
            onClick={() => void close()}
          >
            <X size={15} />
          </Button>
        </div>
      )}
      {status && (status.runtime?.state !== "running" || status.partialOutput || status.error) && (
        <div
          className="flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-b border-border px-3 py-1 text-ui-sm"
          aria-label="终端运行状态"
        >
          <span role="status">
            {status.runtime
              ? `${status.runtime.state === "exited" ? "终端已退出" : status.runtime.state === "running" ? "终端运行中" : "终端状态未知"}${status.runtime.exitCode !== null ? ` · 退出码 ${status.runtime.exitCode}` : ""}${status.runtime.signal ? ` · 信号 ${status.runtime.signal}` : ""}`
              : "终端运行状态暂不可用"}
          </span>
          {status.runtime?.state !== "running" && (
            <span>{status.cleanupConfirmed ? "终端资源已清理" : "终端资源尚未确认清理"}</span>
          )}
          {status.partialOutput && <span role="status">终端输出存在缺口或截断</span>}
          {status.error && <span role="alert">{status.error}</span>}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        {id && state.ids.includes(id) && !restarting && ready && !failure && (
          <TerminalSession
            key={key}
            sessionId={key}
            services={services}
            cwd={project.root}
            lifetime={terminalLifetime(owner, id)}
            isVisible
            onShellLabelChange={noop}
            onOpenBrowserUrl={onLink}
            persistentKey={key}
            workspaceKey={owner}
            onRestart={restart}
            onCreateError={(error) => recordTerminalFailure(owner, id, error)}
          />
        )}
        {failure && (
          <div className="grid gap-2">
            <p role="alert">{failure.message /* raw-error-ok: 已是呈现后的文案 */}</p>
            {failure.unknown ? (
              <>
                <p>创建结果尚未确认；核对原请求后连接已有终端，不会自动重建。</p>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  className="justify-self-start"
                  disabled={recovering}
                  onClick={() => void recover()}
                >
                  {recovering ? "正在核对…" : "核对终端创建"}
                </Button>
                {recoveryMessage && <p role="status">{recoveryMessage}</p>}
              </>
            ) : (
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="justify-self-start"
                disabled={!canStart || restarting}
                onClick={restart}
              >
                重试创建终端
              </Button>
            )}
          </div>
        )}
        {!ready && !failure && <p role="status">等待当前提交完成后启动终端…</p>}
        {(restarting || closing) && (
          <p role="status">{restarting ? "正在重开终端…" : "正在关闭终端…"}</p>
        )}
      </div>
    </section>
  );
}
