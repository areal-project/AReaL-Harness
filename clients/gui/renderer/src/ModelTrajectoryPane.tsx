import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  RefreshCw,
  Maximize2,
  Minimize2,
  X,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Data } from "./services.js";
import { trajectoryEntries, turnStatus } from "./trajectory.js";
import { trajectoryRoleTextClass } from "./ModelTrajectoryRoleStyles.js";
import { TrajectorySectionTitle } from "./ModelTrajectorySectionTitle.js";

function highlight(text: string, query: string): ReactNode {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return text;
  const source = text.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let offset = 0,
    index = source.indexOf(needle);
  while (index >= 0) {
    parts.push(
      text.slice(offset, index),
      <mark key={index}>{text.slice(index, index + needle.length)}</mark>,
    );
    offset = index + needle.length;
    index = source.indexOf(needle, offset);
  }
  parts.push(text.slice(offset));
  return parts;
}

export function ModelTrajectoryPane({
  thread,
  title,
  refresh,
  onClose,
}: {
  thread: Data;
  title: string;
  refresh: () => Promise<unknown>;
  onClose: () => void;
}) {
  const [searchOpen, setSearchOpen] = useState(false),
    [query, setQuery] = useState("");
  const [active, setActive] = useState(0),
    [expanded, setExpanded] = useState(true);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pane = useRef<HTMLElement>(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const turns = useMemo(
    () =>
      (thread.turns ?? []).map((turn: Data, index: number) => ({
        turn,
        index,
        entries: trajectoryEntries(turn),
      })),
    [thread.turns],
  );
  const matches = useMemo(
    () =>
      query.trim()
        ? turns.flatMap(
            ({ entries }: { entries: ReturnType<typeof trajectoryEntries> }) =>
              entries
                .filter((e) =>
                  `${e.label} ${e.text}`
                    .toLocaleLowerCase()
                    .includes(query.trim().toLocaleLowerCase()),
                )
                .map((e) => e.id),
          )
        : [],
    [turns, query],
  );
  const selected = matches.length ? Math.min(active, matches.length - 1) : -1;
  const activeId = matches[selected];
  useEffect(() => {
    if (activeId)
      pane.current
        ?.querySelector<HTMLElement>(
          `[data-entry-id="${CSS.escape(activeId)}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  const move = (by: number) =>
    setActive((i) =>
      matches.length
        ? (Math.min(i, matches.length - 1) + by + matches.length) %
          matches.length
        : 0,
    );
  const closeSearch = () => {
    setSearchOpen(false);
    setQuery("");
    setActive(0);
  };
  const reload = async () => {
    setBusy(true);
    setError("");
    try {
      await refresh();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      ref={pane}
      className="trajectory-pane"
      aria-label="调用轨迹"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
          e.preventDefault();
          e.stopPropagation();
          setSearchOpen(true);
        }
        if (e.key === "Escape" && searchOpen) {
          e.preventDefault();
          e.stopPropagation();
          closeSearch();
        }
      }}
    >
      <header className="trajectory-header">
        <div className="trajectory-toolbar">
          <strong title={title}>{title}</strong>
          <button
            className="icon-button"
            title="搜索调用轨迹"
            aria-label="搜索调用轨迹"
            onClick={() => setSearchOpen(true)}
          >
            <Search size={15} />
          </button>
          <button
            className="icon-button"
            title={expanded ? "全部收起" : "全部展开"}
            aria-label={expanded ? "全部收起" : "全部展开"}
            onClick={() => {
              setExpanded(!expanded);
              setOverrides({});
            }}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            className="icon-button"
            title="刷新轨迹"
            aria-label="刷新轨迹"
            disabled={busy}
            onClick={() => void reload()}
          >
            <RefreshCw size={15} className={busy ? "animate-spin" : ""} />
          </button>
          <button
            className="icon-button"
            title="关闭轨迹"
            aria-label="关闭轨迹"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </div>
        <small>{turns.length} 轮执行 · 实时更新</small>
        <p className="trajectory-notice">
          展示已保存的执行记录；不包含逐次模型请求的完整 I/O。
        </p>
        {searchOpen && (
          <div className="trajectory-search">
            <input
              autoFocus
              type="search"
              aria-label="搜索轨迹内容"
              placeholder="搜索调用轨迹内容…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  move(e.shiftKey ? -1 : 1);
                }
              }}
            />
            <span role="status">
              {selected + 1}/{matches.length}
            </span>
            <button
              className="icon-button"
              aria-label="上一个匹配项"
              disabled={!matches.length}
              onClick={() => move(-1)}
            >
              <ArrowUp size={14} />
            </button>
            <button
              className="icon-button"
              aria-label="下一个匹配项"
              disabled={!matches.length}
              onClick={() => move(1)}
            >
              <ArrowDown size={14} />
            </button>
            <button
              className="icon-button"
              aria-label="关闭轨迹搜索"
              onClick={closeSearch}
            >
              <X size={14} />
            </button>
          </div>
        )}
        {error && <p role="alert">刷新失败：{error}</p>}
      </header>
      <div className="trajectory-scroll">
        {!turns.length && (
          <p className="trajectory-empty">
            暂无执行记录。发送消息后可在这里查看轨迹。
          </p>
        )}
        {turns.map(
          ({
            turn,
            index,
            entries,
          }: {
            turn: Data;
            index: number;
            entries: ReturnType<typeof trajectoryEntries>;
          }) => (
            <article key={turn.id} data-trajectory-turn={turn.id}>
              <div className="trajectory-turn">
                <strong>
                  {String(index + 1).padStart(2, "0")} ·{" "}
                  {thread.parentThreadId ? "子任务" : "主会话"}
                </strong>
                <span>{turnStatus(turn.status)}</span>
              </div>
              <div className="trajectory-meta">
                {turn.configuration?.model && (
                  <span>
                    {turn.configuration.model.providerId} /{" "}
                    {turn.configuration.model.modelId}
                  </span>
                )}
                {turn.usage ? (
                  <span>
                    IN {turn.usage.inputTokens.toLocaleString()} · OUT{" "}
                    {turn.usage.outputTokens.toLocaleString()}
                  </span>
                ) : (
                  <span>用量未报告</span>
                )}
              </div>
              {entries.map((entry, i) => {
                const input = entry.role === "system" || entry.role === "user";
                const previous = entries[i - 1];
                const boundary =
                  !previous ||
                  input !==
                    (previous.role === "system" || previous.role === "user");
                const open =
                  entry.id === activeId || (overrides[entry.id] ?? expanded);
                return (
                  <div
                    key={entry.id}
                    data-entry-id={entry.id}
                    className={entry.id === activeId ? "trajectory-match" : ""}
                  >
                    {boundary && (
                      <TrajectorySectionTitle
                        kind={input ? "input" : "output"}
                        label={input ? "本轮输入" : "执行输出"}
                      />
                    )}
                    <button
                      className="trajectory-entry"
                      aria-expanded={open}
                      onClick={() =>
                        setOverrides((s) => ({ ...s, [entry.id]: !open }))
                      }
                    >
                      {open ? (
                        <ChevronDown size={13} />
                      ) : (
                        <ChevronRight size={13} />
                      )}
                      <span className={trajectoryRoleTextClass(entry.role)}>
                        {entry.label}
                      </span>
                      {!open && <small>{entry.text}</small>}
                    </button>
                    {open && (
                      <pre className="trajectory-content">
                        {highlight(entry.text || "暂无内容", query)}
                      </pre>
                    )}
                  </div>
                );
              })}
              {turn.error && (
                <pre className="trajectory-error" role="alert">
                  {turn.error.message ?? JSON.stringify(turn.error)}
                </pre>
              )}
            </article>
          ),
        )}
      </div>
    </section>
  );
}
