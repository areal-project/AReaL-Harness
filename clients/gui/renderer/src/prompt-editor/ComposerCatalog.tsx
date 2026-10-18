import { useLayoutEffect, useRef, useState } from "react";
import type { AppSlashCommand } from "../slashCommandHelpers.js";
import { SearchIcon } from "../interfaceIcons.js";

export interface ComposerCatalogEntry extends AppSlashCommand {
    group: "功能" | "Skills";
    source?: string;
    disabled?: boolean;
    attached?: boolean;
}
export interface ComposerCatalogData {
    entries: readonly ComposerCatalogEntry[];
    loading?: boolean;
    error?: string;
    refresh: () => void;
}
export const filterCatalog = (entries: readonly ComposerCatalogEntry[], query: string) =>
    entries.filter((entry) =>
        [
            entry.value,
            entry.label,
            entry.description,
            entry.source ?? "",
            ...(entry.keywords ?? []),
        ].some((value) => value.toLowerCase().includes(query.toLowerCase())),
    );

/** + 和斜杠共用视图及筛选；编辑器仍拥有光标和命令片段的删除。 */
export function ComposerCatalog({
    id,
    catalog,
    query,
    index,
    anchor,
    onQuery,
    onIndex,
    onChoose,
}: {
    id: string;
    catalog: ComposerCatalogData;
    query: string;
    index: number;
    anchor: HTMLElement;
    onQuery?: (query: string) => void;
    onIndex: (index: number) => void;
    onChoose: (entry: ComposerCatalogEntry) => void;
}) {
    const root = useRef<HTMLDivElement>(null);
    const search = useRef<HTMLInputElement>(null);
    const [height, setHeight] = useState(360);
    const rows = filterCatalog(catalog.entries, query);
    useLayoutEffect(() => {
        const resize = () =>
            setHeight(Math.max(80, Math.min(400, anchor.getBoundingClientRect().top - 20)));
        resize();
        const observer = new ResizeObserver(resize);
        if (anchor.parentElement) observer.observe(anchor.parentElement);
        window.addEventListener("resize", resize);
        return () => {
            observer.disconnect();
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
            <div className="composer-catalog-search">
                <SearchIcon />
                <input
                    ref={search}
                    aria-label="搜索功能与 Skills"
                    placeholder="搜索功能与 Skills"
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
            <div
                id={id}
                role="listbox"
                aria-label="功能与 Skills"
                className="composer-catalog-scroll"
            >
                {(["功能", "Skills"] as const).map((group) => (
                    <div key={group} role="group" aria-label={group}>
                        {rows.some((row) => row.group === group) && (
                            <div className="composer-catalog-group">
                                {group}
                                {group === "Skills" && <span>添加到当前消息</span>}
                            </div>
                        )}
                        {rows.map((row, i) =>
                            row.group !== group ? null : (
                                <button
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
                                    <span className="composer-catalog-description">
                                        {row.description}
                                    </span>
                                    <span className="composer-catalog-source">{row.source}</span>
                                    {row.attached && <span aria-label="已附加">✓</span>}
                                </button>
                            ),
                        )}
                    </div>
                ))}
                {!rows.length && (
                    <p className="composer-catalog-empty">
                        {catalog.loading ? "正在读取技能…" : "无匹配结果"}
                    </p>
                )}
                {catalog.error && (
                    <p role="alert" className="composer-catalog-empty">
                        {catalog.error}
                        <button type="button" onClick={catalog.refresh}>
                            重试
                        </button>
                    </p>
                )}
            </div>
        </div>
    );
}
