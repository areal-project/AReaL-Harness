import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@areal/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, RefreshCw, X, ChevronDown, ChevronRight } from "lucide-react";
import type { Action, Data } from "./services.js";
import { trajectoryEntries, type TrajectoryEntry } from "./trajectory.js";
import {
  activityDuration,
  copyTrace,
  loadTraceTree,
  traceCoverage,
  traceDuration,
  traceCreationTurn,
  traceReferences,
  type TraceNode,
} from "./trajectory-inspection.js";
import { TrajectorySectionTitle } from "./ModelTrajectorySectionTitle.js";
import { CopyTextAction } from "./MessageActions.js";
import { trajectoryRoleTextClass } from "./ModelTrajectoryRoleStyles.js";
import { useI18n, type MessageId } from "./i18n/IntlProvider.js";

const statusKeys: Record<string, MessageId> = {
  inProgress: "trace.running",
  running: "trace.running",
  completed: "trace.completed",
  succeeded: "trace.completed",
  failed: "trace.failed",
  interrupted: "trace.interrupted",
  cancelled: "trace.cancelled",
  unknown: "trace.unknown",
};
const activityKeys: Record<string, MessageId> = {
  model: "trace.model",
  modelCapacityWait: "trace.modelCapacityWait",
  subagentWait: "trace.subagentWait",
  retryWait: "trace.retryWait",
  approvalWait: "trace.approvalWait",
  questionWait: "trace.questionWait",
  compaction: "trace.compaction",
};
const isException = (status?: string) =>
  ["failed", "unknown", "interrupted", "cancelled"].includes(status ?? "");
const entryId = (node: TraceNode, turn: Data, entry: TrajectoryEntry) =>
  `${node.threadId}:${turn.id}:${entry.id}`;

