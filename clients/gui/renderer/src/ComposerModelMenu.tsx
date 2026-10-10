import { useState } from "react";
import { MenuChevronIcon, MenuSelectedIcon } from "./interfaceIcons.js";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";

const labels: Record<string, string> = {
    none: "无",
    minimal: "最少",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
};
export interface ComposerModelOption {
    value: string;
    label: string;
    efforts?: readonly string[];
    unavailableReason?: string;
}
/** 可用性直接投影 Core 目录，不在 Renderer 重新判断凭据。 */
export function composerModelOption(model: {
    providerId: string;
    modelId: string;
    displayName?: string;
    reasoningEffortOptions?: readonly string[];
    available?: boolean;
    credentialState?: string;
}): ComposerModelOption {
    return {
        value: `${model.providerId}/${model.modelId}`,
        label: model.displayName ?? model.modelId,
        efforts: model.reasoningEffortOptions,
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
    effort,
    onEffortChange,
    onChange,
    onClose,
    onConfigure,
}: {
    options: ComposerModelOption[];
    value: string;
    disabled?: boolean;
    effort?: string;
    onEffortChange?: (value: string) => void;
    onChange: (value: string) => void;
    onClose: () => void;
    onConfigure: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState<"effort" | "models">("effort");
    const model = options.find((option) => option.value === value);
    const label = model?.label ?? "请选择模型";
    const efforts = model?.efforts ?? [];
    const index = effort ? efforts.indexOf(effort) : -1;
    if (!options.length) return (
        <Button type="button" variant="ghost" aria-label="模型" disabled={disabled}
            className="composer-model-trigger" onClick={onConfigure}>
            请先配置模型 <MenuChevronIcon size={14} aria-hidden="true" />
        </Button>
    );
    return (
        <Popover
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) setPage(model && !model.unavailableReason ? "effort" : "models");
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
                        className="composer-model-trigger"
                    />
                }
            >
                <span>
                    {label}
                    {effort ? ` ${labels[effort] ?? effort}` : ""}
                </span>
                <MenuChevronIcon size={14} aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent
                aria-label={page === "effort" ? "模型与思考强度" : "选择模型"}
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
                            <strong>
                                {index >= 0
                                    ? (labels[effort!] ?? effort)
                                    : efforts.length
                                      ? "默认强度"
                                      : "默认"}
                            </strong>
                            <button
                                type="button"
                                aria-label="选择模型"
                                onClick={() => setPage("models")}
                            >
                                {label} ›
                            </button>
                        </div>
                        {efforts.length && onEffortChange ? (
                            <div className="composer-slider-shell">
                                <div className="composer-slider-track">
                                    <div
                                        style={{
                                            width:
                                                index < 0
                                                    ? "0%"
                                                    : `${((index + 0.5) / efforts.length) * 100}%`,
                                        }}
                                    />
                                    {efforts.map((item, i) => (
                                        <i
                                            key={item}
                                            style={{
                                                left: `${((i + 0.5) / efforts.length) * 100}%`,
                                            }}
                                        />
                                    ))}
                                </div>
                                <input
                                    type="range"
                                    aria-label="思考强度"
                                    aria-valuetext={
                                        index >= 0 ? (labels[effort!] ?? effort) : "默认强度"
                                    }
                                    min={0}
                                    max={efforts.length - 1}
                                    step={1}
                                    value={Math.max(0, index)}
                                    onChange={(event) =>
                                        onEffortChange(efforts[Number(event.target.value)])
                                    }
                                />
                            </div>
                        ) : (
                            <p className="composer-effort-unavailable">此模型未提供可选强度</p>
                        )}
                    </>
                ) : (
                    <>
                        <div className="composer-model-heading">
                            <button
                                type="button"
                                aria-label="返回思考强度"
                                onClick={() => setPage("effort")}
                            >
                                ‹
                            </button>
                            选择模型
                        </div>
                        <div role="radiogroup" aria-label="模型列表">
                            {options.map((option) => (
                                <button
                                    type="button"
                                    role="radio"
                                    aria-checked={value === option.value}
                                    key={option.value}
                                    data-model-value={option.value}
                                    disabled={!!option.unavailableReason}
                                    onClick={() => {
                                        onChange(option.value);
                                        setPage("effort");
                                    }}
                                >
                                    <span>{option.label}{option.unavailableReason && <small>{option.unavailableReason}</small>}</span>
                                    {value === option.value && <MenuSelectedIcon size={16} />}
                                </button>
                            ))}
                        </div>
                    </>
                )}
                <Button type="button" variant="ghost" className="composer-model-configure"
                    onClick={() => { setOpen(false); onConfigure(); }}>
                    配置模型
                </Button>
            </PopoverContent>
        </Popover>
    );
}
