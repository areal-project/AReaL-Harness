import { Button, Input } from "@areal/ui";
import { currentErrorText } from "./errors/currentErrorText.js";
import { useEffect, useRef, useState } from "react";
import type { Action, Data } from "./services.js";
import { useArchiveConfirm } from "./ArchiveConfirm.js";

export function RelatedSideChats({
  project,
  sourceId,
  selectedId,
  onSelect,
  action,
  showNew = true,
}: {
  project: Data;
  sourceId: string;
  selectedId: string;
  onSelect: (id: string) => void;
  action: Action;
  showNew?: boolean;
}) {
  const archive = useArchiveConfirm();
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<Data[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    if (!project.state?.connected) return;
    const requestGeneration = ++generation.current;
    let current = true;
    setBusy(true);
    setError("");
    void action("side", {
      projectId: project.id,
      operation: "list",
      sourceThreadId: sourceId,
      includeArchived: archived,
    })
      .then((page: Data) => {
        if (current && generation.current === requestGeneration) {
          setItems(
            (page.data ?? []).filter(
              (item: Data) => item.conversation?.policy?.kind === "sideReadOnlyV1",
            ),
          );
          setCursor(page.nextCursor ?? undefined);
        }
      })
      .catch((cause: Error) => {
        if (current && generation.current === requestGeneration) setError(currentErrorText(cause));
      })
      .finally(() => {
        if (current && generation.current === requestGeneration) setBusy(false);
      });
    return () => {
      current = false;
      generation.current++;
    };
  }, [
    project.id,
    project.state?.connected,
    sourceId,
    archived,
    selectedId,
    revision,
    project.core?.connectionGeneration,
    action,
  ]);
  const more = async () => {
    if (!cursor || busy) return;
    const expected = cursor;
    const requestGeneration = generation.current;
    setBusy(true);
    setError("");
    try {
      const page = await action("side", {
        projectId: project.id,
        operation: "list",
        sourceThreadId: sourceId,
        includeArchived: archived,
        cursor: expected,
      });
      if (generation.current === requestGeneration) {
        setItems((previous) => [
          ...previous,
          ...page.data.filter((item: Data) => item.conversation?.policy?.kind === "sideReadOnlyV1"),
        ]);
        setCursor(page.nextCursor ?? undefined);
      }
    } catch (cause) {
      if (generation.current === requestGeneration) setError((cause as Error).message);
    } finally {
      if (generation.current === requestGeneration) setBusy(false);
    }
  };
  const changeArchive = async (item: Data) => {
    if (!item.desktop?.archived && !(await archive.confirm())) return;
    setBusy(true);
    setError("");
    try {
      await action("manage", {
        projectId: project.id,
        operation: item.desktop?.archived ? "unarchive" : "archive",
        threadId: item.id,
      });
      setRevision((value) => value + 1);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="相关讨论">
      <div className="utility-actions">
        <strong>相关讨论</strong>
        {showNew && (
          <Button unstyled data-slot={undefined} type="button" onClick={() => onSelect("")}>
            新讨论
          </Button>
        )}
        <Button
          unstyled
          data-slot={undefined}
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          disabled={busy}
        >
          刷新
        </Button>
        <label>
          <Input
            unstyled
            data-slot={undefined}
            type="checkbox"
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          包含已归档
        </label>
      </div>
      {error && <p role="alert">{error}</p>}
      {items.length === 0 && !busy && (
        <p className="text-foreground-subtle">暂无已发送的侧边聊天</p>
      )}
      {items.map((item) => (
        <div key={item.id} className="utility-actions">
          <Button
            unstyled
            data-slot={undefined}
            type="button"
            aria-current={selectedId === item.id ? "true" : undefined}
            onClick={() => onSelect(item.id)}
          >
            {item.preview || "侧边聊天"}
            {item.desktop?.archived ? " · 已归档" : ""}
          </Button>
          <Button
            unstyled
            data-slot={undefined}
            type="button"
            disabled={busy || (item.status?.type !== "idle" && !item.desktop?.archived)}
            onClick={() => void changeArchive(item)}
          >
            {item.desktop?.archived ? "恢复" : "归档"}
          </Button>
        </div>
      ))}
      {cursor && (
        <Button
          unstyled
          data-slot={undefined}
          type="button"
          disabled={busy}
          onClick={() => void more()}
        >
          加载更多
        </Button>
      )}
      {archive.dialog}
    </section>
  );
}