function OriginalResult({
  uri,
  node,
  projectId,
  action,
}: {
  uri: string;
  node: TraceNode;
  projectId: string;
  action: Action;
}) {
  const { t } = useI18n();
  const [text, setText] = useState<string>(),
    [error, setError] = useState(""),
    [query, setQuery] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const value = node.target?.executionId
        ? await action("manage", {
            projectId,
            operation: "executionTraceResult",
            threadId: node.target.threadId,
            executionId: node.target.executionId,
            workerThreadId: node.threadId,
            uri,
          })
        : await action("media", { projectId, threadId: node.threadId, operation: "read", uri });
      setText(new TextDecoder().decode(new Uint8Array(value.bytes)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="trajectory-raw">
      <p>{t("trace.rawAbbreviated")}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>
        {t("trace.raw")}
      </Button>
      {error && (
        <p role="alert">
          {t("trace.rawMissing")}: {error}
        </p>
      )}
      {text !== undefined && (
        <>
          <Input
            aria-label={t("trace.rawSearch")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <pre className="trajectory-content">
            {query
              ? text
                  .split("\n")
                  .filter((line) => line.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
                  .join("\n") || t("trace.noMatches")
              : text}
          </pre>
        </>
      )}
    </div>
  );
}

export function ModelTrajectoryPane({
  thread,
  title,
  projectId,
  action,
  refresh,
  onClose,
}: {
  thread: Data;
  title: string;
  projectId: string;
  action: Action;
  refresh: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const [root, setRoot] = useState<TraceNode>();
  const [query, setQuery] = useState(""),
    [filter, setFilter] = useState("all"),
    [threshold, setThreshold] = useState("10"),
    [custom, setCustom] = useState("10"),
    [sort, setSort] = useState("chronological");
  const [open, setOpen] = useState<Record<string, boolean>>({}),
    [expanded, setExpanded] = useState(false),
    [activeId, setActiveId] = useState("");
  const [busy, setBusy] = useState(true),
    [error, setError] = useState(""),
    [now, setNow] = useState(Date.now());
  const [revision, setRevision] = useState(0);
  const [locateRevision, setLocateRevision] = useState(0);
  const pane = useRef<HTMLElement>(null),
    search = useRef<HTMLInputElement>(null),
    previous = useRef<TraceNode | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      setBusy(true);
      try {
        const value = await loadTraceTree(
          action,
          projectId,
          thread.id,
          controller.signal,
          previous.current,
        );
        if (controller.signal.aborted) return;
        previous.current = value;
        setRoot(value);
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) {
          setBusy(false);
          timer = setTimeout(() => void read(), 2000);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [action, projectId, thread.id, revision]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const fallback: TraceNode = {
    threadId: thread.id,
    title,
    turns: thread.turns ?? [],
    children: [],
    queue: thread.desktop?.queue,
    errors: [],
    readAtMs: now,
  };
  const tree = root ?? fallback;
  const coverage = [
    ...(root ? traceCoverage(root) : [t("trace.loading")]),
    ...(error ? [error] : []),
  ];
  const duration = (ms?: number) =>
    ms == null
      ? t("trace.unrecorded")
      : new Intl.NumberFormat(locale, {
          style: "unit",
          unit: "second",
          maximumFractionDigits: 1,
        }).format(ms / 1000);
  const status = (value?: string) => t(statusKeys[value ?? ""] ?? "trace.unconfirmed");
  const label = (entry: TrajectoryEntry) => {
    if (!entry.activity) return entry.label;
    if (entry.activity.kind === "model") {
      const phase =
        entry.status === "running"
          ? entry.activity.firstContentMs == null
            ? "trace.modelWait"
            : "trace.generation"
          : "trace.model";
      return `${t(phase)} · ${entry.label}`;
    }
    return t(activityKeys[entry.activity.kind] ?? "trace.current");
  };
  const getDuration = (entry: TrajectoryEntry, turn: Data, node?: TraceNode) =>
    activityDuration(
      error || node?.errors.length ? { ...entry, status: "unknown" } : entry,
      turn,
      now,
    );
  const candidates: {
    node: TraceNode;
    turn: Data;
    entry: TrajectoryEntry;
    id: string;
    path: string;
    duration?: number;
  }[] = [];
  const gather = (node: TraceNode, ancestors: string[]) => {
    for (const turn of node.turns) {
      for (const entry of trajectoryEntries(turn))
        candidates.push({
          node,
          turn,
          entry,
          id: entryId(node, turn, entry),
          path: [...ancestors, node.title || node.threadId, `${t("trace.turn")} ${turn.id}`].join(
            " → ",
          ),
          duration: getDuration(entry, turn, node),
        });
    }
    for (const child of node.children)
      for (const source of child.nodes)
        gather(source, [
          ...ancestors,
          node.title || node.threadId,
          `${t("trace.turn")} ${traceCreationTurn(node, child.execution) ?? t("trace.unrecorded")}`,
          child.execution.title || child.execution.executionId,
        ]);
  };
  gather(tree, []);
  const thresholdMs = Math.max(0, Number(threshold === "custom" ? custom : threshold) || 0) * 1000;
  const filtered = candidates.filter(({ node, turn, entry, duration: ms }) => {
    const matches =
      `${node.title} ${turn.id} ${turn.configuration?.model?.modelId ?? ""} ${status(turn.status)} ${JSON.stringify(turn.error ?? null)} ${label(entry)} ${entry.text}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase());
    return (
      matches &&
      (filter === "all" ||
        (filter === "running" && turn.status === "inProgress" && entry.status === "running") ||
        (filter === "exceptions" && (isException(entry.status) || !!turn.error)) ||
        (filter === "failed" && turn.status === "failed") ||
        (filter === "slow" && ms != null && ms >= thresholdMs) ||
        (filter === "interrupted" && turn.status === "interrupted") ||
        (filter === "unknown" &&
          (entry.status === "unknown" || (!!node.errors.length && entry.status === "running"))))
    );
  });
  if (sort === "duration") filtered.sort((a, b) => (b.duration ?? -1) - (a.duration ?? -1));
  const filtering = !!query.trim() || filter !== "all" || sort !== "chronological";
  const locate = (id: string) => {
    setActiveId(id);
    setLocateRevision((value) => value + 1);
    const found = candidates.find((candidate) => candidate.id === id);
    if (!found) return;
    const ancestors: Record<string, boolean> = {};
    const find = (node: TraceNode): boolean => {
      if (node.threadId === found.node.threadId) return true;
      for (const child of node.children) {
        if (child.nodes.some(find)) {
          ancestors[child.execution.executionId] = true;
          return true;
        }
      }
      return false;
    };
    find(tree);
    setOpen((values) => ({ ...values, ...ancestors, [id]: true }));
  };
  useEffect(() => {
    if (activeId)
      pane.current
        ?.querySelector(`[data-entry-id="${CSS.escape(activeId)}"]`)
        ?.scrollIntoView({ block: "nearest" });
  }, [activeId, locateRevision]);
  const allCopy = useMemo(
    () => () =>
      copyTrace(tree, title, undefined, error ? [error] : root ? [] : [t("trace.loading")]),
    [tree, title, error, root, t],
  );
  const filteredCopy = () =>
    JSON.stringify(
      {
        format: "areal-harness-trajectory-v1",
        scope: "filtered",
        query,
        filter,
        thresholdMs,
        sort,
        coverage,
        readAtMs: tree.readAtMs,
        records: filtered.map((c) => ({
          threadId: c.node.threadId,
          turnId: c.turn.id,
          path: c.path,
          entry: c.entry,
        })),
      },
      null,
      2,
    );

  const childView = (node: TraceNode, child: TraceNode["children"][number]) => {
    const id = child.execution.executionId;
    const childTurns = child.nodes.flatMap((n) => n.turns);
    const span =
      child.execution.durationMs ??
      (child.execution.elapsedMs != null
        ? child.execution.elapsedMs +
          (child.execution.settled || child.error ? 0 : Math.max(0, now - node.readAtMs))
        : childTurns.length === 1 && !child.nodes.some((value) => value.errors.length)
          ? traceDuration(childTurns[0], now)
          : undefined);
    return (
      <div key={id} data-execution-id={id} className="trajectory-child">
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={open[id] ?? expanded}
          onClick={() => setOpen((values) => ({ ...values, [id]: !(values[id] ?? expanded) }))}
        >
          {(open[id] ?? expanded) ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {child.execution.title || id} · {status(child.execution.status)} · {t("trace.lifetime")}{" "}
          {duration(Number.isFinite(span) ? span : undefined)}
        </Button>
        {child.execution.error && <p role="alert">{child.execution.error}</p>}
        {child.error && (
          <p role="alert">
            {t("trace.coverage")}: {child.error}
          </p>
        )}
        {(open[id] ?? expanded) && child.nodes.map(renderNode)}
      </div>
    );
  };

  const renderNode = (node: TraceNode) => (
    <div key={node.threadId} data-trace-thread={node.threadId}>
      {(node.queue?.items ?? [])
        .filter((item: Data) => item.status === "pending")
        .map((item: Data) => (
          <p className="trajectory-meta" key={item.id} data-queued-item={item.id}>
            {t("trace.queue")} ·{" "}
            {duration(item.queuedAtMs == null ? undefined : Math.max(0, now - item.queuedAtMs))} ·{" "}
            {(item.input ?? []).map((part: Data) => part.text ?? "").join(" ")}
          </p>
        ))}
      {node.turns.map((turn, index) => {
        const entries = trajectoryEntries(turn);
        const children = node.children.filter(
          (c) => traceCreationTurn(node, c.execution) === turn.id,
        );
        const current = entries.filter(
          (e) => e.status === "running" && turn.status === "inProgress",
        );
        const slowest = entries
          .filter((e) => e.activity?.kind === "model" || e.role === "tool-call")
          .map((entry) => ({ entry, ms: getDuration(entry, turn, node) }))
          .filter((v) => v.ms != null)
          .sort((a, b) => b.ms! - a.ms!)
          .slice(0, 3);
        return (
          <article key={turn.id} data-trajectory-turn={turn.id}>
            <div className="trajectory-turn">
              <strong>
                {t("trace.turn")} {index + 1} · {node.title || t("trace.main")}
              </strong>
              <span>
                {error || node.errors.length ? t("trace.unconfirmed") : status(turn.status)}
              </span>
              <CopyTextAction
                text={() =>
                  copyTrace(
                    node,
                    title,
                    turn.id,
                    error ? [error] : root ? [] : [t("trace.loading")],
                  )
                }
                noun={t("trace.copyTurn")}
                iconSize={14}
              />
            </div>
            <div className="trajectory-meta">
              <span>
                {t("trace.queue")} {duration(turn.trace?.queueDurationMs)}
              </span>
              <span>
                {t("trace.execution")}{" "}
                {duration(
                  traceDuration(
                    error || node.errors.length ? { ...turn, status: "unknown" } : turn,
                    now,
                  ),
                )}
              </span>
              <span>
                {t("trace.subagents")} {children.length}
              </span>
              <span>
                {t("trace.retries")}{" "}
                {(turn.trace?.activities ?? []).filter((a: Data) => a.kind === "retryWait").length}
              </span>
              <span>
                {t("trace.errors")}{" "}
                {entries.filter((e) => isException(e.status)).length + (turn.error ? 1 : 0)}
              </span>
            </div>
            <div className="trajectory-meta">
              <span>{turn.configuration?.model?.modelId}</span>
              <span>
                {turn.usage
                  ? `IN ${turn.usage.inputTokens} · OUT ${turn.usage.outputTokens}`
                  : t("trace.usageMissing")}
              </span>
            </div>
            {turn.continuedFromTurnId && (
              <p className="trajectory-meta">
                {t("trace.continued")} {turn.continuedFromTurnId}
              </p>
            )}
            {turn.interruption && (
              <p className="trajectory-meta">
                {t("trace.recovery")}:{" "}
                {typeof turn.interruption === "string"
                  ? turn.interruption
                  : JSON.stringify(turn.interruption)}
              </p>
            )}
            {turn.status !== "inProgress" && turn.durationMs == null && (
              <p className="trajectory-meta">{t("trace.incompleteTime")}</p>
            )}
            {current.length > 0 && (
              <div className="trajectory-meta">
                {t("trace.current")}:{" "}
                {current.map((e) => (
                  <span key={e.id}>
                    {error || node.errors.length ? t("trace.unconfirmed") : label(e)} ·{" "}
                    {duration(getDuration(e, turn, node))} · {t("trace.latest")}{" "}
                    {e.startedAtMs
                      ? new Date(
                          e.startedAtMs + (e.activity?.firstContentMs ?? 0),
                        ).toLocaleTimeString(locale)
                      : t("trace.unrecorded")}
                  </span>
                ))}
              </div>
            )}
            {!!slowest.length && (
              <div className="trajectory-meta">
                {t("trace.longCalls")}:{" "}
                {slowest.map(({ entry, ms }) => (
                  <Button
                    key={entry.id}
                    size="sm"
                    variant="ghost"
                    onClick={() => locate(entryId(node, turn, entry))}
                  >
                    {label(entry)} {duration(ms)}
                  </Button>
                ))}
              </div>
            )}
            {entries.map((entry) => {
              const input = entry.role === "system" || entry.role === "user";
              const previous = entries[entries.indexOf(entry) - 1];
              const boundary =
                !previous || input !== (previous.role === "system" || previous.role === "user");
              const id = entryId(node, turn, entry),
                shown = open[id] ?? expanded;
              const created = node.children.filter(
                (c) => c.execution.requestId === entry.callId && entry.role === "tool-call",
              );
              const references =
                entry.role === "tool-call"
                  ? traceReferences(
                      node,
                      turn.items.find((item: Data) => item.callId === entry.callId) ?? {},
                    )
                  : [];
              return (
                <div
                  key={id}
                  data-entry-id={id}
                  className={id === activeId ? "trajectory-match" : ""}
                >
                  {boundary && (
                    <TrajectorySectionTitle
                      kind={input ? "input" : "output"}
                      label={t(input ? "trace.input" : "trace.output")}
                    />
                  )}
                  <Button
                    unstyled
                    data-slot={undefined}
                    type="button"
                    className="trajectory-entry"
                    aria-expanded={shown}
                    onClick={() => setOpen((values) => ({ ...values, [id]: !shown }))}
                  >
                    {shown ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <span className={trajectoryRoleTextClass(entry.role)}>{label(entry)}</span>
                    {entry.status && (
                      <span>
                        {turn.status !== "inProgress" && entry.status === "running"
                          ? t("trace.unconfirmed")
                          : status(entry.status)}{" "}
                        · {duration(getDuration(entry, turn, node))}
                      </span>
                    )}
                    {!shown && <small>{entry.text}</small>}
                  </Button>
                  {shown && (
                    <>
                      <pre className="trajectory-content">{entry.text || t("trace.empty")}</pre>
                      {entry.activity?.kind === "model" && (
                        <p className="trajectory-meta">
                          {t("trace.firstContent")}:{" "}
                          {entry.activity.firstContentMs != null
                            ? duration(entry.activity.firstContentMs)
                            : entry.status === "completed" || entry.status === "failed"
                              ? t("trace.noContent")
                              : t("trace.unrecorded")}{" "}
                          · {t("trace.generated")}:{" "}
                          {entry.activity.firstContentMs != null && entry.durationMs != null
                            ? duration(
                                Math.max(0, entry.durationMs - entry.activity.firstContentMs),
                              )
                            : t("trace.unrecorded")}
                        </p>
                      )}
                      {entry.rawResult && (
                        <OriginalResult
                          uri={entry.rawResult}
                          node={node}
                          projectId={projectId}
                          action={action}
                        />
                      )}
                    </>
                  )}
                  {created.map((child) => childView(node, child))}
                  {references.map((reference) => (
                    <Button
                      key={reference}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setOpen((values) => ({ ...values, [reference]: true }));
                        requestAnimationFrame(() =>
                          pane.current
                            ?.querySelector(`[data-execution-id="${CSS.escape(reference)}"]`)
                            ?.scrollIntoView({ block: "nearest" }),
                        );
                      }}
                    >
                      {t("trace.reference")} {reference}
                    </Button>
                  ))}
                </div>
              );
            })}
            {children
              .filter(
                (c) =>
                  !entries.some(
                    (e) => e.role === "tool-call" && e.callId === c.execution.requestId,
                  ),
              )
              .map((child) => childView(node, child))}
            {turn.error && (
              <pre className="trajectory-error" role="alert">
                {turn.error.message ?? JSON.stringify(turn.error)}
              </pre>
            )}
          </article>
        );
      })}
      {node.children
        .filter((c) => !traceCreationTurn(node, c.execution))
        .map((child) => childView(node, child))}
    </div>
  );
  return (
    <section
      ref={pane}
      className="trajectory-pane"
      aria-label={t("trace.panel")}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
          event.preventDefault();
          event.stopPropagation();
          search.current?.focus();
        }
        if (event.key === "Escape" && (query || document.activeElement === search.current)) {
          event.preventDefault();
          event.stopPropagation();
          setQuery("");
          search.current?.blur();
        }
      }}
    >
      <header className="trajectory-header">
        <div className="trajectory-toolbar">
          <strong title={title}>{title}</strong>
          <CopyTextAction text={allCopy} noun={t("trace.copyAll")} iconSize={15} />
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("trace.searchOpen")}
            onClick={() => search.current?.focus()}
          >
            <Search size={15} />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setExpanded(!expanded);
              setOpen({});
            }}
          >
            {t(expanded ? "trace.collapse" : "trace.expand")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("trace.refresh")}
            onClick={() => {
              void refresh().catch(() => {});
              setRevision((v) => v + 1);
            }}
          >
            <RefreshCw size={15} />
          </Button>
          <Button size="sm" variant="ghost" aria-label={t("trace.close")} onClick={onClose}>
            <X size={15} />
          </Button>
        </div>
        <p className="trajectory-notice">{t("trace.notice")}</p>
        <p className="trajectory-notice" role="status">
          {busy && !root
            ? t("trace.loading")
            : coverage.length
              ? t("trace.coverage")
              : t("trace.complete")}
        </p>
        {coverage.map((message, i) => (
          <p key={i} className="trajectory-notice">
            {message}
          </p>
        ))}
        <div className="trajectory-search">
          <Input
            ref={search}
            type="search"
            aria-label={t("trace.search")}
            placeholder={t("trace.search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <CopyTextAction text={filteredCopy} noun={t("trace.copyFiltered")} iconSize={14} />
        </div>
        <div className="trajectory-filters">
          <Select value={filter} onValueChange={(value) => setFilter(value ?? "all")}>
            <SelectTrigger aria-label={t("trace.statusFilter")}>
              <SelectValue>{t(`trace.${filter}` as MessageId)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {["all", "running", "exceptions", "failed", "slow", "interrupted", "unknown"].map(
                (value) => (
                  <SelectItem key={value} value={value}>
                    {t(`trace.${value}` as MessageId)}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
          <Select value={threshold} onValueChange={(value) => setThreshold(value ?? "10")}>
            <SelectTrigger aria-label={t("trace.threshold")}>
              <SelectValue>
                {threshold === "custom" ? t("trace.custom") : `${threshold} ${t("trace.seconds")}`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {["10", "30", "60"].map((value) => (
                <SelectItem key={value} value={value}>
                  {value} {t("trace.seconds")}
                </SelectItem>
              ))}
              <SelectItem value="custom">{t("trace.custom")}</SelectItem>
            </SelectContent>
          </Select>
          {threshold === "custom" && (
            <Input
              type="number"
              min={0}
              aria-label={t("trace.custom")}
              value={custom}
              onChange={(event) => setCustom(event.target.value)}
            />
          )}
          <Select value={sort} onValueChange={(value) => setSort(value ?? "chronological")}>
            <SelectTrigger aria-label={t("trace.sort")}>
              <SelectValue>
                {t(sort === "duration" ? "trace.descending" : "trace.chronological")}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chronological">{t("trace.chronological")}</SelectItem>
              <SelectItem value="duration">{t("trace.descending")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </header>
      <div className="trajectory-scroll">
        {filtering && (
          <div className="trajectory-results">
            <p role="status">
              {t("trace.matches")} {filtered.length}
              {coverage.length ? ` · ${t("trace.coverage")}` : ""}
            </p>
            {!filtered.length && <p>{t("trace.noMatches")}</p>}
            {filtered.map((candidate) => (
              <Button
                key={candidate.id}
                variant="ghost"
                size="sm"
                onClick={() => locate(candidate.id)}
              >
                {candidate.path} → {label(candidate.entry)} · {duration(candidate.duration)}
              </Button>
            ))}
          </div>
        )}
        {!tree.turns.length && <p className="trajectory-empty">{t("trace.empty")}</p>}
        {renderNode(tree)}
      </div>
    </section>
  );
}
