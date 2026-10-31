import { useI18n } from "./i18n/IntlProvider.js";
import type { ManagementResponseMap } from "@areal/workbench/desktop-contract/management";
import { useCallback, useEffect, useRef, useState } from "react";
import { Textarea } from "./components/ui/textarea.js";
import { Button } from "./components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import type { Action, Data } from "./services.js";
import { observedServiceUrls } from "./developmentService.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";

type Process = ManagementResponseMap["processes"]["data"][number];
type Runtime = ManagementResponseMap["process"]["runtime"];
const states: Record<string, string> = {
  starting: "启动中",
  running: "运行中",
  exited: "已退出",
  unknown: "状态未知",
};
const records: Record<string, string> = {
  accepted: "已受理",
  running: "已启动",
  failed: "启动失败",
  closed: "已关闭",
  unknown: "待确认",
};

/** Core managed-process records only; Runtime tool process IDs are a different scope. */
export function ProcessesPane({
  project,
  thread,
  action,
  onOpenService,
}: {
  project: Data;
  thread: Data;
  action: Action;
  onOpenService: (url: string) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<Process[]>([]),
    [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [runtime, setRuntime] = useState<Runtime | null>(null),
    [detailError, setDetailError] = useState("");
  const [output, setOutput] = useState(""),
    [partial, setPartial] = useState(false);
  const [confirm, setConfirm] = useState<Process | null>(null),
    [busy, setBusy] = useState(false),
    [stopError, setStopError] = useState("");
  const draftKey = `areal-gui:process-command:${project.id}:${thread.id}`;
  const cleanupKey = `${draftKey}:cleanup-pending`;
  const [cleanupPending, setCleanupPending] = useState(() => !!localStorage.getItem(cleanupKey));
  const [cleanupOpen, setCleanupOpen] = useState(false),
    [cleanupError, setCleanupError] = useState("");
  const [cleanupComplete, setCleanupComplete] = useState(false);
  const [command, setCommand] = useState(() => localStorage.getItem(draftKey) ?? "");
  const [lifetime, setLifetime] = useState(
    () => localStorage.getItem(`${draftKey}:lifetime`) ?? "thread",
  );
  const [creating, setCreating] = useState(false),
    [createOpen, setCreateOpen] = useState(false);
  const [unknown, setUnknown] = useState(() => !!localStorage.getItem(`${draftKey}:pending`));
  const [createError, setCreateError] = useState("");
  const [input, setInput] = useState(""),
    [controlError, setControlError] = useState("");
  const [waiting, setWaiting] = useState(false),
    [waitNotice, setWaitNotice] = useState("");
  const sequence = useRef(0),
    locked = useRef(false),
    detailSequence = useRef(0);
  useEffect(
    () => () => {
      detailSequence.current++;
    },
    [],
  );
  const processUnavailable = project.core?.features?.processes === false;
  const connected = !!project.state?.connected && !processUnavailable;

  const read = useCallback(async () => {
    const ticket = ++sequence.current;
    try {
      const result = await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "processes",
      });
      if (sequence.current !== ticket) return;
      setItems(result.data);
      setError("");
      setSelected((id) =>
        result.data.some((p: Process) => p.id === id) ? id : (result.data[0]?.id ?? ""),
      );
    } catch (cause) {
      if (sequence.current === ticket)
        setError(`列表刷新失败，显示的是上次结果。${(cause as Error).message}`);
    } finally {
      if (sequence.current === ticket) setLoading(false);
    }
  }, [action, project.id, thread.id]);
  useEffect(() => {
    if (!connected) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await read();
      if (live) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      live = false;
      sequence.current++;
      clearTimeout(timer);
    };
  }, [read, connected]);
  useEffect(() => {
    detailSequence.current++;
    setWaiting(false);
    setWaitNotice("");
    setInput("");
    setControlError("");
    setRuntime(null);
    setOutput("");
    setPartial(false);
    setDetailError("");
    if (!selected || !connected) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>,
      cursor: string | undefined,
      closed = false,
      retainedChars = 0;
    const decoders = new Map<string, TextDecoder>();
    const poll = async () => {
      try {
        const result = await action("manage", {
          projectId: project.id,
          threadId: thread.id,
          operation: "process",
          id: selected,
        });
        if (!live) return;
        setRuntime(result.runtime);
        setDetailError("");
        if (!closed) {
          const page = await action("manage", {
            projectId: project.id,
            threadId: thread.id,
            operation: "processOutput",
            id: selected,
            after: cursor,
            maxBytes: 65536,
            waitMs: 0,
          });
          if (!live) return;
          let text = "";
          for (const chunk of page.chunks) {
            if (!decoders.has(chunk.stream)) decoders.set(chunk.stream, new TextDecoder());
            text += decoders.get(chunk.stream)!.decode(
              Uint8Array.from(atob(chunk.dataBase64), (c) => c.charCodeAt(0)),
              { stream: true },
            );
          }
          closed = page.closed;
          cursor = page.nextCursor;
          if (closed) for (const decoder of decoders.values()) text += decoder.decode();
          retainedChars += text.length;
          if (page.gap || page.truncated || retainedChars > 262144) setPartial(true);
          setOutput((previous) => {
            const combined = previous + text;
            return combined.length > 262144
              ? "[仅保留最近输出]\n" + combined.slice(-262144)
              : combined;
          });
        }
      } catch (cause) {
        if (live) {
          setRuntime(null);
          setDetailError(`状态或输出暂不可用。${(cause as Error).message}`);
        }
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [selected, connected, action, project.id, thread.id]);
  const current = items.find((p) => p.id === selected);
  const disabled =
    busy || cleanupPending || loading || !connected || !!error || !!project.pending?.length;
  const create = async (recover = false) => {
    if (locked.current || !connected || (!recover && (disabled || unknown || !command.trim())))
      return;
    locked.current = true;
    setCreating(true);
    setCreateError("");
    let requestId = localStorage.getItem(`${draftKey}:pending`);
    try {
      let id: string;
      if (recover) {
        if (!requestId) throw new Error("原创建标识不可用，请从进程列表核对。");
        const receipt = await action("manage", {
          projectId: project.id,
          threadId: thread.id,
          operation: "processSubmission",
          requestId,
        });
        if (!receipt.confirmed) throw new Error("尚未找到原创建结果；不会再次创建，请稍后核对。");
        id = receipt.result.id;
      } else {
        if (requestId) {
          setUnknown(true);
          return;
        }
        requestId = crypto.randomUUID();
        localStorage.setItem(`${draftKey}:pending`, requestId);
        setUnknown(true);
        const result = await action("manage", {
          projectId: project.id,
          threadId: thread.id,
          operation: "processStart",
          requestId,
          argv: ["/bin/sh", "-c", command],
          cwd: "workspace://repo",
          lifetime,
          tty: false,
        });
        id = result.id;
      }
      localStorage.removeItem(`${draftKey}:pending`);
      localStorage.removeItem(draftKey);
      setUnknown(false);
      setCommand("");
      setCreateOpen(false);
      await read();
      setSelected(id);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (!recover && !failure.submissionUnknown) {
        localStorage.removeItem(`${draftKey}:pending`);
        setUnknown(false);
      }
      setCreateError(failure.message);
    } finally {
      locked.current = false;
      setCreating(false);
    }
  };
  const control = async (operation: "processWrite" | "processCloseStdin") => {
    if (!current || disabled || locked.current) return;
    const generation = detailSequence.current;
    locked.current = true;
    setBusy(true);
    setControlError("");
    try {
      const dataBase64 = btoa(
        Array.from(new TextEncoder().encode(input), (byte) => String.fromCharCode(byte)).join(""),
      );
      await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        id: current.id,
        ...(operation === "processWrite" ? { operation, dataBase64 } : { operation }),
      });
      if (generation === detailSequence.current && operation === "processWrite") setInput("");
      await read();
    } catch (cause) {
      if (generation === detailSequence.current) setControlError((cause as Error).message);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const waitForExit = async () => {
    if (!current || waiting || !connected) return;
    const generation = detailSequence.current;
    setWaiting(true);
    setWaitNotice("");
    try {
      const result = await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "processWait",
        id: current.id,
        timeoutMs: 10000,
      });
      if (generation !== detailSequence.current) return;
      if (result.timedOut) setWaitNotice("等待已结束，进程尚未退出；可以再次等待。");
      else {
        setRuntime(result.runtime);
        setWaitNotice("进程已退出；资源清理状态单独核对。");
      }
    } catch (cause) {
      if (generation === detailSequence.current) setWaitNotice((cause as Error).message);
    } finally {
      if (generation === detailSequence.current) setWaiting(false);
    }
  };
  const stdinClosed = current?.inputs?.some(
    (op) => op.action === "closeStdin" && op.outcome === "succeeded",
  );
  const controlsDisabled =
    disabled || !runtime || runtime.state !== "running" || current?.cleanupConfirmed;
  const serviceUrls = observedServiceUrls(output, !controlsDisabled && !detailError, partial);
  const stop = async () => {
    if (!confirm || disabled || locked.current) return;
    const target = confirm;
    locked.current = true;
    setBusy(true);
    setStopError("");
    try {
      await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "processTerminate",
        id: target.id,
      });
      const result = await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "processes",
      });
      if (!result.data.some((p: Process) => p.id === target.id && p.cleanupConfirmed))
        throw new Error("停止请求已返回，但资源清理尚未确认，请刷新后核对。");
      sequence.current++; // An earlier background read must not replace confirmed cleanup.
      setItems(result.data);
      setConfirm(null);
    } catch (cause) {
      setStopError((cause as Error).message);
      await read();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  const closeResources = async (inspect = false) => {
    if (locked.current || !connected || (!inspect && disabled)) return;
    locked.current = true;
    setBusy(true);
    setCleanupError("");
    setCleanupComplete(false);
    let dispatched = false,
      acknowledged = false;
    try {
      if (!inspect) {
        // Persist only UI uncertainty and original record identities. Core is
        // still the cleanup authority; mounting/polling never replays this action.
        localStorage.setItem(
          cleanupKey,
          JSON.stringify(items.filter((p) => !p.cleanupConfirmed).map((p) => p.id)),
        );
        setCleanupPending(true);
        dispatched = true;
        const result = await action("manage", {
          projectId: project.id,
          threadId: thread.id,
          operation: "closeResources",
        });
        acknowledged = true;
        if (result.cleanupConfirmed !== true)
          throw Object.assign(new Error("Core 尚未确认会话资源清理。"), {
            submissionUnknown: true,
          });
      }
      const original: string[] = JSON.parse(localStorage.getItem(cleanupKey) ?? "[]");
      const result = await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "processes",
      });
      sequence.current++;
      setItems(result.data);
      setError("");
      if (
        original.some(
          (id) => !result.data.some((p: Process) => p.id === id && p.cleanupConfirmed),
        ) ||
        result.data.some((p: Process) => !p.cleanupConfirmed)
      ) {
        throw Object.assign(new Error("仍有资源未确认清理，请保留阻塞并在后台服务中核查旧资源。"), {
          submissionUnknown: true,
        });
      }
      localStorage.removeItem(cleanupKey);
      setCleanupPending(false);
      setCleanupOpen(false);
      setCleanupComplete(true);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean; code?: number };
      // A known Core refusal can follow partial cleanup. Refresh records, but
      // never turn refusal or a missing response into a successful completion.
      if (
        dispatched &&
        !acknowledged &&
        !failure.submissionUnknown &&
        typeof failure.code === "number" &&
        failure.code !== -32603
      ) {
        localStorage.removeItem(cleanupKey);
        setCleanupPending(false);
      }
      setCleanupError(`资源处理未完成。${failure.message}`);
      await read();
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  if (processUnavailable)
    return (
      <section aria-label="进程" className="p-3 text-ui-base">
        <p role="status">
          {project.core.runtimeAvailable === false
            ? "当前 Core 未连接 Runtime，受管进程与终端不可用。"
            : "当前 Core 未提供完整的受管进程能力，请使用支持此功能的 Core。"}
        </p>
        {!project.state?.connected && <p>连接已断开，上次能力信息可能已过期。请重新连接后核对。</p>}
      </section>
    );
  return (
    <section aria-label="进程" className="flex h-full min-h-0 flex-col text-ui-base">
      <div className="panel-toolbar flex shrink-0 items-center justify-between">
        <span>受管进程 · {items.length}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={!connected || creating || busy || cleanupPending}
          onClick={() => setCreateOpen(true)}
        >
          新建受管命令
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || creating || !items.some((p) => !p.cleanupConfirmed)}
          onClick={() => {
            setCleanupError("");
            setCleanupOpen(true);
          }}
        >
          关闭会话资源
        </Button>
        <Button size="sm" variant="ghost" disabled={!connected || busy} onClick={() => void read()}>
          刷新进程
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <p className="text-foreground-subtle">
          此任务的受管进程，包括交互终端。助手工具执行记录仍在对话中查看。
        </p>
        {!connected && <p role="status">连接不可用，当前列表可能已过期。</p>}
        {cleanupPending && (
          <div role="status">
            <p>会话资源清理结果待核对，不会自动重发。</p>
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || busy}
              onClick={() => void closeResources(true)}
            >
              核对资源清理
            </Button>
          </div>
        )}
        {cleanupComplete && !items.some((p) => !p.cleanupConfirmed) && (
          <p role="status">会话资源已确认清理。</p>
        )}
        {cleanupError && !cleanupOpen && <p role="alert">{cleanupError}</p>}
        {unknown && (
          <p role="status">
            命令创建结果待核对，不会重复发起。
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || creating}
              onClick={() => void create(true)}
            >
              核对命令创建
            </Button>
          </p>
        )}
        {createError && !createOpen && <p role="alert">{createError}</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {loading ? (
          <p role="status">读取进程中…</p>
        ) : (
          !items.length && !error && <p>此任务暂无受管进程</p>
        )}
        <div className="flex flex-col gap-1" aria-label="受管进程列表">
          {items.map((p) => (
            <Button
              unstyled
              data-slot={undefined}
              key={p.id}
              data-testid={`process-${p.id}`}
              type="button"
              aria-pressed={selected === p.id}
              className={`rounded-control border border-border p-2 text-left ${selected === p.id ? "bg-selected" : "hover:bg-hover"}`}
              onClick={() => setSelected(p.id)}
            >
              <span className="block break-all font-mono">{p.argv.join(" ")}</span>
              <span className="text-foreground-subtle">
                {p.cleanupConfirmed ? "已清理" : (records[p.state] ?? p.state)} ·{" "}
                {p.lifetime === "turn" ? "随本轮执行" : "随会话保留"}
              </span>
            </Button>
          ))}
        </div>
        {current && (
          <div className="flex min-h-0 flex-col gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span role="status">
                {runtime
                  ? `${states[runtime.state] ?? runtime.state}${runtime.exitCode !== null ? ` · 退出码 ${runtime.exitCode}` : ""}${runtime.signal ? ` · 信号 ${runtime.signal}` : ""}`
                  : "实际运行状态暂不可用"}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || current.cleanupConfirmed}
                onClick={() => {
                  setStopError("");
                  setConfirm(current);
                }}
              >
                停止并清理
              </Button>
            </div>
            <p>{current.cleanupConfirmed ? "资源已清理" : "资源尚未确认清理"}</p>
            {(current.error || runtime?.cleanupError) && (
              <p role="alert" className="text-destructive">
                {current.error || runtime?.cleanupError}
              </p>
            )}
            {detailError && (
              <p role="alert" className="text-destructive">
                {detailError}
              </p>
            )}
            <SettingsDisclosure title="进程信息">
              <dl className="break-all">
                <dt>进程 ID</dt>
                <dd>{current.id}</dd>
                <dt>创建者</dt>
                <dd>{current.owner}</dd>
                {current.turnId && (
                  <>
                    <dt>轮次</dt>
                    <dd>{current.turnId}</dd>
                  </>
                )}
              </dl>
            </SettingsDisclosure>
            <div className="flex flex-col gap-2">
              <Textarea
                aria-label="标准输入"
                value={input}
                disabled={controlsDisabled || stdinClosed}
                onChange={(event) => setInput(event.target.value)}
                placeholder="原样发送文本，换行请在此输入"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={controlsDisabled || stdinClosed || !input}
                  onClick={() => void control("processWrite")}
                >
                  发送输入
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={controlsDisabled || stdinClosed}
                  onClick={() => void control("processCloseStdin")}
                >
                  关闭标准输入
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!runtime || waiting || !connected || current.cleanupConfirmed}
                  onClick={() => void waitForExit()}
                >
                  {waiting ? "等待退出中…" : "等待退出"}
                </Button>
              </div>
              {stdinClosed && <p role="status">标准输入已关闭</p>}
              {controlError && <p role="alert">{controlError}</p>}
              {waitNotice && <p role="status">{waitNotice}</p>}
            </div>
            {partial && <p role="status">部分输出已过期或被截断。</p>}
            {serviceUrls.length > 0 && (
              <div
                role="group"
                aria-label="从受管进程输出发现的服务地址"
                className="flex flex-col gap-1"
              >
                <p className="text-foreground-subtle">{t("common.processes.urlsHelp")}</p>
                {serviceUrls.map((url) => (
                  <Button
                    key={url}
                    size="sm"
                    variant="outline"
                    className="w-fit max-w-full truncate"
                    title={url}
                    onClick={() => onOpenService(url)}
                  >
                    打开 {url}
                  </Button>
                ))}
              </div>
            )}
            <pre
              role="log"
              aria-label="进程输出"
              aria-live="off"
              className="max-h-96 min-h-24 overflow-auto whitespace-pre-wrap break-words rounded-control bg-background-secondary p-2 font-mono text-compact-caption"
            >
              {output || "暂无输出"}
            </pre>
          </div>
        )}
      </div>
      <Dialog
        open={cleanupOpen}
        onOpenChange={(open) => {
          if (!busy) setCleanupOpen(open);
        }}
      >
        <DialogContent className="max-w-md" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>关闭会话资源？</DialogTitle>
            <DialogDescription>{t("common.processes.closeSessionConfirm")}</DialogDescription>
          </DialogHeader>
          {cleanupError && (
            <p role="alert" className="text-destructive">
              {cleanupError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCleanupOpen(false)}>
              取消
            </Button>
            {cleanupPending ? (
              <Button disabled={!connected || busy} onClick={() => void closeResources(true)}>
                核对资源清理
              </Button>
            ) : (
              <Button
                variant="destructive"
                disabled={disabled}
                onClick={() => void closeResources()}
              >
                确认关闭资源
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!creating) setCreateOpen(open);
        }}
      >
        <DialogContent className="max-w-lg" showCloseButton={!creating}>
          <DialogHeader>
            <DialogTitle>新建受管命令</DialogTitle>
            <DialogDescription>{t("common.processes.scriptHelp")}</DialogDescription>
          </DialogHeader>
          <Textarea
            aria-label="命令脚本"
            value={command}
            disabled={creating || unknown}
            onChange={(event) => {
              setCommand(event.target.value);
              localStorage.setItem(draftKey, event.target.value);
            }}
            placeholder="输入命令脚本"
          />
          <label>
            保留范围
            <select
              aria-label="保留范围"
              value={lifetime}
              disabled={creating || unknown}
              onChange={(event) => {
                setLifetime(event.target.value);
                localStorage.setItem(`${draftKey}:lifetime`, event.target.value);
              }}
              className="ml-2 rounded-control border border-border bg-background p-2"
            >
              <option value="turn">随本轮执行</option>
              <option value="thread">随会话保留</option>
            </select>
          </label>
          <p className="text-foreground-subtle">{t("common.processes.lifetimeHelp")}</p>
          {unknown && <p role="status">创建结果待核对；不能再次创建。</p>}
          {createError && <p role="alert">{createError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={creating} onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            {unknown ? (
              <Button disabled={creating || !connected} onClick={() => void create(true)}>
                核对命令创建
              </Button>
            ) : (
              <Button
                disabled={disabled || creating || !command.trim()}
                onClick={() => void create()}
              >
                创建命令
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null);
        }}
      >
        <DialogContent className="max-w-md" showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>停止此进程？</DialogTitle>
            <DialogDescription>{t("common.processes.stopConfirm")}</DialogDescription>
          </DialogHeader>
          <p className="break-all font-mono text-compact-body">{confirm?.argv.join(" ")}</p>
          {stopError && (
            <p role="alert" className="text-destructive">
              {stopError}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={disabled} onClick={() => void stop()}>
              {busy ? "停止中…" : "确认停止"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
