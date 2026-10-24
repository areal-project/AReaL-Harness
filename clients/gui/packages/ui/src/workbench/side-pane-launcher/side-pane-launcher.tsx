import type { ComponentType, SVGProps } from "react";

export function SidePaneLauncher({
  items,
}: {
  items: {
    id: string;
    label: string;
    shortcut: string;
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    onOpen: () => void;
  }[];
}) {
  return (
    <div className="side-pane-launcher">
      <ul className="side-pane-launcher-list">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <button
                type="button"
                data-side-pane-open-tab-item={item.id}
                className="side-pane-launcher-item"
                onClick={item.onOpen}
              >
                <Icon />
                <span className="side-pane-launcher-label">{item.label}</span>
                <kbd>{item.shortcut}</kbd>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
