import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ComposerPlusIcon } from "../homeChromeIcons.js";
import { Button } from "../components/ui/button.js";
import { ComposerCatalog, filterCatalog, type ComposerCatalogData } from "./ComposerCatalog.js";

export function ComposerCatalogTrigger({
    catalog,
    anchor,
    disabled,
    onClose,
}: {
    catalog: ComposerCatalogData;
    anchor?: HTMLElement | null;
    disabled?: boolean;
    onClose: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [index, setIndex] = useState(0);
    const trigger = useRef<HTMLButtonElement>(null);
    const panel = useRef<HTMLDivElement>(null);
    const id = useId();
    useEffect(() => {
        if (!open) return;
        const closeOutside = (event: PointerEvent) => {
            if (
                event.target instanceof Node &&
                !panel.current?.contains(event.target) &&
                !trigger.current?.contains(event.target)
            )
                setOpen(false);
        };
        document.addEventListener("pointerdown", closeOutside);
        return () => document.removeEventListener("pointerdown", closeOutside);
    }, [open]);
    useEffect(() => {
        if (disabled) setOpen(false);
    }, [disabled]);
    const rows = filterCatalog(catalog.entries, query);
    const selected = Math.min(index, Math.max(0, rows.length - 1));
    const close = () => {
        setOpen(false);
        onClose();
    };
    return (
        <>
            <Button
                ref={trigger}
                type="button"
                variant="ghost"
                size="icon-md"
                aria-label="添加功能与 Skills"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                disabled={disabled}
                onClick={() => {
                    setQuery("");
                    setIndex(0);
                    setOpen((value) => !value);
                    catalog.refresh();
                }}
            >
                <ComposerPlusIcon width={20} height={20} />
            </Button>
            {open &&
                anchor &&
                createPortal(
                    <div
                        ref={panel}
                        className="composer-catalog-position"
                        onKeyDown={(event) => {
                            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                            if (event.key === "Escape") {
                                event.preventDefault();
                                event.stopPropagation();
                                close();
                            }
                            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                                event.preventDefault();
                                if (rows.length)
                                    setIndex(
                                        (selected +
                                            rows.length +
                                            (event.key === "ArrowDown" ? 1 : -1)) %
                                            rows.length,
                                    );
                            }
                            if (event.key === "Enter") {
                                event.preventDefault();
                                if (rows[selected] && !rows[selected].disabled) {
                                    rows[selected].run();
                                    close();
                                }
                            }
                        }}
                    >
                        <ComposerCatalog
                            id={id}
                            catalog={catalog}
                            query={query}
                            index={selected}
                            anchor={anchor}
                            onQuery={setQuery}
                            onIndex={setIndex}
                            onChoose={(row) => {
                                row.run();
                                close();
                            }}
                        />
                    </div>,
                    anchor,
                )}
        </>
    );
}
