import { useState, type ReactNode } from "react";

import { SettingsSearchInput } from "../../settings/settings-search-input/settings-search-input.js";
import { NavigationSidebar } from "../workbench-shell/workbench-shell.js";

export type SettingsNavigationGroup = {
  id: string;
  label: string;
  items: readonly { id: string; label: string; icon?: ReactNode }[];
};

/** Presentation only. The host guards navigation and owns the active page. */
export function SettingsNavigation({ groups, activeId, onSelect, onBack, width, footer, rail, labels, locale, navigationBusy = false, backIcon, forwardIcon }: {
  groups: readonly SettingsNavigationGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  onBack: () => void;
  width?: number;
  footer?: ReactNode;
  rail?: ReactNode;
  labels: { back: string; forward: string; title: string; search: string; searchPlaceholder: string; clear: string; navigation: string; empty: string };
  locale: string; navigationBusy?: boolean; backIcon: ReactNode; forwardIcon: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const visibleGroups = groups
    .map(group => ({
      ...group,
      items: group.items.filter(item =>
        item.label.toLocaleLowerCase(locale).includes(query.trim().toLocaleLowerCase(locale))
      ),
    }))
    .filter(group => group.items.length);

  return (
    <NavigationSidebar className="settings-sidebar" width={width} rail={rail} footer={footer}
      chrome={<div className="workspace-navigation">
        <button type="button" className="icon-button settings-back" aria-label={labels.back} title={labels.back} disabled={navigationBusy} onClick={onBack}>{backIcon}</button>
        <button type="button" className="icon-button" aria-label={labels.forward} disabled>{forwardIcon}</button>
      </div>}>
      <div className="settings-sidebar-header">
        <h1 className="settings-sidebar-title">{labels.title}</h1>
        <SettingsSearchInput
          containerClassName="settings-navigation-search"
          aria-label={labels.search}
          placeholder={labels.searchPlaceholder}
          value={query}
          onChange={event => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          clearLabel={labels.clear}
        />
      </div>
      <nav className="settings-category-navigation" aria-label={labels.navigation}>
        {visibleGroups.map(group => (
          <section key={group.id} aria-label={group.label}>
            <div className="settings-group-label">{group.label}</div>
            {group.items.map(item => (
              <button
                key={item.id}
                type="button"
                className="settings-navigation-item"
                aria-current={activeId === item.id ? "page" : undefined}
                aria-pressed={activeId === item.id}
                disabled={navigationBusy}
                onClick={() => onSelect(item.id)}
                title={item.label}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            ))}
          </section>
        ))}
        {!visibleGroups.length && (
          <p className="settings-navigation-empty" role="status">
            {labels.empty}</p>
        )}
      </nav>
    </NavigationSidebar>
  );
}
