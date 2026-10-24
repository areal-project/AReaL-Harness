import { Tabs, TabsList, TabsTrigger } from "../../components/tabs/tabs.js";

interface SettingsSegmentedTabItem<TValue extends string> {
  label: string;
  value: TValue;
  disabled?: boolean;
}

/** 设置详情页共用的紧凑分段切换，避免相同层级出现多套 Tabs 视觉。 */
export function SettingsSegmentedTabs<TValue extends string>({
  items,
  value,
  onValueChange,
  activateOnFocus = true,
  disabled = false,
  ariaLabel,
}: {
  items: readonly SettingsSegmentedTabItem<TValue>[];
  value: TValue;
  onValueChange: (value: TValue) => void;
  /** Guarded (dirty-checked) tab switches must activate on click only, not focus. */
  activateOnFocus?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(nextValue) => onValueChange(nextValue as TValue)}
      className="settings-segmented-tabs gap-0"
    >
      <TabsList
        activateOnFocus={activateOnFocus}
        aria-label={ariaLabel}
        className="settings-segmented-list"
      >
        {items.map((item) => (
          <TabsTrigger
            key={item.value}
            value={item.value}
            disabled={disabled || item.disabled}
            className="settings-segmented-trigger"
          >
            {item.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
