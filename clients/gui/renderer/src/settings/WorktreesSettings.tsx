import { toast } from "../components/ui/toast.js";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { Textarea } from "../components/ui/textarea.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { Action, Data } from "../services.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { SettingsGroupCard, SettingsRow, SettingsSection, SettingsSwitch } from "./SettingsPageParts.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { useDraftBlocker, useGuardedNavigation } from "./UnsavedChanges.js";
import { WorktreeDirectory, WorktreeSettings } from "@areal/ui/wip";
import "./WorktreesSettings.css";

type Platform = "default" | "macos" | "linux";
type Script = { default: string; macos?: string; linux?: string };
type EnvironmentAction = { id: string; name: string; script: Script };
type Environment = { id: string; name: string; setup: Script; cleanup: Script; actions: EnvironmentAction[] };
type Defaults = { worktreeRoot: string; branchPrefix: string; fetchBeforeCreate: boolean; autoCleanup: boolean; keepCount: number };
type DefaultsDraft = { value: Defaults; original: Defaults; revision: number };
type EnvironmentStore = { environments: Environment[]; environmentRevision: number };
type Project = EnvironmentStore & { id: string; root: string; name: string };
type Listing = { settings: Defaults; defaultRoot: string; revision: number; projects: Project[]; worktrees: Data[] };
type EnvironmentPage =
    | { view: "projects" }
    | { view: "project"; projectId: string }
    | { view: "editor"; projectId: string; draft: Environment; original?: Environment; revision: number;
        platforms: { setup: Platform; cleanup: Platform; actions: Record<string, Platform> }; editingActionId?: string };
type Operation = { kind: "save" | "delete-environment" | "add-project" } | { kind: "delete-worktree"; requestId: string };

const platforms = ["default", "macos", "linux"] as const;
const stateMessages = {
    ready: "worktree.ready", created: "worktree.created", binding: "worktree.binding", settingUp: "worktree.settingUp",
    cancelling: "worktree.cancelling", cancelled: "worktree.cancelled", failed: "worktree.failed",
    unknown: "worktree.unknown", creating: "worktree.creating",
} as const;

function ScriptField({ label, description, script, platform, onPlatformChange, onChange, disabled, action, suffix = "" }: {
    label: string; description?: string; script: Script; platform: Platform; onPlatformChange: (value: Platform) => void;
    onChange: (value: Script) => void; disabled: boolean; action?: ReactNode; suffix?: string;
}) {
    const { t } = useI18n();
    const labels = { default: t("worktree.platformDefault"), macos: t("worktree.platformMacos"), linux: t("worktree.platformLinux") };
    return <WorktreeSettings.Script label={label} description={description} action={action} hint={platform !== "default" ? t("worktree.overrideHint") : undefined}>
        <Tabs value={platform} onValueChange={value => onPlatformChange(value as Platform)} className="settings-segmented-tabs worktrees-script-tabs">
            <TabsList aria-label={`${t("worktree.settings.scriptPlatform", { script: label })}${suffix}`}>
                {platforms.map(value => <TabsTrigger key={value} value={value} disabled={disabled}>{labels[value]}</TabsTrigger>)}
            </TabsList>
            {platforms.map(value => <TabsContent key={value} value={value}>
                <Textarea aria-label={`${label}${suffix}`} className="worktrees-script-input" rows={6} spellCheck={false} disabled={disabled}
                    value={script[value] ?? ""} onChange={event => onChange({ ...script, [value]: event.target.value })} />
            </TabsContent>)}
        </Tabs>
    </WorktreeSettings.Script>;
}

