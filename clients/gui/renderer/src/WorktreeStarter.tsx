import { toast } from "./components/ui/toast.js";
import { useEffect, useRef, useState } from "react";
import { GitBranch, GitFork, Settings } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { SettingsSearchInput } from "./settings/SettingsSearchInput.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { SettingsSwitch } from "./settings/SettingsPageParts.js";
import { useI18n } from "./i18n/IntlProvider.js";
import type { Action, Data } from "./services.js";
import { WorktreePicker } from "@areal/ui/wip";
import "./Worktree.css";

export type WorktreeSelection = {
    sourceRoot: string;
    ref: string;
    worktreeRoot: string;
    branch: string;
    branchPrefix: string;
    mode: "source" | "worktree";
    environmentId?: string;
    environmentRevision?: number;
};
type Options = {
    worktrees?: { root: string; branch?: string }[];
    branches: string[];
    settings: { worktreeRoot: string; branchPrefix: string };
    environments?: { id: string; name: string }[];
    environmentRevision?: number;
};

type PickerPage = "main" | "branch" | "environment";

export function WorktreeStarter({ project, action, value, onChange, onConfigureEnvironments, disabled = false }: {
    project: Data;
    action: Action;
    value?: WorktreeSelection;
    onChange: (value: WorktreeSelection | undefined) => void;
    onConfigureEnvironments?: () => void;
    disabled?: boolean;
}) {
    const { t } = useI18n();
    const sourceRoot = project.logicalRoot ?? project.root;
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState<PickerPage>("main");
    const [query, setQuery] = useState("");
    const [response, setResponse] = useState<{ owner: string; options: Options }>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [retry, setRetry] = useState(0);
    useEffect(() => { if (error) toast(error, "error"); }, [error]);
    const search = useRef<HTMLInputElement>(null);
    const branchTrigger = useRef<HTMLButtonElement>(null);
    const environmentTrigger = useRef<HTMLButtonElement>(null);
    const request = useRef(action); request.current = action;
    const owner = JSON.stringify([project.id, sourceRoot]);
    const options = response?.owner === owner ? response.options : undefined;
    useEffect(() => {
        if (!open) return;
        let active = true;
        setLoading(true); setError("");
        void request.current("workspace", { projectId: project.id, operation: "worktreeOptions", sourceRoot }).then(
            (options: Options) => { if (active) setResponse({ owner, options }); },
            cause => { if (active) setError((cause as Error).message); },
        ).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [open, owner, retry]);
    useEffect(() => { if (page === "branch") search.current?.focus(); }, [page]);
    const selected: WorktreeSelection = value ?? {
        sourceRoot, ref: "HEAD", worktreeRoot: options?.settings.worktreeRoot ?? "",
        branch: "", branchPrefix: options?.settings.branchPrefix ?? "areal", mode: "source",
    };
    const enabled = value?.mode === "worktree";
    const change = (patch: Partial<WorktreeSelection>) => {
        const next = { ...selected, ...patch };
        if (next.environmentId === undefined) delete next.environmentId;
        if (next.environmentRevision === undefined) delete next.environmentRevision;
        onChange(next);
    };
    const busy = disabled || loading || !options || !!error;
    const allBranches = [...new Set(["HEAD", ...(options?.branches ?? [])])];
    const branches = allBranches.filter(branch => branch.toLowerCase().includes(query.toLowerCase()));
    const environments = options?.environments ?? [];
    const selectedEnvironment = environments.find(item => item.id === selected.environmentId);
    const staleEnvironment = !!selected.environmentId && !selectedEnvironment;
    const sourceBranch = options?.worktrees?.find(item => sourceRoot === item.root || sourceRoot.startsWith(item.root + "/"))?.branch;
    const back = () => {
        const previous = page;
        setPage("main"); setQuery("");
        requestAnimationFrame(() => (previous === "branch" ? branchTrigger : environmentTrigger).current?.focus());
    };
    return <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) { setPage("main"); setQuery(""); } }}>
        <PopoverTrigger render={<Button variant="ghost" size="icon" disabled={disabled || !project.state?.connected}
            aria-label={t("worktree.configure")} title={t("worktree.configure")} className="worktree-picker-trigger" />}>
            <Settings className="size-4" aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent side="top" align="end" variant="menu" className="worktree-picker" aria-label={t("worktree.configure")}
            onKeyDownCapture={event => { if (event.key === "Escape" && page !== "main" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); back(); } }}>
            <WorktreePicker>{page === "main" ? <>
                <p className="worktree-picker-heading">{t("worktree.configureLocal")}</p>
                <WorktreePicker.Row icon={<GitFork aria-hidden="true" />} label={t("worktree.new")} control={<SettingsSwitch className="worktree-picker-toggle" aria-label={t("worktree.workInNew")} checked={enabled} disabled={busy}
                    onCheckedChange={checked => change({ mode: checked ? "worktree" : "source", ...(checked ? {} : { environmentId: undefined, environmentRevision: undefined }) })} />} />
                <WorktreePicker.Row ref={branchTrigger} icon={<GitBranch aria-hidden="true" />} label={t("worktree.branchLabel")} value={<span title={selected.ref === "HEAD" ? sourceBranch : selected.ref}>{selected.ref === "HEAD" ? sourceBranch ?? selected.ref : selected.ref}</span>}
                    disabled={busy} aria-label={t("worktree.startBranch")} onClick={() => setPage("branch")} />
                <WorktreePicker.Row ref={environmentTrigger} icon={<Settings aria-hidden="true" />} label={t("worktree.environments")} value={staleEnvironment ? t("worktree.selectedUnavailable") : selectedEnvironment?.name ?? t("worktree.noEnvironment")}
                    disabled={busy || !enabled} aria-label={t("worktree.environment")} onClick={() => setPage("environment")} />
                {staleEnvironment && enabled && <p role="alert" className="worktree-picker-feedback">{t("worktree.selectedUnavailable")}</p>}
            </> : <>
                <WorktreePicker.Page label={t(page === "branch" ? "worktree.branchLabel" : "worktree.environments")} backLabel={t("worktree.back")} onBack={back}>
                {page === "branch" ? <>
                    <SettingsSearchInput ref={search} aria-label={t("worktree.searchBranches")} placeholder={t("worktree.searchBranches")} value={query}
                        onChange={event => setQuery(event.target.value)} onClear={() => { setQuery(""); search.current?.focus(); }} clearLabel={t("worktree.clearSearch")} containerClassName="worktree-branch-search" />
                    <p className="worktree-picker-note">{t("worktree.commitOnly")}</p>
                    <WorktreePicker.Options label={t("worktree.startBranch")} disabled={busy} heading={t("worktree.branches")} empty={t("worktree.noBranches")}
                        items={branches.map(branch => ({ id: branch, label: branch === "HEAD" && sourceBranch ? `${branch} · ${sourceBranch}` : branch, title: branch, icon: <GitBranch aria-hidden="true" />, selected: selected.ref === branch }))}
                        onSelect={ref => { change({ ref }); back(); }} />
                </> : <>
                    <WorktreePicker.Options label={t("worktree.environment")} disabled={busy}
                        items={[{ id: "none", name: t("worktree.noEnvironment") }, ...environments].map(item => ({ id: item.id, label: item.name, icon: <Settings aria-hidden="true" />, selected: item.id === (selected.environmentId ?? "none") }))}
                        onSelect={id => { change({ environmentId: id === "none" ? undefined : id, environmentRevision: id === "none" ? undefined : options?.environmentRevision }); back(); }} />
                    {!environments.length && <p className="worktree-picker-note">{t("worktree.noEnvironment")}</p>}
                    {onConfigureEnvironments && <Button variant="ghost" className="worktree-picker-configure" onClick={() => { setOpen(false); setPage("main"); onConfigureEnvironments(); }}><Settings aria-hidden="true" />{t("worktree.configureEnvironments")}</Button>}
                </>}
                </WorktreePicker.Page>
            </>}
            {loading && <p role="status" className="worktree-picker-feedback">{t("worktree.loading")}</p>}
            {error && <div className="worktree-picker-feedback"><details><summary>{t("recovery.details")}</summary><p>{error}</p></details><Button variant="ghost" size="sm" onClick={() => setRetry(value => value + 1)}>{t("worktree.retryOptions")}</Button></div>}
            </WorktreePicker>
        </PopoverContent>
    </Popover>;
}
