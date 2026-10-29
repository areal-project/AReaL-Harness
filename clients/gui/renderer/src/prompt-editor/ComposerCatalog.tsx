import { Button, Input } from "@areal/ui";
import { observeResize } from "@areal/ui/observe-resize";
import { useLayoutEffect, useRef, useState } from "react";
import type { ComposerMentionPrefill } from "../mentions/composerTypes.js";
import type { AppSlashCommand } from "../slashCommandHelpers.js";
import { SearchIcon } from "../interfaceIcons.js";
import { useI18n } from "../i18n/IntlProvider.js";

const CATALOG_GROUPS = ["commands", "功能", "会话", "应用", "Skills", "files"] as const;

export interface ComposerCatalogEntry extends AppSlashCommand {
  group: (typeof CATALOG_GROUPS)[number];
  source?: string;
  disabled?: boolean;
  attached?: boolean;
  mention?: ComposerMentionPrefill;
}
export interface ComposerCatalogData {
  entries: readonly ComposerCatalogEntry[];
  loading?: boolean;
  error?: string;
  refresh: () => void;
  searchLabel?: string;
  label?: string;
  appGroupLabel?: string;
  files?: { loading: boolean; error?: string; truncated: boolean; refresh: () => void };
}
export const filterCatalog = (entries: readonly ComposerCatalogEntry[], query: string) => {
  let recentConversations = 0;
  const normalized = query.trim().toLowerCase();
  return entries
    .filter((entry) =>
      [
        entry.value,
        entry.label,
        entry.description,
        entry.source ?? "",
        ...(entry.keywords ?? []),
      ].some((value) => value.toLowerCase().includes(normalized)),
    )
    .filter(
      (entry) =>
        (normalized.length > 0 || entry.group !== "files") &&
        (normalized.length > 0 || entry.group !== "会话" || recentConversations++ < 20),
    )
    .sort((a, b) => CATALOG_GROUPS.indexOf(a.group) - CATALOG_GROUPS.indexOf(b.group));
};

