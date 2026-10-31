import type { ManagementResponseMap } from "@areal/workbench/desktop-contract/management";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components/ui/button.js";
import { AgentsPane } from "./AgentsPane.js";
import { WorkgroupsPane } from "./WorkgroupsPane.js";
import type { Action, Data } from "./services.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";

type Execution = {
  executionId: string;
  parentThreadId: string;
  title?: string;
  objective?: string;
  status: string;
  settled: boolean;
  resourcesReleased: boolean;
  text: string;
  error: string | null;
  verification: { status: string; kind: string };
  delivery: { status: string };
  threadId?: string;
  turnId?: string;
  timedOut?: boolean;
  capabilities?: { readArtifact?: boolean };
  artifact?: { head?: string; workgroupId: string; available?: boolean };
};
type ArtifactPreview = {
  path: string;
  head: string;
  sha256: string | null;
  bytes: number;
  nextOffset: number;
  complete: boolean;
  exists: boolean;
  data: number[];
  text: string | null;
};
type ArtifactList = {
  ready?: true;
  path?: never;
  head: string;
  paths: string[];
  nextOffset: number;
  complete: boolean;
};
type ArtifactFile = Omit<ArtifactPreview, "data" | "text"> & {
  ready?: true;
  offset: number;
  dataBase64: string;
};
type ArtifactRead =
  | {
      ready: false;
      execution: Omit<Execution, "parentThreadId"> & { parentThreadId?: string };
    }
  | ArtifactList
  | ArtifactFile;
const statusLabels: Record<string, string> = {
  inProgress: "执行中",
  running: "执行中",
  awaitingDelivery: "正在交付",
  queued: "等待执行",
  completed: "执行已结束",
  interrupted: "已中断",
  cancelled: "已取消",
  failed: "执行失败",
  unknown: "执行结果待确认",
};
const verificationLabels: Record<string, string> = {
  notRun: "未运行检查",
  passed: "检查通过",
  failed: "检查失败",
};
const verificationKinds: Record<string, string> = {
  none: "",
  project: "项目检查",
  trusted: "可信验收",
};
const deliveryLabels: Record<string, string> = {
  notRequired: "报告交付",
  pending: "等待交付",
  candidate: "候选改动已生成",
  cancelled: "交付已取消",
  requiresActiveTurn: "请继续任务以应用",
  preparing: "正在准备交付",
  applying: "正在应用改动",
  failed: "交付失败",
  applied: "改动已应用",
  conflict: "交付存在冲突",
  partial: "改动部分应用",
  unknown: "交付结果待确认",
};

const canReadArtifact = (execution: Execution) =>
  execution.artifact?.available !== false && execution.capabilities?.readArtifact !== false;

