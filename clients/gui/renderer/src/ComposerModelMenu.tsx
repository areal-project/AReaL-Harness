import { useRef, useState } from "react";
import { useI18n } from "./i18n/IntlProvider.js";
import { MenuChevronIcon, MenuSelectedIcon } from "./interfaceIcons.js";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip.js";

const labels: Record<string, string> = {
    none: "无",
    minimal: "最少",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最高",
};
export interface ComposerModelOption {
    value: string;
    label: string;
    efforts?: readonly string[];
    reasoning?: boolean;
    unavailableReason?: string;
    historical?: boolean;
}
/** 可用性直接投影 Core 目录，不在 Renderer 重新判断凭据。 */
export function composerModelOption(model: {
    providerId?: string | null;
    modelId: string;
    displayName?: string;
    reasoningEffortOptions?: readonly string[];
    capabilities?: { reasoning: boolean };
    available?: boolean;
    credentialState?: string;
}): ComposerModelOption {
    return {
        value: model.providerId ? `${model.providerId}/${model.modelId}` : "",
        label: model.displayName ?? model.modelId,
        efforts: model.reasoningEffortOptions,
        reasoning: model.capabilities?.reasoning,
        unavailableReason: model.available === false
            ? model.credentialState === "unavailable" ? "缺少 API Key" : "模型不可用"
            : undefined,
    };
}
/** 模型/允许强度由目录和宿主提供，组件只负责两级选择。 */
export function ComposerModelMenu({
    options,
    value,
    disabled,
    pending = false,
    effort,
    onEffortChange,
    onChange,
    onClose,
}: {
    options: ComposerModelOption[];
    value: string;
    disabled?: boolean;
    pending?: boolean;
    effort?: string;
    onEffortChange?: (value: string) => void | Promise<void>;
    onChange: (value: string) => void;
    onClose: () => void;
}) {
    const { t } = useI18n();
    const unspecified = t("chat.composer.effortUnspecified");
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState<"effort" | "models">("effort");
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const [sliderFocused, setSliderFocused] = useState(false);
    const [pointerIndex, setPointerIndex] = useState<number | null>(null);
    const pointerActive = useRef(false);
    const availableOptions = options.filter((option) => !option.unavailableReason && !option.historical);
    const model = options.find((option) => option.value === value);
    const label = model?.label ?? "请选择模型";
    const reasoning = !!model && model.reasoning !== false;
    const efforts = model?.efforts ?? [];
    const selectedEffort = effort && (!model?.efforts || efforts.includes(effort)) ? effort : undefined;
    const index = selectedEffort ? efforts.indexOf(selectedEffort) : -1;
    const sliderIndex = pointerIndex ?? index;
    const commitEffort = async (next: number) => {
        if (disabled || pending || !onEffortChange) return;
        // 保存期间保持预览位置，不能先退回旧配置再跳到新配置。
        setPointerIndex(next);
        try { await onEffortChange(efforts[next]); }
        finally { setPointerIndex(null); }
    };
    const feedbackIndex = Math.min(hoveredIndex ?? (sliderFocused ? index : -1), efforts.length - 1);
    const effortLabel = selectedEffort ? labels[selectedEffort] ?? selectedEffort : unspecified;
    const modelLabel = `${label}${reasoning ? ` ${effortLabel}` : ""}`;
    const emptyGuidance = `${model ? `${modelLabel}. ` : ""}${t("chat.composer.noModelsGuidance")}`;
    // Native range thumbs travel between half-thumb insets, including both endpoints.
    const sliderPosition = (step: number) => {
        const fraction = Math.max(0, step) / Math.max(1, efforts.length - 1);
        return `calc(${fraction * 100}% + ${14 - fraction * 28}px)`;
    };
    if (!availableOptions.length && (!model || model.unavailableReason)) return (
        <span
            className="composer-model-trigger composer-model-empty text-foreground-subtle text-ui-sm"
            title={emptyGuidance}
            aria-label={emptyGuidance}
        >
            {t("chat.composer.noModels")}
        </span>
    );
    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                setHoveredIndex(null);
                setSliderFocused(false);
                setPointerIndex(null);
                pointerActive.current = false;
                if (next) setPage(model && !model.unavailableReason && model.reasoning !== false ? "effort" : "models");
            }}
        >
            <PopoverTrigger
                render={
                    <Button
                        type="button"
                        variant="ghost"
                        aria-label="模型"
                        title={label}
                        disabled={disabled}
                        aria-busy={pending || undefined}
                        className="composer-model-trigger"
                    />
                }
            >
                <span>{modelLabel}</span>
                <MenuChevronIcon size={14} aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent
                aria-label={page === "effort" && reasoning ? "模型与思考强度" : "选择模型"}
                side="top"
                align="end"
                sideOffset={8}
                className={page === "effort" ? "composer-effort-menu" : "composer-model-menu"}
                finalFocus={() => {
                    onClose();
                    return false;
                }}
            >
                {page === "effort" ? (
                    <>
                        <div className="composer-effort-center">
                            {reasoning && <strong>
                                {effortLabel}
                            </strong>}
                            <button
                                type="button"
                                aria-label="选择模型"
                                aria-disabled={pending || undefined}
                                onClick={() => { if (!pending) setPage("models"); }}
                            >
                                {label} ›
                            </button>
                        </div>
                        {reasoning && efforts.length > 0 && onEffortChange ? (
                            <div className="composer-slider-shell" role="group" aria-label={t("chat.composer.chooseEffort")}>
                                <div className="composer-slider-track" aria-hidden="true">
                                    {sliderIndex >= 0 && <div style={{ width: sliderPosition(sliderIndex) }} />}
                                    {efforts.map((item, i) => (
                                        <i key={item} data-selected={sliderIndex >= i} style={{ left: sliderPosition(i) }} />
                                    ))}
                                </div>
                                {index >= 0 ? (
                                    <Tooltip open={feedbackIndex >= 0}>
                                        <TooltipTrigger render={<input
                                            type="range"
                                            disabled={disabled}
                                            aria-disabled={pending || undefined}
                                            onKeyDown={(event) => {
                                                if (pending && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)) event.preventDefault();
                                            }}
                                            aria-label="思考强度"
                                            aria-valuetext={labels[efforts[sliderIndex]] ?? efforts[sliderIndex]}
                                            min={0}
                                            max={efforts.length - 1}
                                            step={1}
                                            value={sliderIndex}
                                            onFocus={() => setSliderFocused(true)}
                                            onBlur={() => { setSliderFocused(false); setHoveredIndex(null); setPointerIndex(null); pointerActive.current = false; }}
                                            onPointerDown={(event) => {
                                                if (pending) { event.preventDefault(); return; }
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
                                            onPointerCancel={() => { pointerActive.current = false; setPointerIndex(null); setHoveredIndex(null); }}
                                            onLostPointerCapture={() => {
                                                if (pointerActive.current) { pointerActive.current = false; setPointerIndex(null); }
                                            }}
                                            onPointerMove={(event) => {
                                                const bounds = event.currentTarget.getBoundingClientRect();
                                                const fraction = (event.clientX - bounds.left - 14) / Math.max(1, bounds.width - 28);
                                                setHoveredIndex(Math.round(Math.max(0, Math.min(1, fraction)) * (efforts.length - 1)));
                                            }}
                                            onPointerLeave={() => setHoveredIndex(null)}
                                            onChange={(event) => {
                                                if (pending) return;
                                                const next = Number(event.target.value);
                                                setHoveredIndex(next);
                                                if (pointerActive.current) setPointerIndex(next);
                                                else void commitEffort(next);
                                            }}
                                        />} />
                                        <TooltipContent role="tooltip" sideOffset={8}>{labels[efforts[feedbackIndex]] ?? efforts[feedbackIndex]}</TooltipContent>
                                    </Tooltip>
                                ) : efforts.map((item, i) => (
                                    <Tooltip key={item}>
                                        <TooltipTrigger render={<Button
                                            type="button"
                                            disabled={disabled || pending}
                                            variant="ghost"
                                            size="icon"
                                            className="composer-slider-option"
                                            style={{ left: sliderPosition(i) }}
                                            aria-label={labels[item] ?? item}
                                            aria-pressed={false}
                                            onClick={() => { void commitEffort(i); }}
                                        />} />
                                        <TooltipContent role="tooltip" sideOffset={8}>{labels[item] ?? item}</TooltipContent>
                                    </Tooltip>
                                ))}
                            </div>
                        ) : reasoning ? (
                            <p className="composer-effort-unavailable">此模型未提供可选强度</p>
                        ) : null}
                    </>
                ) : (
                    <>
                        <div className="composer-model-heading">
                            {reasoning && <button
                                type="button"
                                aria-label="返回思考强度"
                                onClick={() => setPage("effort")}
                            >
                                ‹
                            </button>}
                            选择模型
                        </div>
                        <div role="radiogroup" aria-label="模型列表">
                            {availableOptions.map((option) => (
                                <button
                                    type="button"
                                    role="radio"
                                    aria-checked={value === option.value}
                                    key={option.value}
                                    data-model-value={option.value}
                                    disabled={disabled || pending}
                                    onClick={() => {
                                        onChange(option.value);
                                        if (option.reasoning === false) setOpen(false);
                                        else setPage("effort");
                                    }}
                                >
                                    <span>{option.label}</span>
                                    {value === option.value && <MenuSelectedIcon size={16} />}
                                </button>
                            ))}
                        </div>
                        {!availableOptions.length && <p className="composer-effort-unavailable">{t("chat.composer.noModelsGuidance")}</p>}
                    </>
                )}
            </PopoverContent>
        </Popover>
    );
}