/** + 和斜杠共用视图及筛选；编辑器仍拥有光标和命令片段的删除。 */
export function ComposerCatalog({
  id,
  catalog,
  query,
  index,
  anchor,
  onQuery,
  inlineSearch = false,
  onIndex,
  onChoose,
}: {
  id: string;
  catalog: ComposerCatalogData;
  query: string;
  index: number;
  anchor: HTMLElement;
  onQuery?: (query: string) => void;
  inlineSearch?: boolean;
  onIndex: (index: number) => void;
  onChoose: (entry: ComposerCatalogEntry) => void;
}) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [height, setHeight] = useState(360);
  const rows = filterCatalog(catalog.entries, query);
  useLayoutEffect(() => {
    const resize = () =>
      setHeight(Math.max(80, Math.min(400, anchor.getBoundingClientRect().top - 20)));
    resize();
    const stopObserving = anchor.parentElement
      ? observeResize(anchor.parentElement, resize)
      : undefined;
    window.addEventListener("resize", resize);
    return () => {
      stopObserving?.();
      window.removeEventListener("resize", resize);
    };
  }, [anchor]);
  useLayoutEffect(() => {
    if (onQuery) search.current?.focus();
  }, []);
  useLayoutEffect(() => {
    root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index, query]);
  return (
    <div
      ref={root}
      className="composer-catalog"
      style={{ maxHeight: height }}
      data-testid="composer-catalog"
    >
      {!inlineSearch && (
        <div className="composer-catalog-search">
          <SearchIcon />
          <Input
            unstyled
            data-slot={undefined}
            ref={search}
            aria-label={catalog.searchLabel ?? t("chat.composer.catalogSearch")}
            placeholder={catalog.searchLabel ?? t("chat.composer.catalogSearch")}
            value={query}
            readOnly={!onQuery}
            tabIndex={onQuery ? 0 : -1}
            onChange={(event) => {
              onQuery?.(event.target.value);
              onIndex(0);
            }}
            aria-controls={id}
            aria-activedescendant={rows.length ? `${id}-${index}` : undefined}
          />
          <span>Esc</span>
        </div>
      )}
      <div
        id={id}
        role="listbox"
        aria-label={catalog.label ?? t("chat.composer.catalogLabel")}
        className="composer-catalog-scroll"
      >
        {CATALOG_GROUPS.filter(
          (group) =>
            (group !== "commands" && group !== "files") ||
            rows.some((row) => row.group === group) ||
            (group === "files" && !!query.trim() && !!catalog.files),
        ).map((group) => (
          <div
            key={group}
            role="group"
            aria-label={
              group === "files"
                ? t("chat.composer.filesGroup")
                : group === "commands"
                  ? t("chat.composer.commandsGroup")
                  : group === "会话"
                    ? t("chat.composer.conversationsGroup")
                    : group === "应用"
                      ? (catalog.appGroupLabel ?? catalog.label ?? t("chat.composer.appsGroup"))
                      : group === "功能"
                        ? t("chat.composer.actionsGroup")
                        : group
            }
          >
            {(rows.some((row) => row.group === group) || (group === "files" && catalog.files)) && (
              <div className="composer-catalog-group">
                {group === "files"
                  ? t("chat.composer.filesGroup")
                  : group === "commands"
                    ? t("chat.composer.commandsGroup")
                    : group === "会话"
                      ? t("chat.composer.conversationsGroup")
                      : group === "应用"
                        ? (catalog.appGroupLabel ?? catalog.label ?? t("chat.composer.appsGroup"))
                        : group === "功能"
                          ? t("chat.composer.actionsGroup")
                          : group}
                {group === "Skills" && <span>{t("chat.composer.addToCurrentMessage")}</span>}
              </div>
            )}
            {group === "files" && catalog.files && (
              <>
                {catalog.files.loading && (
                  <p role="status" className="composer-catalog-empty">
                    {t("common.loading")}
                  </p>
                )}
                {catalog.files.error && (
                  <p role="alert" className="composer-catalog-empty">
                    {catalog.files.error}
                    <Button
                      unstyled
                      data-slot={undefined}
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={catalog.files.refresh}
                    >
                      {t("chat.composer.retryCatalog")}
                    </Button>
                  </p>
                )}
                {!catalog.files.loading &&
                  !catalog.files.error &&
                  !rows.some((row) => row.group === "files") && (
                    <p className="composer-catalog-empty">{t("chat.composer.noFileMatches")}</p>
                  )}
                {catalog.files.truncated && (
                  <p role="status" className="composer-catalog-empty">
                    {t("chat.composer.fileResultsLimited")}
                  </p>
                )}
              </>
            )}
            {rows.map((row, i) =>
              row.group !== group ? null : (
                <Button
                  unstyled
                  data-slot={undefined}
                  id={`${id}-${i}`}
                  key={row.value}
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  aria-disabled={row.disabled}
                  tabIndex={-1}
                  className="composer-catalog-row"
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => onIndex(i)}
                  onClick={() => {
                    if (!row.disabled) onChoose(row);
                  }}
                >
                  <span className="composer-catalog-icon" aria-hidden="true">
                    {row.icon}
                  </span>
                  <span className="composer-catalog-name">{row.label}</span>
                  <span className="composer-catalog-description">{row.description}</span>
                  <span className="composer-catalog-source">{row.source}</span>
                  {row.attached && <span aria-label={t("chat.composer.attached")}>✓</span>}
                </Button>
              ),
            )}
          </div>
        ))}
        {!rows.length && !catalog.files && (
          <p className="composer-catalog-empty">
            {catalog.loading ? t("common.loading") : t("chat.composer.noMatches")}
          </p>
        )}
        {catalog.error && (
          <p role="alert" className="composer-catalog-empty">
            {catalog.error}
            <Button unstyled data-slot={undefined} type="button" onClick={catalog.refresh}>
              {t("chat.composer.retryCatalog")}
            </Button>
          </p>
        )}
      </div>
    </div>
  );
}