// 状态仅来自 Core；客户端不根据 Worker 返回或测试输出推断交付成功。
export function ExecutionsPane({
  project,
  thread,
  action,
  onOpen,
}: {
  project: Data;
  thread: Data;
  action: Action;
  onOpen: (id: string) => void;
}) {
  const [executions, setExecutions] = useState<Execution[]>([]),
    [reading, setReading] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null),
    [more, setMore] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactList>>({});
  const [previews, setPreviews] = useState<Record<string, ArtifactPreview>>({});
  const pages = useRef(1),
    generation = useRef(0),
    inflight = useRef<Promise<void> | null>(null),
    control = useRef(false),
    mounted = useRef(true);
  const connected = !!project.state?.connected;
  const supported = project.core?.features?.executions === true;

  const read = useCallback(() => {
    if (!connected || !supported) return Promise.resolve();
    if (inflight.current) return inflight.current;
    const stamp = ++generation.current;
    setReading(true);
    const pending = (async () => {
      try {
        const items: Execution[] = [];
        let offset: number | null = 0;
        for (let page = 0; page < pages.current && offset !== null; page++) {
          const value: ManagementResponseMap["executions"] = await action("manage", {
            projectId: project.id,
            parentThreadId: thread.id,
            operation: "executions",
            offset,
            limit: 50,
          });
          items.push(...value.data);
          offset = value.nextOffset;
        }
        if (mounted.current && stamp === generation.current) {
          setExecutions([...new Map(items.map((item) => [item.executionId, item])).values()]);
          setMore(offset !== null);
          setError("");
        }
      } catch (cause) {
        if (mounted.current && stamp === generation.current)
          setError(`子任务状态未刷新，当前显示可能已过期。${(cause as Error).message}`);
      } finally {
        if (mounted.current && stamp === generation.current) setReading(false);
        inflight.current = null;
      }
    })();
    inflight.current = pending;
    return pending;
  }, [connected, supported, action, project.id, thread.id]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await read();
      if (live) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      live = false;
      generation.current++;
      clearTimeout(timer);
    };
  }, [read]);
  const operate = async (
    executionId: string,
    operation: "executionWait" | "executionCancel" | "executionApply",
  ) => {
    if (control.current || !connected) return;
    control.current = true;
    setBusy(executionId);
    setNotice("");
    try {
      const result: Execution = await action("manage", {
        projectId: project.id,
        parentThreadId: thread.id,
        executionId,
        ...(operation === "executionWait"
          ? { operation, timeoutMs: 10000 }
          : operation === "executionCancel"
            ? { operation, mode: "graceful" }
            : { operation }),
      });
      if (mounted.current) {
        generation.current++;
        setExecutions((previous) =>
          previous.map((item) => (item.executionId === executionId ? result : item)),
        );
        setNotice(
          operation === "executionApply" && result.delivery.status !== "applied"
            ? ["candidate", "requiresActiveTurn"].includes(result.delivery.status)
              ? "改动尚未应用。请继续原任务，让任务承接这份交付。"
              : `改动尚未完成交付：${deliveryLabels[result.delivery.status] ?? result.delivery.status}。`
            : result.timedOut
              ? "等待时间已到，请查看子任务的当前状态。"
              : operation === "executionCancel" && !result.settled
                ? "已请求停止，正在等待结算与清理。"
                : "",
        );
      }
    } catch (cause) {
      if (mounted.current)
        setNotice(`操作结果待确认，请刷新状态；不会自动重发。${(cause as Error).message}`);
    } finally {
      control.current = false;
      if (mounted.current) {
        setBusy(null);
        setReading(false);
      }
    }
  };
  const readArtifact = async (executionId: string, path?: string, more = false) => {
    if (control.current || !connected) return;
    control.current = true;
    setBusy(executionId);
    setNotice("");
    const previousFile = previews[executionId];
    const offset = more
      ? ((path ? previousFile?.nextOffset : artifacts[executionId]?.nextOffset) ?? 0)
      : 0;
    const retainHead = (head?: string) => {
      setArtifacts((previous) => {
        if (head && previous[executionId]?.head === head) return previous;
        const { [executionId]: _removed, ...rest } = previous;
        return rest;
      });
      setPreviews((previous) => {
        if (head && previous[executionId]?.head === head) return previous;
        const { [executionId]: _removed, ...rest } = previous;
        return rest;
      });
    };
    try {
      const value: ArtifactRead = await action("manage", {
        projectId: project.id,
        parentThreadId: thread.id,
        operation: "executionArtifact",
        executionId,
        ...(path ? { path } : {}),
        offset,
      });
      if (!mounted.current) return;
      if (value.ready === false) {
        const receipt = value.execution;
        if (
          receipt.executionId !== executionId ||
          (receipt.parentThreadId !== undefined && receipt.parentThreadId !== thread.id)
        )
          throw new Error("子任务回执不匹配，请刷新状态。");
        generation.current++;
        setExecutions((previous) =>
          previous.map((item) =>
            item.executionId === executionId
              ? {
                  ...item,
                  ...receipt,
                  artifact: receipt.artifact,
                  parentThreadId: item.parentThreadId,
                }
              : item,
          ),
        );
        retainHead(receipt.artifact?.head);
        setNotice("交付文件尚未就绪，请等待子任务结算后刷新状态。");
        return;
      }
      retainHead(value.head);
      if (typeof value.path === "string") {
        if (
          value.path !== path ||
          (more &&
            (previousFile?.path !== path ||
              previousFile.head !== value.head ||
              previousFile.sha256 !== value.sha256 ||
              previousFile.bytes !== value.bytes))
        )
          throw new Error("交付版本已变化，请重新读取文件。");
        const chunk = Uint8Array.from(atob(value.dataBase64), (char) => char.charCodeAt(0));
        if (
          value.offset !== offset ||
          value.nextOffset !== offset + chunk.length ||
          value.nextOffset > value.bytes ||
          value.complete !== (value.nextOffset === value.bytes) ||
          (!value.complete && !chunk.length)
        )
          throw new Error("文件内容不完整，请重新读取。");
        const data = [...(more ? previousFile.data : []), ...chunk];
        let text: string | null;
        try {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(data), {
            stream: !value.complete,
          });
          text = Array.from(decoded).some(
            (character) =>
              character.charCodeAt(0) < 32 && ![9, 10, 13].includes(character.charCodeAt(0)),
          )
            ? null
            : decoded;
        } catch {
          text = null;
        }
        setPreviews((previous) => ({
          ...previous,
          [executionId]: { ...value, data, text },
        }));
      } else {
        if (path) throw new Error("文件回执不匹配，请重新读取文件。");
        if (more && artifacts[executionId]?.head !== value.head)
          throw new Error("交付版本已变化，请重新读取文件列表。");
        setArtifacts((previous) => ({
          ...previous,
          [executionId]: {
            ...value,
            paths: more ? [...(previous[executionId]?.paths ?? []), ...value.paths] : value.paths,
          },
        }));
      }
    } catch (cause) {
      if (mounted.current) setNotice(`交付文件读取失败。${(cause as Error).message}`);
    } finally {
      control.current = false;
      if (mounted.current) {
        setBusy(null);
        setReading(false);
      }
    }
  };
  return (
    <section aria-label="子任务" className="flex h-full min-h-0 flex-col text-ui-base">
      <div className="panel-toolbar flex shrink-0 items-center justify-between gap-2">
        <span>子任务 · {executions.length}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!connected || !supported || reading}
          onClick={() => void read()}
        >
          刷新子任务
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        <p className="text-foreground-subtle">
          子任务会按任务要求自动安排。这里展示进度、验证与交付结果。
        </p>
        {thread.parentThreadId && (
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => onOpen(thread.parentThreadId)}
          >
            返回父任务
          </Button>
        )}
        {!connected && <p role="status">连接不可用，状态可能已过期。</p>}
        {!supported && (
          <p role="status">当前 Core 未提供统一子任务接口，可在高级视图读取兼容历史。</p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {supported && !reading && !error && !executions.length && (
          <p className="text-foreground-subtle">此任务尚无子任务，执行过程会在这里自动显示。</p>
        )}
        {executions.map((execution) => (
          <article
            key={execution.executionId}
            data-testid={`execution-${execution.executionId}`}
            className="flex flex-col gap-2 rounded-control border border-border p-3"
          >
            <h3 className="break-words font-medium">
              {execution.title ||
                execution.objective ||
                `子任务 ${execution.executionId.slice(0, 8)}`}
            </h3>
            <p role="status">
              {statusLabels[execution.status] ?? execution.status}
              {!execution.resourcesReleased && execution.settled ? " · 资源仍待清理" : ""}
            </p>
            <p>
              {verificationKinds[execution.verification.kind]
                ? `${verificationKinds[execution.verification.kind]} · `
                : ""}
              {verificationLabels[execution.verification.status] ?? execution.verification.status} ·{" "}
              {deliveryLabels[execution.delivery.status] ?? execution.delivery.status}
            </p>
            {execution.error && <p className="text-destructive">{execution.error}</p>}
            {execution.text && <p className="whitespace-pre-wrap break-words">{execution.text}</p>}
            {execution.artifact &&
              (execution.artifact.available !== undefined ||
                execution.capabilities?.readArtifact !== undefined ||
                [
                  "candidate",
                  "requiresActiveTurn",
                  "applied",
                  "conflict",
                  "partial",
                  "unknown",
                  "failed",
                ].includes(execution.delivery.status)) && (
                <div className="flex flex-col gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!connected || !!busy || !canReadArtifact(execution)}
                    onClick={() => void readArtifact(execution.executionId)}
                  >
                    查看交付文件
                  </Button>
                  {artifacts[execution.executionId]?.paths.map((path) => (
                    <Button
                      key={path}
                      size="sm"
                      variant="ghost"
                      disabled={!connected || !!busy || !canReadArtifact(execution)}
                      onClick={() => void readArtifact(execution.executionId, path)}
                    >
                      {path}
                    </Button>
                  ))}
                  {artifacts[execution.executionId] &&
                    !artifacts[execution.executionId].complete && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!connected || !!busy || !canReadArtifact(execution)}
                        onClick={() => void readArtifact(execution.executionId, undefined, true)}
                      >
                        更多交付文件
                      </Button>
                    )}
                  {previews[execution.executionId] && (
                    <div>
                      <p>
                        {previews[execution.executionId].path}
                        {previews[execution.executionId].exists ? "" : " · 已删除"}
                      </p>
                      <pre className="whitespace-pre-wrap break-words">
                        {previews[execution.executionId].text ?? "该文件不支持文本预览。"}
                      </pre>
                      {!previews[execution.executionId].complete && (
                        <p className="text-foreground-subtle">文件预览尚未完整。</p>
                      )}
                      {!previews[execution.executionId].complete && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!connected || !!busy || !canReadArtifact(execution)}
                          onClick={() =>
                            void readArtifact(
                              execution.executionId,
                              previews[execution.executionId].path,
                              true,
                            )
                          }
                        >
                          继续读取文件
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              )}
            <div className="flex flex-wrap gap-2">
              {execution.delivery.status === "candidate" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!connected || !!busy}
                  onClick={() => void operate(execution.executionId, "executionApply")}
                >
                  应用全部改动
                </Button>
              )}
              {execution.threadId && (
                <Button size="sm" variant="outline" onClick={() => onOpen(execution.threadId!)}>
                  查看过程
                </Button>
              )}
              {!execution.settled && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!connected || !!busy}
                    onClick={() => void operate(execution.executionId, "executionWait")}
                  >
                    {busy === execution.executionId ? "处理中…" : "等待结果"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!connected || !!busy}
                    onClick={() => void operate(execution.executionId, "executionCancel")}
                  >
                    停止子任务
                  </Button>
                </>
              )}
            </div>
          </article>
        ))}
        {more && (
          <Button
            size="sm"
            variant="outline"
            disabled={reading || !connected}
            onClick={() => {
              pages.current++;
              void read();
            }}
          >
            加载更多子任务
          </Button>
        )}
        <SettingsDisclosure
          onToggle={(event) => setAdvanced(event.currentTarget.open)}
          title="高级：兼容委派与工作组历史"
        >
          {advanced && (
            <div className="mt-3 flex flex-col gap-3">
              <SettingsDisclosure title="手工只读委派">
                <div className="h-[36rem]">
                  <AgentsPane project={project} thread={thread} action={action} onOpen={onOpen} />
                </div>
              </SettingsDisclosure>
              <SettingsDisclosure title="兼容工作组计划与历史">
                <div className="h-[36rem]">
                  <WorkgroupsPane project={project} action={action} />
                </div>
              </SettingsDisclosure>
            </div>
          )}
        </SettingsDisclosure>
      </div>
    </section>
  );
}
