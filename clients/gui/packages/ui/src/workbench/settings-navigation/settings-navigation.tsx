import { TitleTooltip } from "../../components/tooltip/tooltip.js";
import { useState, type ReactNode } from "react";

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
      <nav className="settings-category-navigation" aria-label={labels.navigation}>
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
    </NavigationSidebar>
  );
}
