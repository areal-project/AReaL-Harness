import { TitleTooltip } from "../../components/tooltip/tooltip.js";
import { useEffect, useState, type ReactNode } from "react";

import { SettingsSearchInput } from "../../settings/settings-search-input/settings-search-input.js";
import { NavigationSidebar } from "../workbench-shell/workbench-shell.js";

export type SettingsNavigationGroup = {
  id: string;
  label: string;
  /** keywords 是该页里的条目名，用“、”或逗号分隔，供搜索命中具体设置项。 */
  items: readonly { id: string; label: string; icon?: ReactNode; keywords?: string }[];
};

/** Presentation only. The host guards navigation and owns the active page. */
export function SettingsNavigation({
  groups,
  activeId,
  onSelect,
  onBack,
  width,
  footer,
  rail,
  labels,
  locale,
  navigationBusy = false,
  backIcon,
  forwardIcon,
  variant = "sidebar",
}: {
  groups: readonly SettingsNavigationGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  onBack: () => void;
  width?: number;
  footer?: ReactNode;
  rail?: ReactNode;
  labels: {
    back: string;
    forward: string;
    title: string;
    search: string;
    searchPlaceholder: string;
    clear: string;
    navigation: string;
    empty: string;
  };
  locale: string;
  navigationBusy?: boolean;
  backIcon: ReactNode;
  forwardIcon: ReactNode;
  variant?: "sidebar" | "modal";
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase(locale);
  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.flatMap((item) => {
        if (item.label.toLocaleLowerCase(locale).includes(needle)) return [{ ...item, match: "" }];
        // 标题没命中时看页内条目，命中后在标题下写出是哪一项。
        const match = needle
          ? item.keywords
              ?.split(/[、,，]\s*/)
              .find((word) => word.toLocaleLowerCase(locale).includes(needle))
          : undefined;
        return match ? [{ ...item, match }] : [];
      }),
    }))
    .filter((group) => group.items.length);

  // 搜索过滤后若当前页不在命中列表内，自动切到首个命中页，避免右侧停留在不相关设置页。
  const firstMatchedId = needle ? visibleGroups[0]?.items[0]?.id : undefined;
  const activeVisible =
    !needle || visibleGroups.some((group) => group.items.some((item) => item.id === activeId));
  useEffect(() => {
    if (firstMatchedId && !activeVisible && !navigationBusy) {
      onSelect(firstMatchedId);
    }
  }, [firstMatchedId, activeVisible, navigationBusy, onSelect]);

  const navigationBody = (
    <>
      <div className="settings-sidebar-header">
        <h1 className="settings-sidebar-title">{labels.title}</h1>
        <SettingsSearchInput
          containerClassName="settings-navigation-search"
          aria-label={labels.search}
          placeholder={labels.searchPlaceholder}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          clearLabel={labels.clear}
        />
      </div>
      <nav
        className="settings-category-navigation"
        aria-label={labels.navigation}
        onKeyDown={(event) => {
          if (
            event.defaultPrevented ||
            !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
          )
            return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button.settings-navigation-item:not(:disabled)",
            ),
          );
          if (!items.length) return;
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          let next = 0;
          if (event.key === "ArrowDown") next = current < 0 ? 0 : (current + 1) % items.length;
          else if (event.key === "ArrowUp")
            next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
          else if (event.key === "End") next = items.length - 1;
          event.preventDefault();
          items[next]?.focus();
        }}
      >
        {visibleGroups.map((group) => (
          <section key={group.id} aria-label={group.label}>
            <div className="settings-group-label">{group.label}</div>
            {group.items.map((item) => (
              <TitleTooltip key={item.id} title={item.label}>
                <button
                  type="button"
                  className="settings-navigation-item"
                  aria-current={activeId === item.id ? "page" : undefined}
                  aria-pressed={activeId === item.id}
                  disabled={navigationBusy}
                  onClick={() => onSelect(item.id)}
                >
                  {item.icon}
                  <span>{item.label}</span>
                  {item.match && <small className="settings-navigation-match">{item.match}</small>}
                </button>
              </TitleTooltip>
            ))}
          </section>
        ))}
        {!visibleGroups.length && (
          <p className="settings-navigation-empty" role="status">
            {labels.empty}
          </p>
        )}
      </nav>
    </>
  );

  if (variant === "modal") {
    return (
      <aside className="settings-sidebar settings-modal-sidebar" data-settings-variant="modal">
        {navigationBody}
      </aside>
    );
  }

  return (
    <NavigationSidebar
      className="settings-sidebar"
      width={width}
      rail={rail}
      footer={footer}
      chrome={
        <div className="workspace-navigation">
          <TitleTooltip title={labels.back}>
            <button
              type="button"
              className="icon-button settings-back"
              aria-label={labels.back}
              disabled={navigationBusy}
              onClick={onBack}
            >
              {backIcon}
            </button>
          </TitleTooltip>
          <button type="button" className="icon-button" aria-label={labels.forward} disabled>
            {forwardIcon}
          </button>
        </div>
      }
    >
      {navigationBody}
    </NavigationSidebar>
  );
}
