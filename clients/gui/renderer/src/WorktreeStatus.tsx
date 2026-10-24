import { toast } from "./components/ui/toast.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { GitBranch, GitFork } from "lucide-react";
import { useI18n } from "./i18n/IntlProvider.js";
import type { Action, Data } from "./services.js";
import { WorktreeStatus as StatusView, WorktreeWorkspace } from "@areal/ui/wip";
import "./Worktree.css";

const stateMessages = {
    ready: "worktree.ready", created: "worktree.created", binding: "worktree.binding",
    settingUp: "worktree.settingUp", cancelling: "worktree.cancelling", cancelled: "worktree.cancelled",
    failed: "worktree.failed", unknown: "worktree.unknown", creating: "worktree.creating",
} as const;

export function WorktreeStatus({ events = [], current, controls }: { events?: Data[]; current?: Data; controls?: ReactNode }) {
    const { t } = useI18n();
    if (!events.length && !current) return null;
    const latest = { ...events.at(-1), ...current };
    const state = latest.state ?? latest.status ?? "creating";
    const record = latest.record ?? latest;
    const setup = latest.setup ?? record.setup;
    const directory = latest.directory ?? record.directory;
    const branch = latest.branch ?? record.branch;
    const message = latest.message ?? setup?.message;
    const ready = state === "ready";
    const checkoutCreated = ready || ["created", "binding", "settingUp"].includes(state);
    const running = ["creating", "created", "binding", "settingUp", "cancelling"].includes(state);
    const phaseMessage = stateMessages[state as keyof typeof stateMessages] ?? "worktree.unknown";
    const stages = [...new Map([...events, latest].map(event => [event.state ?? event.status, event])).values()]
        .filter(event => stateMessages[(event.state ?? event.status) as keyof typeof stateMessages]);
    const hasDetails = !!(directory || branch || setup?.output || events.length || message);
    return <StatusView state={state} label={t(checkoutCreated ? "worktree.createdLabel" : phaseMessage)} regionLabel={t("worktree.events")} running={running} message={message}
        showLabel={t("worktree.showDetails")} hideLabel={t("worktree.hideDetails")} controls={controls}
        stages={stages.map(event => { const id = event.state ?? event.status ?? "creating"; return { id, current: id === state, label: t(id === "creating" ? "worktree.preparingWorkspace" : stateMessages[id as keyof typeof stateMessages] ?? "worktree.creating") }; })}
        details={hasDetails && <>
            {branch && <p className="flex items-center gap-2"><GitBranch className="size-3.5 shrink-0" aria-hidden="true" /><span>{branch}</span></p>}
            {directory && <code>{directory}</code>}{running && message && <p>{message}</p>}
            {setup?.output && <pre aria-label={t("worktree.output")} className="worktree-status-log">{setup.output}</pre>}
            {ready && <p>{t(latest.automatic ? "worktree.automaticEvent" : "worktree.commitOnly")}</p>}
        </>} />;
}

export function WorktreeActions({ projectId, threadId, worktree, action }: { projectId: string; threadId: string; worktree: Data; action: Action }) {
    const { t } = useI18n();
    const [record, setRecord] = useState<Data>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [output, setOutput] = useState("");
    const request = useRef(action); request.current = action;
    useEffect(() => {
        let active = true;
        void request.current("workspace", { projectId, operation: "worktreeList" }).then(result => {
            if (active) setRecord(result.worktrees?.find((item: Data) => item.threadId === threadId && !item.deleted));
        }, cause => { if (active) { setError(cause.message); toast(cause.message, "error"); } });
        return () => { active = false; };
    }, [projectId, threadId]);
    const run = async (actionId: string) => {
        if (busy || !record) return;
        setBusy(true); setError(""); setOutput("");
        try {
            const result = await action("workspace", { projectId, operation: "worktreeAction", requestId: crypto.randomUUID(), worktreeRequestId: record.requestId, actionId });
            setOutput(result.output ?? result.stdout ?? result.result?.output ?? "");
            if (result.status !== "succeeded") { const message = result.message || t(result.status === "unknown" ? "worktree.unknown" : "worktree.failed"); setError(message); toast(message, result.status === "unknown" ? "warning" : "error"); }
        } catch (cause) { const message = (cause as Error).message; setError(message); toast(message, "error"); }
        finally { setBusy(false); }
    };
    return <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="sm" aria-label={t("worktree.threadWorkspace", { branch: worktree.branch })} title={worktree.directory} />}>
            <GitFork className="size-3.5" /><span className="max-w-36 truncate">{worktree.branch}</span>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
            <WorktreeWorkspace heading={record ? t(stateMessages[record.state as keyof typeof stateMessages] ?? "worktree.unknown") : worktree.branch} directory={worktree.directory}
                busy={busy} busyLabel={t("worktree.actionRunning")} error={error} output={output} outputLabel={t("worktree.output")}
                actions={(record?.environment?.actions ?? []).map((item: Data) => <Button variant="secondary" size="sm" key={item.id} disabled={busy || record?.state !== "ready"} onClick={() => void run(item.id)}>{item.name}</Button>)} />
        </PopoverContent>
    </Popover>;
}
