import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import { z } from "zod";
import { GEN_UI_STATE_METHOD, GEN_UI_FOLLOW_UP_METHOD, GEN_UI_PRESENTATION_METHOD, genUiWidgetStateSchema, genUiFollowUpSchema } from "@areal/gen-ui/contract";
import { AppTransport, type McpAppPlacement } from "./McpAppHost.js";
import { genUiSourceKey, type GenUiDescriptor, type GenUiSource } from "./mcp-app-services.js";
import type { PlatformServices } from "./services.js";
import { Textarea } from "./components/ui/textarea.js";
import { Button } from "./components/ui/button.js";
import { useI18n } from "./i18n/IntlProvider.js";

type Binding = { element: HTMLDivElement; send?: (prompt: string) => Promise<void>; dark: boolean };
type Confirmation = { prompt: string; resolve: () => void; reject: (error: Error) => void };
type Entry = { source: GenUiSource; title: string; phase: "idle" | "opening" | "open" | "closed" | "error"; app?: GenUiDescriptor; binding?: Binding; placement: McpAppPlacement | null; clip?: string; height: number; error?: string; pending?: Confirmation; sending?: boolean };
type Owner = {
    services: PlatformServices; entries: Map<string, Entry>; changed(): void;
    acquire(entry: Entry): Promise<void>; close(entry: Entry): void;
    visible(entry: Entry): boolean; confirm(entry: Entry, prompt: string): Promise<void>;
};
const Context = createContext<{ owner: Owner; revision: number } | null>(null);
function currentEntry(owner: Owner, entry: Entry) {
    if (owner.entries.get(genUiSourceKey(entry.source)) !== entry || !entry.binding?.element.isConnected || !entry.placement) throw Error("Generated answer is no longer visible");
}
export function GenUiWorkspace({ services, children }: { services: PlatformServices; children: ReactNode }) {
    const [revision, changed] = useState(0);
    const owner = useMemo<Owner>(() => ({
        services, entries: new Map(), changed: () => changed(value => value + 1),
        visible: entry => !!entry.binding?.element.isConnected && !!entry.placement,
        async acquire(entry) {
            if (!services.mcpApp || entry.phase === "opening" || entry.app) return;
            entry.phase = "opening"; entry.error = undefined; this.changed();
            try {
                const app = await services.mcpApp({ operation: "openGenUi", ...entry.source });
                if (this.entries.get(genUiSourceKey(entry.source)) !== entry) { await services.mcpApp({ operation: "close", token: app.token }); return; }
                entry.app = app; entry.phase = "open";
                await services.mcpApp({ operation: "genUiVisibility", token: app.token, visible: this.visible(entry) });
            } catch { entry.phase = "error"; entry.error = "unavailable"; }
            this.changed();
        },
        close(entry) {
            entry.pending?.reject(Error("Generated answer closed")); entry.pending = undefined;
            if (entry.app) void services.mcpApp?.({ operation: "close", token: entry.app.token }).catch(() => {});
            entry.app = undefined; entry.phase = "closed"; this.changed();
        },
        async confirm(entry, prompt) {
            currentEntry(this, entry);
            if (!entry.binding?.send || entry.app?.readOnly || entry.pending || entry.sending) throw Error("Conversation cannot submit this request");
            await new Promise<void>((resolve, reject) => { entry.pending = { prompt, resolve, reject }; this.changed(); });
        },
    }), [services]);
    useEffect(() => () => { for (const entry of owner.entries.values()) owner.close(entry); owner.entries.clear(); }, [owner]);
    return <Context.Provider value={{ owner, revision }}>{children}{[...owner.entries].map(([key, entry]) => entry.app && <GenUiHost key={entry.app.token} owner={owner} entry={entry} />)}</Context.Provider>;
}
function GenUiHost({ owner, entry }: { owner: Owner; entry: Entry }) {
    const frame = useRef<HTMLIFrameElement>(null), bridgeRef = useRef<AppBridge | null>(null);
    const app = entry.app!;
    useEffect(() => {
        const target = frame.current?.contentWindow, command = owner.services.mcpApp;
        if (!target || !command) return;
        let active = true, sequence = 0;
        const transport = new AppTransport(target, target); transport.boundedRequests = true;
        const bridge = new AppBridge(null, { name: "AReaL Gen UI", version: "1" }, { experimental: { "zcode/gen-ui": {} }, sandbox: { permissions: {} } }, { hostContext: { ...app.hostContext, theme: entry.binding?.dark ? "dark" : "light" } });
        bridgeRef.current = bridge;
        const current = () => { if (!active || entry.app !== app) throw Error("Generated page is stale"); currentEntry(owner, entry); };
        const request = async (method: string, params: Record<string, unknown>) => {
            current();
            const reply = await command({ operation: "request", token: app.token, request: { jsonrpc: "2.0", id: ++sequence, method, params } });
            current(); if (reply.error) throw Error("Generated request failed"); return reply.result ?? {};
        };
        bridge.setRequestHandler(GEN_UI_STATE_METHOD, { params: z.object({ state: genUiWidgetStateSchema }).strict() }, async params => request(GEN_UI_STATE_METHOD, params));
        bridge.setRequestHandler(GEN_UI_FOLLOW_UP_METHOD, { params: genUiFollowUpSchema }, async params => {
            await request(GEN_UI_FOLLOW_UP_METHOD, params);
            await owner.confirm(entry, params.prompt);
            return {};
        });
        bridge.setRequestHandler(GEN_UI_PRESENTATION_METHOD, { params: z.object({ hovered: z.boolean().optional(), escape: z.literal(true).optional() }).strict() }, async params => {
            await request(GEN_UI_PRESENTATION_METHOD, params);
            if (params.escape && entry.pending) { entry.pending.reject(Error("Cancelled")); entry.pending = undefined; owner.changed(); }
            return {};
        });
        bridge.onsandboxready = () => { void bridge.sendSandboxResourceReady({ html: "" }); };
        bridge.onsizechange = ({ height }) => {
            if (active && Number.isFinite(height)) { entry.height = Math.max(120, Math.min(10000, Math.ceil(height!))); owner.changed(); }
        };
        bridge.onerror = () => { if (active) { entry.error = "unavailable"; owner.changed(); } };
        const off = owner.services.onMcpAppEvent?.(event => {
            if (!active || event.token !== app.token || !("method" in event.notification)) return;
            if (event.notification.method === "ui/notifications/closed") {
                entry.pending?.reject(Error("Generated answer closed")); entry.pending = undefined;
                entry.app = undefined; entry.phase = "closed"; owner.changed();
            } else if (transport.initialized) {
                if (event.notification.method === "ui/notifications/host-context-changed") Object.assign(app.hostContext, event.notification.params);
                void transport.send(event.notification);
            }
        });
        void bridge.connect(transport).then(() => { if (active && frame.current) frame.current.src = app.frameUrl; }).catch(() => { entry.error = "unavailable"; owner.changed(); });
        return () => { active = false; off?.(); bridgeRef.current = null; void bridge.close(); };
    }, [app.token, owner]);
    useEffect(() => { bridgeRef.current?.setHostContext({ ...app.hostContext, theme: entry.binding?.dark ? "dark" : "light" }); }, [entry.binding?.dark, app.hostContext]);
    return <div aria-hidden={!entry.placement} inert={!entry.placement} data-gen-ui-token={app.token} data-gen-ui-thread={app.threadId}
        style={{ position: "fixed", ...entry.placement, display: entry.placement ? "block" : "none", zIndex: 10, clipPath: entry.clip }}>
        <iframe ref={frame} title={entry.title} sandbox="allow-scripts allow-same-origin" referrerPolicy="no-referrer" style={{ border: 0, width: "100%", height: "100%", display: "block" }} />
    </div>;
}
export function GenUiCard({ source, title, send, dark }: { source: GenUiSource; title: string; send?: (prompt: string) => Promise<void>; dark: boolean }) {
    const context = useContext(Context), slot = useRef<HTMLDivElement>(null), { t } = useI18n();
    const key = genUiSourceKey(source), owner = context?.owner;
    const binding = useRef({ send, dark }); binding.current = { send, dark };
    const entry = owner?.entries.get(key);
    useLayoutEffect(() => {
        if (!owner || !slot.current) return;
        let entry = owner.entries.get(key);
        if (!entry) { entry = { source, title, phase: "idle", placement: null, height: 320 }; owner.entries.set(key, entry); }
        const current = entry;
        current.binding = { element: slot.current, ...binding.current };
        const measure = () => {
            if (!current.binding) return;
            const element = current.binding.element, rect = element.getBoundingClientRect();
            let top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom), left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
            let shown = element.isConnected && getComputedStyle(element).visibility !== "hidden";
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
                const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
                if (style.display === "none" || parent.hidden || parent.inert) shown = false;
                if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
                if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
            }
            const placement = shown && bottom > top && right > left ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
            const visibilityChanged = !!placement !== !!current.placement;
            const clip = `inset(${Math.max(0, top - rect.top)}px ${Math.max(0, rect.right - right)}px ${Math.max(0, rect.bottom - bottom)}px ${Math.max(0, left - rect.left)}px)`;
            if (JSON.stringify(placement) !== JSON.stringify(current.placement) || clip !== current.clip) { current.placement = placement; current.clip = clip; owner.changed(); }
            if (!placement && current.pending) { current.pending.reject(Error("Generated answer hidden")); current.pending = undefined; owner.changed(); }
            if (visibilityChanged && current.app) void owner.services.mcpApp?.({ operation: "genUiVisibility", token: current.app.token, visible: !!placement }).catch(() => {});
            if (placement && current.phase === "idle") void owner.acquire(current);
        };
        const resize = new ResizeObserver(measure); for (let element: HTMLElement | null = slot.current; element; element = element.parentElement) resize.observe(element);
        const intersection = new IntersectionObserver(measure); intersection.observe(slot.current);
        window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true); measure(); owner.changed();
        return () => {
            resize.disconnect(); intersection.disconnect(); window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true);
            current.pending?.reject(Error("Generated answer detached")); current.pending = undefined; current.binding = undefined; current.placement = null;
            if (current.app) void owner.services.mcpApp?.({ operation: "genUiVisibility", token: current.app.token, visible: false }).catch(() => {});
            else if (current.phase !== "opening") owner.entries.delete(key);
            owner.changed();
        };
    }, [owner, key]);
    useLayoutEffect(() => {
        if (entry?.binding) {
            const themeChanged = entry.binding.dark !== dark;
            entry.binding.send = send; entry.binding.dark = dark;
            if (themeChanged) owner?.changed();
        }
    }, [owner, entry, send, dark]);
    const confirm = useCallback(async () => {
        if (!owner || !entry?.pending || entry.sending) return;
        const pending = entry.pending;
        try {
            currentEntry(owner, entry); const submit = entry.binding?.send;
            if (!submit || !pending.prompt.trim()) throw Error("Conversation is not available");
            entry.sending = true; owner.changed();
            await submit(pending.prompt.trim()); pending.resolve(); entry.pending = undefined;
        } catch (error) { pending.reject(error instanceof Error ? error : Error(String(error))); entry.pending = undefined; entry.error = "submission"; }
        finally { entry.sending = false; owner.changed(); }
    }, [owner, entry]);
    if (!owner?.services.mcpApp) return <p role="status">{t("genUi.unavailable")}</p>;
    return <section data-testid="gen-ui-card" className="gen-ui-card" aria-label={title}>
        <header className="utility-actions"><span>{title}</span>{entry?.app && <Button variant="ghost" size="sm" onClick={() => owner.close(entry)}>{t("genUi.close")}</Button>}</header>
        <div ref={slot} style={{ height: entry?.height ?? 320, minWidth: 0 }} />
        {entry?.phase === "opening" && <p role="status">{t("genUi.loading")}</p>}
        {(entry?.phase === "closed" || entry?.phase === "error") && <Button variant="secondary" size="sm" onClick={() => void owner.acquire(entry)}>{t("genUi.reopen")}</Button>}
        {entry?.error && <p role="status">{t(entry.error === "submission" ? "genUi.submission" : "genUi.unavailable")}</p>}
        {entry?.pending && <div className="gen-ui-confirmation">
            <label>{t("genUi.confirm")}<Textarea data-testid="gen-ui-confirm-input" value={entry.pending.prompt} disabled={entry.sending} onChange={event => { if (entry.pending) { entry.pending.prompt = event.target.value; owner.changed(); } }} /></label>
            <div className="utility-actions"><Button data-testid="gen-ui-confirm-send" disabled={entry.sending || !send || !entry.pending.prompt.trim()} onClick={() => void confirm()}>{t("genUi.send")}</Button>
            <Button variant="ghost" disabled={entry.sending} onClick={() => { entry.pending?.reject(Error("Cancelled")); entry.pending = undefined; owner.changed(); }}>{t("genUi.cancel")}</Button></div>
        </div>}
    </section>;
}