export function WorktreesSettings({ action, projects, initialProjectId, initialTab = "general", onAddProject }: {
    action: Action; projects: Data[]; initialProjectId?: string; initialTab?: "general" | "environments";
    onAddProject?: () => Promise<string | undefined>;
}) {
    const { t } = useI18n();
    const navigate = useGuardedNavigation();
    const routeId = projects.find(project => !project.projectless)?.id;
    const [tab, setTab] = useState(initialTab);
    const [page, setPage] = useState<EnvironmentPage>(initialProjectId ? { view: "project", projectId: initialProjectId } : { view: "projects" });
    const [listing, setListing] = useState<Listing>();
    const [defaults, setDefaults] = useState<DefaultsDraft>();
    const [operation, setOperation] = useState<Operation>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    useEffect(() => { if (error) toast(error, "error"); }, [error]);
    useEffect(() => { if (notice) toast(notice, "success"); }, [notice]);
    const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const root = useRef<HTMLDivElement>(null);
    const scrollPositions = useRef<Record<string, number>>({});
    const active = useRef(true);
    const locked = useRef(false);
    const readGeneration = useRef(0);
    const request = useRef(action); request.current = action;
    const busy = !!operation;
    const editor = page.view === "editor" ? page : undefined;
    const currentProject = page.view !== "projects" ? listing?.projects.find(project => project.id === page.projectId) : undefined;
    const defaultsDirty = !!defaults && JSON.stringify(defaults.value) !== JSON.stringify(defaults.original);
    const environmentDirty = !!editor && JSON.stringify(editor.draft) !== JSON.stringify(editor.original);
    const dirty = defaultsDirty || environmentDirty;
    const scrollKey = page.view === "projects" ? "projects" : `${page.view}:${page.projectId}`;

    const refresh = async () => {
        if (!routeId) return;
        const generation = ++readGeneration.current;
        const result = await request.current("workspace", { projectId: routeId, operation: "worktreeList" }) as Listing;
        if (active.current && generation === readGeneration.current) {
            setListing(result);
            setDefaults(previous => !previous || JSON.stringify(previous.value) === JSON.stringify(previous.original)
                ? { value: result.settings, original: result.settings, revision: result.revision } : previous);
        }
        return result;
    };
    useEffect(() => {
        active.current = true;
        if (routeId) {
            setLoading(true);
            void refresh().catch(cause => { if (active.current) setError(cause.message); }).finally(() => { if (active.current) setLoading(false); });
        }
        return () => { active.current = false; readGeneration.current++; };
    }, [routeId]);
    useLayoutEffect(() => {
        if (tab === "environments") root.current?.closest(".settings-workspace")?.scrollTo({ top: scrollPositions.current[scrollKey] ?? 0 });
    }, [scrollKey, tab]);

    const moveTo = (next: EnvironmentPage) => {
        void navigate(() => {
            scrollPositions.current[scrollKey] = root.current?.closest(".settings-workspace")?.scrollTop ?? 0;
            setPage(next); setError(""); setNotice("");
        });
    };
    const updateEditor = (change: (value: Extract<EnvironmentPage, { view: "editor" }>) => Extract<EnvironmentPage, { view: "editor" }>) => {
        setPage(previous => previous.view === "editor" ? change(previous) : previous);
    };
    const perform = async (next: Operation, work: () => Promise<void>) => {
        if (locked.current) throw new Error(t("worktree.saving"));
        locked.current = true; setOperation(next); setError(""); setNotice("");
        try { await work(); }
        catch (cause) { setError((cause as Error).message); throw cause; }
        finally { locked.current = false; setOperation(undefined); }
    };
    const refreshAfterWrite = async () => { await refresh().catch(cause => setError(cause.message)); };
    const validDefaults = !!defaults && !!defaults.value.branchPrefix.trim() && Number.isInteger(defaults.value.keepCount) && defaults.value.keepCount >= 1 && defaults.value.keepCount <= 1000;
    const validEnvironment = !!editor?.draft.name.trim() && !editor.draft.actions.some(item => !item.name.trim());
    const save = async () => {
        if (!routeId || !listing || !defaults) return;
        await perform({ kind: "save" }, async () => {
            if (editor && tab === "environments") {
                if (!validEnvironment) throw new Error(t("worktree.settings.validEnvironment"));
                const result = await action("workspace", { projectId: editor.projectId, operation: "worktreeEnvironmentSave", environment: editor.draft, expectedRevision: editor.revision }) as EnvironmentStore;
                setListing(previous => previous && ({ ...previous, projects: previous.projects.map(project => project.id === editor.projectId ? { ...project, ...result } : project) }));
                setPage({ view: "project", projectId: editor.projectId });
            } else {
                if (!validDefaults) throw new Error(t("worktree.settings.validDefaults"));
                const result = await action("workspace", { projectId: routeId, operation: "worktreeSettings", ...defaults.value, expectedRevision: defaults.revision }) as Defaults;
                setDefaults({ value: result, original: result, revision: defaults.revision + 1 });
            }
            setNotice(t("worktree.saved"));
            await refreshAfterWrite();
        });
    };
    const discard = () => {
        if (listing) setDefaults({ value: listing.settings, original: listing.settings, revision: listing.revision });
        if (editor) setPage({ view: "project", projectId: editor.projectId });
    };
    useDraftBlocker({ label: t("settings.worktrees.title"), dirty, busy, save, discard });
    const edit = (project: Project, value?: Environment) => {
        moveTo({ view: "editor", projectId: project.id, draft: value ? structuredClone(value) : { id: crypto.randomUUID(), name: "", setup: { default: "" }, cleanup: { default: "" }, actions: [] },
            original: value, revision: project.environmentRevision, platforms: { setup: "default", cleanup: "default", actions: {} } });
    };
    const changeDefaults = (change: Partial<Defaults>) => setDefaults(previous => previous && ({ ...previous, value: { ...previous.value, ...change } }));
    const refreshListing = () => {
        setLoading(true); setError("");
        void refresh().catch(cause => setError(cause.message)).finally(() => setLoading(false));
    };
    const deleteWorktree = async (item: Data, name: string) => {
        const identity = [name, item.directory, t("worktree.settings.deleteDirectoryHint"), t("worktree.deleteConfirm")].join("\n\n");
        if (!window.confirm(identity) || locked.current) return;
        locked.current = true; setOperation({ kind: "delete-worktree", requestId: item.requestId }); setNotice("");
        setRowErrors(previous => ({ ...previous, [item.requestId]: "" }));
        try {
            const result = await action("workspace", { projectId: item.projectId, operation: "worktreeDelete", requestId: crypto.randomUUID(), worktreeRequestId: item.requestId });
            if (!result.deleted) throw new Error(result.deletion?.blockers?.join("\n") || result.deletion?.message || t("worktree.deleteBlocked"));
            setListing(previous => previous && ({ ...previous, worktrees: previous.worktrees.filter(value => value.requestId !== item.requestId) }));
            setNotice(t("worktree.settings.directoryDeleted", { name }));
            await refreshAfterWrite();
        } catch (cause) { const message = (cause as Error).message; setRowErrors(previous => ({ ...previous, [item.requestId]: message })); toast(message, "error"); }
        finally { locked.current = false; setOperation(undefined); }
    };
    const deleteEnvironment = async () => {
        if (!editor || !window.confirm(`${editor.draft.name}\n\n${t("worktree.deleteEnvironmentConfirm")}`)) return;
        await perform({ kind: "delete-environment" }, async () => {
            const result = await action("workspace", { projectId: editor.projectId, operation: "worktreeEnvironmentDelete", environmentId: editor.draft.id, expectedRevision: editor.revision }) as EnvironmentStore;
            setListing(previous => previous && ({ ...previous, projects: previous.projects.map(project => project.id === editor.projectId ? { ...project, ...result } : project) }));
            setPage({ view: "project", projectId: editor.projectId }); setNotice(t("worktree.settings.environmentDeleted"));
            await refreshAfterWrite();
        });
    };
    const variables = <Popover>
        <PopoverTrigger render={<Button variant="secondary" size="sm" />}>{t("worktree.settings.variables")}</PopoverTrigger>
        <PopoverContent align="end" className="worktrees-variables">
            <PopoverTitle>{t("worktree.settings.variables")}</PopoverTitle>
            <p className="settings-section-desc">{t("worktree.settings.variablesDescription")}</p>
            <dl>{([
                ["AREAL_WORKTREE_PATH", "worktree.settings.variableWorktree"],
                ["AREAL_PROJECT_PATH", "worktree.settings.variableProject"],
                ["AREAL_WORKTREE_BRANCH", "worktree.settings.variableBranch"],
            ] as const).map(([name, message]) => <div key={name}><dt><code>{name}</code></dt><dd>{t(message)}</dd></div>)}</dl>
        </PopoverContent>
    </Popover>;

    const disabled = busy || !listing;
    const projectName = (project: Project) => project.name || project.root.split("/").pop() || project.root;
    const worktreeName = (item: Data) => {
        const owner = projects.find(project => project.id === item.executionProjectId) ?? projects.find(project => project.id === item.projectId);
        return owner?.state?.threads?.[item.threadId]?.name || item.branch || t("worktree.settings.unnamedDirectory", { id: String(item.requestId).slice(0, 8) });
    };
    const directories = listing?.worktrees.filter(item => !item.deleted) ?? [];
    const groups = listing ? [...listing.projects.map(project => ({ id: project.id, name: projectName(project), items: directories.filter(item => item.projectId === project.id) })),
        { id: "unknown", name: t("worktree.settings.unknownProject"), items: directories.filter(item => !listing.projects.some(project => project.id === item.projectId)) }].filter(group => group.items.length) : [];

    return <WorktreeSettings ref={root} data-testid="worktrees-settings" view={tab === "general" ? "general" : page.view}>
        {editor && tab === "environments" ? <>
            <WorktreeSettings.Breadcrumb label={t("worktree.settings.environmentNavigation")} disabled={busy} items={[
                { id: "projects", label: t("worktree.environments"), onSelect: () => moveTo({ view: "projects" }) },
                { id: editor.projectId, label: currentProject ? projectName(currentProject) : t("worktree.project"), onSelect: () => moveTo({ view: "project", projectId: editor.projectId }) },
                { id: "editor", label: editor.draft.name || t("worktree.newEnvironment") },
            ]} />
            <h1 className="settings-page-title worktrees-editor-title">{t(editor.original ? "worktree.settings.editEnvironment" : "worktree.newEnvironment")}</h1>
        </> : <div className="worktrees-overview">
            <p className="settings-section-desc">{t("worktree.settings.description")}</p>
            <SettingsSegmentedTabs ariaLabel={t("settings.worktrees.title")} value={tab} disabled={busy} activateOnFocus={false}
                items={[{ value: "general", label: t("worktree.general") }, { value: "environments", label: t("worktree.environments") }]}
                onValueChange={next => { void navigate(() => { setTab(next); setError(""); setNotice(""); }); }} />
        </div>}
        <Button variant="ghost" size="icon" className="worktrees-refresh" aria-label={t("worktree.settings.refresh")} title={t("worktree.settings.refresh")} disabled={loading || busy || !routeId} onClick={refreshListing}>
            {loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
        </Button>


        {error && <details className="worktrees-feedback"><summary>{t("recovery.details")}</summary><p>{error}</p></details>}
        {loading && <p role="status" className="settings-section-desc">{t("worktree.loading")}</p>}
        {!routeId ? <SettingsSection description={t("worktree.noProjects")} action={onAddProject && <Button variant="secondary" disabled={busy} onClick={() => { void perform({ kind: "add-project" }, async () => {
            const id = await onAddProject(); if (id) { setTab("environments"); setPage({ view: "project", projectId: id }); }
        }).catch(() => {}); }}><Plus />{t("worktree.settings.addProject")}</Button>}><div /></SettingsSection> : tab === "general" ? <>
            <SettingsSection title={t("worktree.settings.creationAndCleanup")}>
                <SettingsGroupCard className="worktrees-general-group">
                    <SettingsRow label={t("worktree.root")} description={t("worktree.settings.rootDescription")} control={<Input className="worktrees-root-input" aria-label={t("worktree.root")} disabled={disabled} value={defaults?.value.worktreeRoot ?? ""} placeholder={listing?.defaultRoot}
                        onChange={event => changeDefaults({ worktreeRoot: event.target.value })} />} />
                    <SettingsRow label={t("worktree.fetchBeforeCreate")} description={t("worktree.fetchDescription")} control={<SettingsSwitch aria-label={t("worktree.fetchBeforeCreate")} checked={defaults?.value.fetchBeforeCreate ?? false} disabled={disabled}
                        onCheckedChange={fetchBeforeCreate => changeDefaults({ fetchBeforeCreate })} />} />
                    <SettingsRow label={t("worktree.autoCleanup")} description={t("worktree.autoCleanupDescription")} control={<SettingsSwitch aria-label={t("worktree.autoCleanup")} checked={defaults?.value.autoCleanup ?? false} disabled={disabled}
                        onCheckedChange={autoCleanup => changeDefaults({ autoCleanup })} />} />
                    <SettingsRow label={t("worktree.keepCount")} description={t(defaults?.value.autoCleanup ? "worktree.settings.keepDescription" : "worktree.settings.keepInactiveDescription")} control={<Input aria-label={t("worktree.keepCount")} type="number" min={1} max={1000} className="worktrees-count-input" disabled={disabled} value={defaults?.value.keepCount ?? 10}
                        onChange={event => changeDefaults({ keepCount: Number(event.target.value) })} />} />
                </SettingsGroupCard>
                <SettingsDisclosure title={t("worktree.settings.advanced")} className="worktrees-advanced">
                    <SettingsRow label={t("worktree.prefix")} control={<Input aria-label={t("worktree.prefix")} disabled={disabled} value={defaults?.value.branchPrefix ?? "areal"} onChange={event => changeDefaults({ branchPrefix: event.target.value })} />} />
                </SettingsDisclosure>
                {defaultsDirty && <div className="worktrees-save-row"><p className="settings-section-desc">{t("worktree.futureOnly")}</p>
                    <Button variant="ghost" disabled={busy} onClick={discard}>{t("worktree.settings.discard")}</Button>
                    <Button disabled={disabled || !validDefaults} onClick={() => { void save().catch(() => {}); }}>{t(operation?.kind === "save" ? "worktree.saving" : "worktree.save")}</Button>
                </div>}
            </SettingsSection>
            <SettingsSection title={t("worktree.managed")}>
                <WorktreeDirectory>{groups.map(group => <WorktreeDirectory.Group key={group.id} title={group.name}>
                    {group.items.map(item => {
                        const name = worktreeName(item);
                        const open = expanded.has(item.requestId);
                        const deleting = operation?.kind === "delete-worktree" && operation.requestId === item.requestId || item.deletion?.status === "running";
                        const rowError = rowErrors[item.requestId] || (item.deletion?.status === "unknown" ? item.deletion.message || t("worktree.unknown") : "");
                        return <WorktreeDirectory.Item key={item.requestId} name={name} open={open} disabled={busy} deleting={deleting} error={rowError}
                            labels={{ details: t("worktree.settings.details"), delete: t("worktree.delete"), deleting: t("worktree.settings.deletingDirectory"), result: t("worktree.settings.status") }}
                            onToggle={() => setExpanded(previous => { const next = new Set(previous); if (next.has(item.requestId)) next.delete(item.requestId); else next.add(item.requestId); return next; })}
                            onDelete={() => { void deleteWorktree(item, name); }}>
                                <div><dt>{t("worktree.settings.directory")}</dt><dd><code>{item.directory}</code></dd></div>
                                <div><dt>{t("worktree.settings.branch")}</dt><dd><code>{item.branch}</code></dd></div>
                                <div><dt>{t("worktree.environment")}</dt><dd>{item.environment?.name || t("worktree.noEnvironment")}</dd></div>
                                <div><dt>{t("worktree.settings.status")}</dt><dd>{t(stateMessages[item.state as keyof typeof stateMessages] ?? "worktree.unknown")}</dd></div>
                                <div><dt>{t("worktree.settings.request")}</dt><dd><code>{item.requestId}</code></dd></div>
                        </WorktreeDirectory.Item>;
                    })}
                </WorktreeDirectory.Group>)}</WorktreeDirectory>
                {listing && !directories.length && <p className="worktrees-empty">{t("worktree.empty")}</p>}
            </SettingsSection>
        </> : page.view === "projects" ? <SettingsSection title={t("worktree.settings.selectProject")} action={onAddProject && <Button variant="secondary" size="sm" disabled={busy} onClick={() => { void perform({ kind: "add-project" }, async () => {
            const id = await onAddProject(); await refresh(); if (id) setPage({ view: "project", projectId: id });
        }).catch(() => {}); }}><Plus />{t("worktree.settings.addProject")}</Button>}>
            <div className="worktrees-project-list">{listing?.projects.map(project => <WorktreeSettings.Project key={project.id} name={projectName(project)} root={project.root} disabled={disabled}
                openLabel={t("worktree.settings.configureProject", { name: projectName(project) })} addLabel={t("worktree.settings.addProjectEnvironment", { name: projectName(project) })}
                onOpen={() => moveTo({ view: "project", projectId: project.id })} onAdd={() => edit(project)} />)}</div>
            {listing && !listing.projects.length && <p className="worktrees-empty">{t("worktree.noProjects")}</p>}
        </SettingsSection> : !editor ? <>
            <WorktreeSettings.Breadcrumb label={t("worktree.settings.environmentNavigation")} disabled={busy} items={[
                { id: "projects", label: t("worktree.environments"), onSelect: () => moveTo({ view: "projects" }) },
                { id: "project", label: currentProject ? projectName(currentProject) : t("worktree.project") },
            ]} />
            <SettingsSection title={currentProject ? projectName(currentProject) : t("worktree.environments")} action={<Button variant="secondary" size="sm" disabled={disabled || !currentProject} onClick={() => { if (currentProject) edit(currentProject); }}><Plus />{t("worktree.addEnvironment")}</Button>}>
                <div className="worktrees-environment-list">{currentProject?.environments.map(item => <WorktreeSettings.Environment key={item.id} name={item.name} label={t("worktree.settings.editNamedEnvironment", { name: item.name })} disabled={disabled} onOpen={() => edit(currentProject, item)} />)}</div>
                {currentProject && !currentProject.environments.length && <p className="worktrees-empty">{t("worktree.settings.noEnvironments")}</p>}
            </SettingsSection>
        </> : <>
            <SettingsGroupCard className="worktrees-name-group"><label>{t("worktree.environmentName")}<Input aria-label={t("worktree.environmentName")} disabled={busy} value={editor.draft.name} onChange={event => updateEditor(value => ({ ...value, draft: { ...value.draft, name: event.target.value } }))} /></label></SettingsGroupCard>
            <ScriptField label={t("worktree.setupScript")} description={t("worktree.settings.setupDescription")} action={variables} script={editor.draft.setup} platform={editor.platforms.setup} disabled={busy}
                onPlatformChange={setup => updateEditor(value => ({ ...value, platforms: { ...value.platforms, setup } }))} onChange={setup => updateEditor(value => ({ ...value, draft: { ...value.draft, setup } }))} />
            <ScriptField label={t("worktree.cleanupScript")} description={t("worktree.settings.cleanupDescription")} script={editor.draft.cleanup} platform={editor.platforms.cleanup} disabled={busy}
                onPlatformChange={cleanup => updateEditor(value => ({ ...value, platforms: { ...value.platforms, cleanup } }))} onChange={cleanup => updateEditor(value => ({ ...value, draft: { ...value.draft, cleanup } }))} />
            <SettingsSection title={t("worktree.actions")} description={t("worktree.settings.actionsDescription")} action={<Button variant="secondary" size="sm" disabled={busy || editor.draft.actions.length >= 50} onClick={() => {
                const id = crypto.randomUUID(); updateEditor(value => ({ ...value, editingActionId: id, draft: { ...value.draft, actions: [...value.draft.actions, { id, name: "", script: { default: "" } }] } }));
            }}><Plus />{t("worktree.addAction")}</Button>}>
                {!editor.draft.actions.length && <p className="worktrees-empty">{t("worktree.settings.noActions")}</p>}
                <div className="worktrees-action-list">{editor.draft.actions.map(item => <WorktreeSettings.Action key={item.id} name={item.name || t("worktree.settings.unnamedAction")} summary={item.script.default.split("\n").find(line => line.trim())} editorId={`worktree-action-${item.id}`} controls={<>
                        <Button variant="ghost" size="sm" disabled={busy} aria-label={t("worktree.settings.editNamedAction", { name: item.name || t("worktree.settings.unnamedAction") })} aria-expanded={editor.editingActionId === item.id} aria-controls={`worktree-action-${item.id}`} onClick={() => updateEditor(value => ({ ...value, editingActionId: value.editingActionId === item.id ? undefined : item.id }))}>{t(editor.editingActionId === item.id ? "worktree.settings.doneEditing" : "worktree.settings.edit")}</Button>
                        <Button variant="ghost" size="icon" disabled={busy} aria-label={`${t("worktree.removeAction")} ${item.name || t("worktree.settings.unnamedAction")}`} onClick={() => updateEditor(value => ({ ...value, editingActionId: value.editingActionId === item.id ? undefined : value.editingActionId, draft: { ...value.draft, actions: value.draft.actions.filter(action => action.id !== item.id) } }))}><Trash2 /></Button>
                    </>}>
                    {editor.editingActionId === item.id && <><label>{t("worktree.actionName")}<Input aria-label={t("worktree.actionName")} value={item.name} disabled={busy} onChange={event => updateEditor(value => ({ ...value, draft: { ...value.draft, actions: value.draft.actions.map(action => action.id === item.id ? { ...action, name: event.target.value } : action) } }))} /></label>
                        <ScriptField label={t("worktree.actionScript")} suffix={` ${item.name || t("worktree.settings.unnamedAction")}`} script={item.script} platform={editor.platforms.actions[item.id] ?? "default"} disabled={busy}
                            onPlatformChange={platform => updateEditor(value => ({ ...value, platforms: { ...value.platforms, actions: { ...value.platforms.actions, [item.id]: platform } } }))}
                            onChange={script => updateEditor(value => ({ ...value, draft: { ...value.draft, actions: value.draft.actions.map(action => action.id === item.id ? { ...action, script } : action) } }))} />
                    </>}
                </WorktreeSettings.Action>)}</div>
            </SettingsSection>
            <div className="worktrees-save-row">
                {editor.original && <Button variant="ghost" className="worktrees-delete-environment" disabled={busy} onClick={() => { void deleteEnvironment().catch(() => {}); }}>{t(operation?.kind === "delete-environment" ? "worktree.settings.deletingEnvironment" : "worktree.deleteEnvironment")}</Button>}
                <span className="worktrees-save-spacer" />
                <Button variant="ghost" disabled={busy} onClick={discard}>{t("worktree.settings.discard")}</Button>
                <Button disabled={disabled || !validEnvironment || !environmentDirty} onClick={() => { void save().catch(() => {}); }}>{t(operation?.kind === "save" ? "worktree.saving" : "worktree.save")}</Button>
            </div>
        </>}
    </WorktreeSettings>;
}
