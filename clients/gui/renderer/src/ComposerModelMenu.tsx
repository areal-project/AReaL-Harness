import { Input } from "@areal/ui";
import { Zap } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useI18n } from "./i18n/IntlProvider.js";
import { MenuChevronIcon, MenuSelectedIcon } from "./interfaceIcons.js";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.js";

const effortMessages = {
  none: "chat.composer.effort.none",
  minimal: "chat.composer.effort.minimal",
  low: "chat.composer.effort.low",
  medium: "chat.composer.effort.medium",
  high: "chat.composer.effort.high",
  xhigh: "chat.composer.effort.xhigh",
  max: "chat.composer.effort.max",
} as const;
const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export interface ComposerModelOption {
  value: string;
  label: string;
  providerId?: string;
  providerName?: string;
  efforts?: readonly string[];
  reasoning?: boolean;
  effortsKnown?: boolean;
  unavailableReason?: string;
  historical?: boolean;
}
/** 可用性直接投影 Core 目录，不在 Renderer 重新判断凭据。 */
export function composerModelOption(model: {
  providerId?: string | null;
  providerName?: string;
  modelId: string;
  displayName?: string;
  reasoningEffortOptions?: readonly string[];
  capabilities?: { reasoning: boolean; reasoningEffortOptions?: readonly string[] };
  available?: boolean;
  availability?: "checking" | "available" | "unavailable";
  credentialState?: string;
}): ComposerModelOption {
  return {
    value: model.providerId ? `${model.providerId}/${model.modelId}` : "",
    label: model.displayName ?? model.modelId,
    providerId: model.providerId ?? undefined,
    providerName: model.providerName,
    efforts: model.reasoningEffortOptions,
    reasoning: model.capabilities?.reasoning,
    effortsKnown:
      model.capabilities?.reasoningEffortOptions !== undefined ||
      !!model.reasoningEffortOptions?.length,
    unavailableReason:
      model.availability === "unavailable" ||
      (model.available === false && model.availability !== "checking")
        ? model.credentialState === "unavailable"
          ? "缺少 API Key"
          : "模型不可用"
        : undefined,
  };
}
export function ComposerModelMenu({
  options,
  value,
  disabled,
  pending = false,
  effort,
  serviceTier,
  onServiceTierChange,
  onEffortChange,
  onChange,
  onClose,
}: {
  options: ComposerModelOption[];
  value: string;
  disabled?: boolean;
  pending?: boolean;
  effort?: string;
  serviceTier?: string;
  onServiceTierChange?: (value: "fast" | "default") => void | Promise<void>;
  onEffortChange?: (value: string) => void | Promise<void>;
  onChange: (value: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const unspecified = t("chat.composer.effortUnspecified");
  const [modelOpen, setModelOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [provider, setProvider] = useState("");
  const radioName = useId();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [sliderFocused, setSliderFocused] = useState(false);
  const [pointerIndex, setPointerIndex] = useState<number | null>(null);
  const pointerActive = useRef(false);
  const availableOptions = options.filter(
    (option) => !option.unavailableReason && !option.historical,
  );
  const providers = new Map<string, ComposerModelOption[]>();
  for (const option of availableOptions) {
    const providerId = option.providerId ?? "";
    const group = providers.get(providerId) ?? [];
    group.push(option);
    providers.set(providerId, group);
  }
  const model = options.find((option) => option.value === value);
  const label = model?.label ?? t("chat.composer.chooseModel");
  const identityLabel = model?.providerId
    ? `${label} · ${model.providerName || model.providerId}`
    : label;
  const fast = serviceTier === "fast";
  const fastAction = t(fast ? "chat.composer.disableFast" : "chat.composer.enableFast");
  const selectedEffort = effort && effort !== "default" ? effort : undefined;
  const index = efforts.findIndex((item) => item === selectedEffort);
  const sliderIndex = pointerIndex ?? index;
  const effortName = (item: string) => {
    const known = efforts.find((known) => known === item);
    return known ? t(effortMessages[known]) : item;
  };
  const activeProvider = providers.has(provider) ? provider : (providers.keys().next().value ?? "");
  const commitEffort = async (next: number) => {
    if (disabled || pending || !onEffortChange) return;
    // 保存期间保持预览位置，不能先退回旧配置再跳到新配置。
    setPointerIndex(next);
    try {
      await onEffortChange(efforts[next]);
    } finally {
      setPointerIndex(null);
    }
  };
  const feedbackIndex = Math.min(
    hoveredIndex ?? (sliderFocused ? sliderIndex : -1),
    efforts.length - 1,
  );
  const effortLabel =
    effort === "default"
      ? t("chat.composer.serviceDefault")
      : selectedEffort
        ? effortName(selectedEffort)
        : unspecified;
  const modelLabel = identityLabel;
  const emptyGuidance = `${model ? `${modelLabel}. ` : ""}${t("chat.composer.noModelsGuidance")}`;
  // 原生滑块拇指在半径内缩的两个端点之间移动。
  const sliderPosition = (step: number) => {
    const fraction = Math.max(0, step) / Math.max(1, efforts.length - 1);
    return `calc(${fraction * 100}% + ${14 - fraction * 28}px)`;
  };
  if (!availableOptions.length && !model)
    return (
      <span
        className="composer-model-trigger composer-model-empty text-foreground-subtle text-ui-sm"
        title={emptyGuidance}
        aria-label={emptyGuidance}
      >
        {t("chat.composer.noModels")}
      </span>
    );
  return (
    <div className="composer-model-controls">
      <Popover
        open={modelOpen}
        onOpenChange={(next) => {
          setModelOpen(next);
          if (next) {
            setEffortOpen(false);
            setProvider(
              providers.has(model?.providerId ?? "")
                ? (model?.providerId ?? "")
                : (providers.keys().next().value ?? ""),
            );
          }
        }}
      >
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              aria-label={t("chat.composer.chooseModel")}
              title={modelLabel}
              disabled={disabled || pending}
              aria-busy={pending || undefined}
              className="composer-model-trigger"
              data-testid="composer-model-trigger"
            />
          }
        >
          <span className="composer-model-name">{label}</span>
          {model?.unavailableReason && (
            <span
              className="text-destructive"
              title={model.unavailableReason}
              aria-label={model.unavailableReason}
            >
              !
            </span>
          )}
          <MenuChevronIcon size={14} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent
          aria-label={t("chat.composer.chooseModel")}
          side="top"
          align="end"
          sideOffset={8}
          className="composer-model-menu"
          finalFocus={() => {
            if (!effortOpen) onClose();
            return false;
          }}
        >
          {providers.size ? (
            <Tabs
              orientation="vertical"
              value={activeProvider}
              onValueChange={(next) => setProvider(String(next))}
              className="composer-model-browser"
            >
              <TabsList
                aria-label={t("chat.composer.providers")}
                className="composer-provider-list"
              >
                {[...providers].map(([providerId, models]) => (
                  <TabsTrigger
                    key={providerId}
                    value={providerId}
                    disabled={disabled || pending}
                    className="composer-provider-option"
                  >
                    {models[0]?.providerName || providerId || t("chat.composer.serviceDefault")}
                  </TabsTrigger>
                ))}
              </TabsList>
              {[...providers].map(([providerId, models]) => (
                <TabsContent key={providerId} value={providerId} className="composer-model-list">
                  <div role="radiogroup" aria-label={t("chat.composer.models")}>
                    {models.map((option) => (
                      <label
                        className="composer-model-option"
                        key={option.value}
                        data-model-value={option.value}
                      >
                        <Input
                          unstyled
                          data-slot={undefined}
                          type="radio"
                          name={radioName}
                          value={option.value}
                          checked={value === option.value}
                          disabled={disabled || pending}
                          onClick={() => {
                            if (option.value === value) {
                              onChange(option.value);
                              setModelOpen(false);
                            }
                          }}
                          onChange={() => {
                            onChange(option.value);
                            setModelOpen(false);
                          }}
                        />
                        <span className="composer-model-option-text">{option.label}</span>
                        {value === option.value && (
                          <MenuSelectedIcon size={16} aria-hidden="true" />
                        )}
                      </label>
                    ))}
                  </div>
                </TabsContent>
              ))}
            </Tabs>
          ) : (
            <p className="composer-effort-unavailable">{t("chat.composer.noModelsGuidance")}</p>
          )}
        </PopoverContent>
      </Popover>
      {model && onEffortChange && (
        <Popover
          open={effortOpen}
          onOpenChange={(next) => {
            setEffortOpen(next);
            setHoveredIndex(null);
            setSliderFocused(false);
            setPointerIndex(null);
            pointerActive.current = false;
            if (next) setModelOpen(false);
          }}
        >
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                aria-label={t("chat.composer.chooseEffort")}
                title={fast ? `Fast · ${effortLabel}` : effortLabel}
                disabled={disabled || pending}
                aria-busy={pending || undefined}
                className="composer-model-trigger composer-effort-trigger"
              />
            }
          >
            {fast && <Zap size={14} className="composer-fast-indicator" aria-hidden="true" />}
            <span>{fast ? `Fast · ${effortLabel}` : effortLabel}</span>
            <MenuChevronIcon size={14} aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent
            aria-label={t("chat.composer.chooseEffort")}
            side="top"
            align="end"
            sideOffset={8}
            className="composer-effort-menu"
            finalFocus={() => {
              if (!modelOpen) onClose();
              return false;
            }}
          >
            {onServiceTierChange && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="composer-fast-toggle"
                      aria-label={fastAction}
                      aria-pressed={fast}
                      aria-disabled={pending || undefined}
                      disabled={disabled}
                      onClick={() => {
                        if (!pending) void onServiceTierChange(fast ? "default" : "fast");
                      }}
                    />
                  }
                >
                  <Zap size={16} aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent role="tooltip" sideOffset={8}>
                  {fastAction}
                </TooltipContent>
              </Tooltip>
            )}
            <div
              className="composer-effort-center"
              data-fast-toggle={onServiceTierChange ? "true" : undefined}
            >
              <strong>{effortLabel}</strong>
              <div className="composer-model-source">{identityLabel}</div>
            </div>
            <div
              className="composer-slider-shell"
              role="group"
              aria-label={t("chat.composer.chooseEffort")}
            >
              <div className="composer-slider-track" aria-hidden="true">
                {sliderIndex >= 0 && <div style={{ width: sliderPosition(sliderIndex) }} />}
                {efforts.map((item, i) => (
                  <i
                    key={item}
                    data-selected={sliderIndex >= i}
                    style={{ left: sliderPosition(i) }}
                  />
                ))}
              </div>
              {index >= 0 ? (
                <Tooltip open={feedbackIndex >= 0}>
                  <TooltipTrigger
                    render={
                      <Input
                        unstyled
                        data-slot={undefined}
                        type="range"
                        disabled={disabled}
                        aria-disabled={pending || undefined}
                        onKeyDown={(event) => {
                          if (
                            pending &&
                            [
                              "ArrowLeft",
                              "ArrowRight",
                              "ArrowUp",
                              "ArrowDown",
                              "Home",
                              "End",
                              "PageUp",
                              "PageDown",
                            ].includes(event.key)
                          )
                            event.preventDefault();
                        }}
                        aria-label={t("chat.composer.chooseEffort")}
                        aria-valuetext={effortName(efforts[sliderIndex])}
                        min={0}
                        max={efforts.length - 1}
                        step={1}
                        value={sliderIndex}
                        onFocus={() => setSliderFocused(true)}
                        onBlur={() => {
                          setSliderFocused(false);
                          setHoveredIndex(null);
                          setPointerIndex(null);
                          pointerActive.current = false;
                        }}
                        onPointerDown={(event) => {
                          if (pending) {
                            event.preventDefault();
                            return;
                          }
                          pointerActive.current = true;
                          setPointerIndex(index);
                          event.currentTarget.setPointerCapture(event.pointerId);
                        }}
                        onPointerUp={(event) => {
                          if (!pointerActive.current) return;
                          pointerActive.current = false;
                          const next = Number(event.currentTarget.value);
                          if (next !== index) void commitEffort(next);
                          else setPointerIndex(null);
                        }}
                        onPointerCancel={() => {
                          pointerActive.current = false;
                          setPointerIndex(null);
                          setHoveredIndex(null);
                        }}
                        onLostPointerCapture={() => {
                          if (pointerActive.current) {
                            pointerActive.current = false;
                            setPointerIndex(null);
                          }
                        }}
                        onPointerMove={(event) => {
                          const bounds = event.currentTarget.getBoundingClientRect();
                          const fraction =
                            (event.clientX - bounds.left - 14) / Math.max(1, bounds.width - 28);
                          setHoveredIndex(
                            Math.round(Math.max(0, Math.min(1, fraction)) * (efforts.length - 1)),
                          );
                        }}
                        onPointerLeave={() => setHoveredIndex(null)}
                        onChange={(event) => {
                          if (pending) return;
                          const next = Number(event.target.value);
                          setHoveredIndex(next);
                          if (pointerActive.current) setPointerIndex(next);
                          else void commitEffort(next);
                        }}
                      />
                    }
                  />
                  <TooltipContent role="tooltip" sideOffset={8}>
                    {effortName(efforts[feedbackIndex])}
                  </TooltipContent>
                </Tooltip>
              ) : (
                efforts.map((item, i) => (
                  <Tooltip key={item}>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          disabled={disabled || pending}
                          variant="ghost"
                          size="icon"
                          className="composer-slider-option"
                          style={{ left: sliderPosition(i) }}
                          aria-label={effortName(item)}
                          aria-pressed={false}
                          onClick={() => {
                            void commitEffort(i);
                          }}
                        />
                      }
                    />
                    <TooltipContent role="tooltip" sideOffset={8}>
                      {effortName(item)}
                    </TooltipContent>
                  </Tooltip>
                ))
              )}
            </div>
            <Button
              type="button"
              variant="ghost"
              disabled={disabled || pending}
              aria-pressed={effort === "default"}
              onClick={() => void onEffortChange("default")}
            >
              {t("chat.composer.serviceDefault")}
            </Button>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
