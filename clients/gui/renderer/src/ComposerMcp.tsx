import { useEffect, useState } from "react";
import { Popover, PopoverContent } from "./components/ui/popover.js";
import type { Action, Data } from "./services.js";

/** Composer 内只读当前连接，不新增或修改 MCP 配置。 */
export function ComposerMcp({
    projectId,
    action,
    open,
    onClose,
    anchor,
}: {
    projectId: string;
    action: Action;
    open: boolean;
    onClose: () => void;
    anchor: HTMLElement | null;
}) {
    const [rows, setRows] = useState<Data[]>([]);
    const [error, setError] = useState("");
    useEffect(() => {
        if (!open) return;
        let active = true;
        setError("");
        void action("manage", { projectId, operation: "mcp" })
            .then((result) => {
                if (active) setRows(result.data ?? []);
            })
            .catch((cause) => {
                if (active) setError(cause.message);
            });
        return () => {
            active = false;
        };
    }, [open, projectId]);
    return (
        <Popover
            open={open}
            onOpenChange={(value) => {
                if (!value) onClose();
            }}
        >
            <PopoverContent
                anchor={anchor}
                side="top"
                aria-label="MCP 连接"
                finalFocus={() => {
                    onClose();
                    return false;
                }}
            >
                <strong>MCP</strong>
                {error ? (
                    <p role="alert">{error}</p>
                ) : rows.length ? (
                    rows.map((row) => (
                        <div key={row.id} className="flex justify-between gap-3 py-2">
                            <span>{row.id}</span>
                            <small>{row.state ?? row.status ?? "未连接"}</small>
                        </div>
                    ))
                ) : (
                    <p>没有已配置的服务器</p>
                )}
            </PopoverContent>
        </Popover>
    );
}
