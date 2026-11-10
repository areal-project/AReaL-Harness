import { useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { call, type CommandResponse, type PlatformServices } from "../services.js";

type Catalog = Extract<CommandResponse<"recovery", { operation: "inspect" }>, { kind: "space" }>;
type Row = Catalog["history"][number];
type ObjectValue = Record<string, unknown>;
const record = (value: unknown): ObjectValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : undefined;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const itemsInSnapshot = (page: ObjectValue) =>
  array(record(page.thread)?.turns).flatMap((turn) => array(record(turn)?.items));

export function UpgradeHistory({
  services,
  catalog,
  onBack,
}: {
  services: PlatformServices;
  catalog: Catalog;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<Row>();
  const [items, setItems] = useState<unknown[]>([]);
  const [snapshot, setSnapshot] = useState("");
  const [cursor, setCursor] = useState<string>();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const epoch = useRef(0);
  const projectNames = new Map(catalog.projects.map((project) => [project.id, project.name]));
  const read = async (row: Row, next?: string, identity?: string) => {
    const attempt = ++epoch.current;
    setPending(true);
    setFailed(false);
    try {
      const result = await call(services, "recovery", {
        operation: "history",
        projectId: row.projectId,
        threadId: row.threadId,
        ...(next ? { cursor: next, snapshotId: identity } : {}),
      });
      if (attempt !== epoch.current) return;
      const page = result.page;
      const older = next
        ? array(page.data)
            .map((entry) => record(entry)?.item)
            .filter(Boolean)
        : itemsInSnapshot(page);
      setItems((current) => (next ? [...older, ...current] : older));
      setSnapshot(result.snapshotId);
      setCursor(text(next ? page.nextCursor : record(page.history)?.nextCursor) || undefined);
    } catch {
      if (attempt === epoch.current) setFailed(true);
    } finally {
      if (attempt === epoch.current) setPending(false);
    }
  };
  const open = (row: Row) => {
    setSelected(row);
    setItems([]);
    setSnapshot("");
    setCursor(undefined);
    void read(row);
  };
  const loadDeferred = async (item: ObjectValue) => {
    if (!selected || !snapshot || !text(item.cursor) || !text(item.version)) return;
    const attempt = ++epoch.current;
    let next = text(item.cursor),
      offset = 0,
      content = "";
    setPending(true);
    setFailed(false);
    try {
      while (next) {
        const result = await call(services, "recovery", {
          operation: "history",
          projectId: selected.projectId,
          threadId: selected.threadId,
          snapshotId: snapshot,
          cursor: next,
        });
        const entry = record(array(result.page.data)[0]);
        const fragment = record(entry?.fragment);
        const chunk = text(fragment?.text);
        if (
          !fragment ||
          fragment.version !== item.version ||
          fragment.offsetUtf8 !== offset ||
          fragment.totalBytes !== item.totalBytes ||
          !chunk
        )
          throw new Error("invalid history fragment");
        offset += new TextEncoder().encode(chunk).length;
        if (fragment.nextOffsetUtf8 !== offset || offset > 64 * 1024 * 1024)
          throw new Error("invalid history fragment");
        content += chunk;
        const following = text(result.page.nextCursor);
        if (following === next || (!following && offset !== item.totalBytes))
          throw new Error("invalid history fragment");
        next = following;
      }
      const restored = record(JSON.parse(content))?.item;
      if (!record(restored)) throw new Error("invalid history item");
      if (attempt === epoch.current)
        setItems((current) =>
          current.map((entry) => (record(entry)?.id === item.id ? restored : entry)),
        );
    } catch {
      if (attempt === epoch.current) setFailed(true);
    } finally {
      if (attempt === epoch.current) setPending(false);
    }
  };
  return (
    <section aria-label={t("upgrade.history")}>
      <p>{t("upgrade.historyDescription")}</p>
      <p>{t("upgrade.historyStatus")}</p>
      {selected ? (
        <>
          <Button
            variant="ghost"
            onClick={() => {
              epoch.current++;
              setSelected(undefined);
              setPending(false);
              setFailed(false);
            }}
          >
            {t("upgrade.historyBack")}
          </Button>
          <h3>{selected.title}</h3>
          {cursor && (
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => void read(selected, cursor, snapshot)}
            >
              {t("upgrade.historyOlder")}
            </Button>
          )}
          {items.map((value, index) => {
            const item = record(value);
            if (!item) return null;
            if (item.type === "historyDeferred")
              return (
                <p key={text(item.id) || index}>
                  <Button
                    variant="outline"
                    disabled={pending}
                    onClick={() => void loadDeferred(item)}
                  >
                    {t("upgrade.historyDeferred")}
                  </Button>
                </p>
              );
            const user = item.type === "userMessage";
            if (user || item.type === "agentMessage") {
              const body = user
                ? array(item.content)
                    .map((part) => text(record(part)?.text))
                    .filter(Boolean)
                    .join("\n")
                : text(item.text);
              return (
                <article key={text(item.id) || index}>
                  <strong>{t(user ? "upgrade.historyYou" : "upgrade.historyAssistant")}</strong>
                  <p className="whitespace-pre-wrap">{body || t("upgrade.historyDescription")}</p>
                </article>
              );
            }
            return <p key={text(item.id) || index}>{t("upgrade.historyTool")}</p>;
          })}
        </>
      ) : (
        <>
          {!catalog.history.length && <p>{t("upgrade.historyEmpty")}</p>}
          {catalog.historyTruncated && <p>{t("upgrade.historyTruncated")}</p>}
          <ul>
            {catalog.history.map((row) => (
              <li key={`${row.projectId}:${row.threadId}`}>
                <Button variant="link" onClick={() => open(row)}>
                  {projectNames.has(row.projectId) ? `${projectNames.get(row.projectId)} · ` : ""}
                  {row.title}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {pending && <p role="status">{t("upgrade.historyLoading")}</p>}
      {failed && <p role="alert">{t("upgrade.historyFailed")}</p>}
      {!selected && (
        <Button variant="ghost" onClick={onBack}>
          {t("upgrade.historyGuide")}
        </Button>
      )}
    </section>
  );
}
