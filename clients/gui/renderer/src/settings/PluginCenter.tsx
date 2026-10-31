import { SettingsGroupCard, SettingsRow } from "@areal/ui/compositions";
import { Textarea } from "@areal/ui";
import { useI18n, UiMessageError, type UiMessage, formatUiMessage } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useGuardedNavigation } from "./UnsavedChanges.js";
import { PluginHookSettings } from "./PluginHookSettings.js";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Box,
  ChevronRight,
  MoreHorizontal,
  Package,
  Plug,
  Plus,
  RefreshCw,
  Store,
  Upload,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu.js";
import { Switch } from "../components/ui/switch.js";
import { McpSettings } from "./ResourceSettings.js";
import { SettingsPluginIcon } from "./settingsNavIcons.js";
import { PluginSkillsPage, type CenterSkill, type ResourceDraftSeed } from "./PluginSkillsPage.js";
import "./PluginCenter.css";
import { PluginComponentSupport, supportBlocked } from "./PluginComponentSupport.js";
import { PluginConnectionPanel } from "./PluginConnectionPanel.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Feedback, SettingsDialog } from "./common.js";
import { SettingsSearchInput } from "./SettingsSearchInput.js";
import { SettingsSegmentedTabs } from "./SettingsSegmentedTabs.js";
import { ResourceScope, type ScopedProps } from "./ScopedSkillsSettings.js";
import type { Data } from "../services.js";
import { isIndependentCreation, recoveredOutcome } from "../recoveryPresentation.js";
import { buildPluginMentionMarkdown } from "../mentions/mentionMarkdown.js";
import { presentPlugin, type PluginConnectionFacts } from "./pluginPresentation.js";
import { PluginConfiguration } from "./PluginConfiguration.js";
import { PluginTemplateActions } from "./PluginTemplateActions.js";
import { PluginDoctorSummary } from "./PluginDoctorSummary.js";
import { PluginInstallReview } from "./PluginInstallReview.js";
import { PluginOverview } from "./PluginOverview.js";
import { usePluginSubmission, failure, failureText } from "./usePluginSubmission.js";
import { usePluginCenter } from "./usePluginCenter.js";
import { pluginMcpStateLabel } from "./pluginResources.js";

import type { ManagementRequest } from "@areal/workbench/desktop-contract/management";
import type {
  PluginDetail,
  PluginReadiness,
  PluginOperation,
  PluginPreview,
} from "./pluginTypes.js";
export type { PluginDetail, PluginCommand, PluginMutate } from "./pluginTypes.js";
const pluginMethods: Record<string, PluginOperation["mutation"]> = {
  "areal/plugin/importArchive": "pluginArchiveImport",
  "areal/marketplace/add": "marketplaceAdd",
  "areal/plugin/install": "pluginInstall",
  "areal/plugin/configure": "pluginConfigure",
  "areal/plugin/component/configure": "pluginComponentConfigure",
  "areal/plugin/uninstall": "pluginUninstall",
  "areal/plugin/setup": "pluginSetup",
  "areal/plugin/resolve": "pluginResolve",
  "areal/marketplace/addGit": "marketplaceAddGit",
  "areal/marketplace/remove": "marketplaceRemove",
  "areal/marketplace/update": "marketplaceUpdate",
  "areal/plugin/connection": "pluginConnection",
  "areal/plugin/hooks/configure": "pluginHooksConfigure",
  "areal/plugin/auth": "pluginAuth",
  "areal/plugin/auth/configure": "pluginAuthConfigure",
  "areal/plugin/connector/configure": "connectorConfigure",
  "areal/plugin/userConfig/set": "pluginUserConfigSave",
  "areal/plugin/development/link": "pluginDevelopmentLink",
  "areal/plugin/development/unlink": "pluginDevelopmentUnlink",
};
function isSourceOperation(
  operation: PluginOperation | null | undefined,
  projectId: string | undefined,
  pluginId: string | undefined,
) {
  return (
    !!operation &&
    !!projectId &&
    !!pluginId &&
    operation.mutation === "pluginResolve" &&
    operation.projectId === projectId &&
    operation.pluginId === pluginId
  );
}
function pluginInterface(value: unknown) {
  const fields = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  const text = (key: string) => {
    const entry: unknown = Reflect.get(fields, key);
    return typeof entry === "string" ? entry : undefined;
  };
  const strings = (key: string) => {
    const entry: unknown = Reflect.get(fields, key);
    return Array.isArray(entry)
      ? entry.filter((item): item is string => typeof item === "string")
      : [];
  };
  return {
    category: text("category"),
    developerName: text("developerName"),
    longDescription: text("longDescription"),
    websiteUrl: text("websiteUrl"),
    privacyPolicyUrl: text("privacyPolicyUrl"),
    termsOfServiceUrl: text("termsOfServiceUrl"),
    defaultPrompt: strings("defaultPrompt"),
    capabilities: strings("capabilities"),
    url: text("url"),
  };
}
function reviewDigest(plugin: Pick<PluginDetail, "sourceDigest" | "admissionDigest">) {
  return plugin.admissionDigest ?? plugin.sourceDigest;
}
function previewFromResult(result: Partial<PluginDetail> | undefined): PluginPreview | null {
  if (
    !result ||
    typeof result.id !== "string" ||
    !result.id.trim() ||
    typeof result.source !== "string" ||
    !result.source.trim() ||
    typeof result.sourceDigest !== "string" ||
    !result.sourceDigest.trim() ||
    (result.admissionDigest != null &&
      (typeof result.admissionDigest !== "string" || !result.admissionDigest.trim())) ||
    typeof result.revision !== "number" ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 0
  )
    return null;
  return {
    id: result.id,
    revision: result.revision,
    source: result.source,
    sourceDigest: result.sourceDigest,
    admissionDigest: result.admissionDigest,
    resolvedCommit: typeof result.resolvedCommit === "string" ? result.resolvedCommit : undefined,
    packageVersion: typeof result.packageVersion === "string" ? result.packageVersion : undefined,
    version: typeof result.version === "string" ? result.version : null,
    integrity: typeof result.integrity === "string" ? result.integrity : undefined,
  };
}

type ListRoute =
  | { kind: "market"; audience: "public" | "personal" }
  | { kind: "skills" }
  | { kind: "installed"; tab: "plugins" | "mcp" | "skills" | "markets" };
type CenterRoute =
  | ListRoute
  | { kind: "plugin"; id: string; returnTo: ListRoute }
  | { kind: "skill"; skill: CenterSkill; returnTo: ListRoute };
type PluginListReturn = {
  projectId: string;
  route: ListRoute;
  pluginId: string;
  scrollTop: number;
};
export type PluginCenterProps = ScopedProps & {
  active: boolean;
  marketRequest: number;
  surface: "workspace" | "settings";
  projects: Data[];
  initialTab?: "plugins" | "mcp" | "skills" | "markets";
  onOpenThread?: (projectId: string, threadId: string) => void;
  apps?: (pluginId: string) => ReactNode;
  onSettings: () => void;
  onMarket: (preserveDetail?: boolean) => void;
  onChooseProject: () => void;
  onSelectProject: (id: string) => void;
  onStartDraft: (seed: ResourceDraftSeed) => Promise<void>;
  onRunCommand?: (
    command: import("@areal/workbench/desktop-contract/conversation").PluginCommandRef,
  ) => Promise<void>;
  onReturnToTask?: () => void;
};
const officialMarket = (url?: string | null) =>
  !!url && /^https:\/\/github\.com\/openai\/plugins(?:\.git)?\/?$/i.test(url);
export function PluginCenter({
  project: selectedProject,
  projects,
  thread,
  action,
  onOpenThread,
  apps,
  active: panelActive,
  surface,
  marketRequest,
  initialTab = "plugins",
  onSettings,
  onMarket,
  onChooseProject,
  onStartDraft,
  onRunCommand,
  onReturnToTask,
}: PluginCenterProps) {
  const { t } = useI18n();
  const navigate = useGuardedNavigation();
  const [ownerId, setOwnerId] = useState<string | undefined>(selectedProject?.id);
  const project = projects.find((item) => item.id === ownerId);
  const projectId = project?.id;
  const currentProject = useRef(projectId);
  currentProject.current = projectId;
  const connected = !!project?.state?.connected;
  const [route, setRoute] = useState<CenterRoute>({ kind: "market", audience: "public" });
  const listReturn = useRef<PluginListReturn | null>(null);
  const restoringList = useRef(false);
  const scrollRegion = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const pluginRows = useRef(new Map<string, HTMLElement>());
  const navigateRoute = (next: CenterRoute) =>
    navigate(() => {
      listReturn.current = null;
      restoringList.current = false;
      setMessage("");
      setRoute(next);
    });
  const listRoute = route.kind === "plugin" || route.kind === "skill" ? route.returnTo : route;
  const [selected, updateSelected] = useState<string | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const setSelected = (id: string | null) => {
    navigate(() => {
      if (id && route.kind !== "plugin" && route.kind !== "skill" && projectId) {
        listReturn.current = {
          projectId,
          route: listRoute,
          pluginId: id,
          scrollTop: scrollRegion.current?.scrollTop ?? 0,
        };
      }
      if (id) updateSelected(id);
      setRoute(id ? { kind: "plugin", id, returnTo: listRoute } : listRoute);
    });
  };
  const writes = usePluginSubmission();
  const { error, setError, message, setMessage, submission, setSubmission, activity, active } =
    writes;
  const [setupThreadId, setSetupThreadId] = useState<string | null>(null);
  const [checkingProjectOperation, setCheckingProjectOperation] = useState(false);
  const [projectCheckMessages, setProjectCheckMessages] = useState<
    Record<string, UiMessage | string>
  >({});
  const pendingEntries: Data[] = project?.pending ?? [];
  const blockingPending = pendingEntries.filter(
    (entry) => !isIndependentCreation(entry, [submission?.requestId, error?.requestId]),
  );
  const [connectingProject, setConnectingProject] = useState(false);
  const pending = !!blockingPending.length;
  const busy = activity !== null || checkingProjectOperation || connectingProject;
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [adding, setAdding] = useState(false);
  const [root, setRoot] = useState("");
  const [addKind, setAddKind] = useState("local");
  const [gitRef, setGitRef] = useState("");
  const [sparsePaths, setSparsePaths] = useState("");
  const [archive, setArchive] = useState<{ selectionToken: string; fileName: string } | null>(null);
  const [mcpAddRequest, setMcpAddRequest] = useState(0);
  const [mcpScope, setMcpScope] = useState("user");
  useEffect(() => {
    if (route.kind !== "installed" || route.tab !== "mcp") setMcpAddRequest(0);
  }, [route]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [authRequests, setAuthRequests] = useState<Set<string>>(() => new Set());
  const authPending = authRequests.size > 0;
  const onAuthActivity = useCallback(
    (id: string, pending: boolean) =>
      setAuthRequests((previous) => {
        if (previous.has(id) === pending) return previous;
        const next = new Set(previous);
        if (pending) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const [preview, setPreview] = useState<PluginPreview | null>(null);
  const [installReview, setInstallReview] = useState(false);
  const installReviewPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (installReview) installReviewPanel.current?.focus();
  }, [installReview, busy]);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [submissionDetails, setSubmissionDetails] = useState(false);
  const [copiedDigest, setCopiedDigest] = useState(false);
  const [metadataCopy, setMetadataCopy] = useState<{
    kind: "copied" | "failed";
    name: string;
  } | null>(null);
  const [connectionFacts, setConnectionFacts] = useState<PluginConnectionFacts | null>(null);
  const onConnectionFacts = useCallback(
    (facts: PluginConnectionFacts) => setConnectionFacts(facts),
    [],
  );
  const [connectionLoading, setConnectionLoading] = useState(false);
  const [connectionReadKey, setConnectionReadKey] = useState(0);
  const [connections, setConnections] = useState<Data[]>([]);
  const [connectionError, setConnectionError] = useState<UiMessage | string>("");
  const [connectorId, setConnectorId] = useState("");
  const [connectorToken, setConnectorToken] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const panelActiveRef = useRef(panelActive);
  panelActiveRef.current = panelActive;
  const panelGeneration = useRef(0);
  useEffect(() => {
    panelGeneration.current++;
  }, [panelActive]);
  const actionRef = useRef(action);
  actionRef.current = action;
  useEffect(() => {
    if (selectedProject?.id === ownerId) return;
    listReturn.current = null;
    restoringList.current = false;
    setOwnerId(selectedProject?.id);
    setPreview(null);
    setProjectCheckMessages({});
  }, [selectedProject?.id, ownerId]);
  useEffect(() => {
    if (marketRequest) setRoute({ kind: "market", audience: "public" });
  }, [marketRequest]);
  const previousTab = useRef(initialTab);
  useEffect(() => {
    if (surface === "settings" && initialTab !== previousTab.current)
      setRoute({ kind: "installed", tab: initialTab });
    previousTab.current = initialTab;
  }, [surface, initialTab]);
  const api = useCallback(
    async <P extends ManagementRequest>(request: P) => {
      try {
        return await actionRef.current("manage", request);
      } finally {
        // Main clears its configuration gate before replying, including UNKNOWN.
        // Re-read only the catalog; keep the form's original submission receipt alive.
        if (request.operation === "pluginAuthCredential")
          window.dispatchEvent(new Event("areal-plugins-changed"));
      }
    },
    [projectId],
  );
  const {
    catalog,
    components,
    componentError,
    snapshot: storeSnapshot,
    supported,
    loading,
    readError,
    optionalReadErrors,
    allConnections,
    hookSources,
    detail,
    detailLoading,
    detailError,
    readiness,
    readinessError,
    refresh,
    readDetail,
    mounted,
    detailGeneration,
    setReadiness,
  } = usePluginCenter({ api, projectId, connected, active: panelActive, selected });
  const readinessReason = (value: PluginReadiness) =>
    t("settings.pluginCenter.requiredHostToolsUnavailable", {
      tools: value.missingTools.join(", "),
    }) +
    (value.missingTools.includes("computer_v1")
      ? ` ${t("settings.pluginCenter.enableNativeComputerProvider")}`
      : "");
  useEffect(() => {
    setPreview((current) => (current?.id === selected ? current : null));
    setInstallReview(false);
    setDetailsOpen(false);
    setScopeOpen(false);
    setSubmissionDetails(false);
    setCopiedDigest(false);
    setMetadataCopy(null);
    setConnections([]);
    setConnectorToken("");
    setCredentialRef("");
  }, [selected]);
  useEffect(() => {
    setInstallReview(false);
    setDetailsOpen(false);
    setScopeOpen(false);
    setSubmissionDetails(false);
    setCopiedDigest(false);
    setMetadataCopy(null);
  }, [detail?.installedDigest]);
  useEffect(() => {
    if (!panelActive || !connected || !projectId || !detail?.installed) {
      setConnections([]);
      return;
    }
    let current = true;
    setConnectionError("");
    setConnectionLoading(true);
    void api({ projectId, operation: "pluginMcp" })
      .then((result) => {
        if (current)
          setConnections(
            (Array.isArray(result.data) ? result.data : []).filter(
              (row: Data) =>
                row.pluginId === detail.id && row.installedDigest === detail.installedDigest,
            ),
          );
      })
      .catch((cause) => {
        if (current) setConnectionError(failure(cause).message);
      })
      .finally(() => {
        if (current) setConnectionLoading(false);
      });
    return () => {
      current = false;
    };
  }, [
    panelActive,
    connected,
    projectId,
    detail?.id,
    detail?.installedDigest,
    detail?.installed,
    api,
    catalog?.revision,
    busy,
    connectionReadKey,
  ]);
  const disabled =
    !connected ||
    busy ||
    loading ||
    !catalog ||
    !supported ||
    pending ||
    authPending ||
    !!error?.submissionUnknown;
  const acceptPreview = (result: Partial<PluginDetail> | undefined, operation: PluginOperation) => {
    const next = previewFromResult(result);
    if (!next || (operation.pluginId && next.id !== operation.pluginId)) {
      setPreview(null);
      setError({
        message: { id: "settings.pluginCenter.sourceResolutionCompletedButTheReturnedPreview" },
        operation,
      });
      return false;
    }
    setPreview(next);
    return true;
  };
  const writeContext = {
    projectId,
    connected,
    disabled,
    api,
    mounted,
    selectedRef,
    refresh,
    readDetail,
    onPreparing: (operation: PluginOperation) => {
      if (operation.mutation === "pluginResolve") setPreview(null);
    },
    onAccepted: (
      result:
        | import("@areal/workbench/desktop-contract/management").ManagementResponseMap[
            | import("@areal/workbench/desktop-contract/management").PluginMutation
            | "pluginAuth"]
        | undefined,
      original: PluginOperation,
      recovered: boolean,
    ) => {
      if (original.projectId !== currentProject.current) return true;
      const operation = original.mutation;
      if (operation === "pluginResolve" || operation === "pluginArchiveImport") {
        if (!acceptPreview(result && "sourceDigest" in result ? result : undefined, original))
          return false;
        if (operation === "pluginArchiveImport" && result && "sourceDigest" in result) {
          setArchive(null);
          setInstallReview(true);
          updateSelected(result.id);
          setRoute({ kind: "plugin", id: result.id, returnTo: listRoute });
        }
      }
      if (operation === "pluginSetup" && result && "thread" in result)
        setSetupThreadId(result.thread.id);
      if (operation === "marketplaceAdd" || operation === "marketplaceAddGit") {
        setAdding(false);
        setRoot("");
      }
      if (operation === "pluginInstall") setInstallReview(false);
      if (!recovered)
        setMessage(
          operation === "pluginAuth"
            ? ""
            : operation === "pluginSetup"
              ? { id: "settings.pluginCenter.theSetupSkillWasSubmittedReturnTo" }
              : ["pluginResolve", "pluginConnection", "pluginInstall"].includes(operation)
                ? ""
                : { id: "settings.pluginCenter.operationCompleted" },
        );
      return true;
    },
  };
  const mutate: import("./pluginTypes.js").PluginMutate = (values) =>
    writes.mutate(values, writeContext);
  const submissionAwaiting =
    !!submission &&
    submission.projectId === projectId &&
    blockingPending.some(
      (entry) =>
        entry.awaitingResponse === true &&
        entry.params?.requestId === submission.requestId &&
        pluginMethods[entry.method] === submission.mutation,
    );
  const pendingPlugin = blockingPending.find(
    (entry: Data) =>
      !entry.awaitingResponse &&
      pluginMethods[entry.method] &&
      typeof entry.params?.requestId === "string",
  );
  const recoverable: PluginOperation | null =
    (submissionAwaiting ? null : submission) ??
    (pendingPlugin
      ? {
          mutation: pluginMethods[pendingPlugin.method],
          projectId: projectId!,
          requestId: pendingPlugin.params.requestId,
          ...(typeof pendingPlugin.params.id === "string"
            ? { pluginId: pendingPlugin.params.id }
            : {}),
        }
      : null);
  const projectPendingEntries = blockingPending.filter(
    (entry) => !pluginMethods[entry.method] || typeof entry.params?.requestId !== "string",
  );
  const projectCheckOwner = useRef({ projectId, selectedProjectId: selectedProject?.id });
  projectCheckOwner.current = { projectId, selectedProjectId: selectedProject?.id };
  const checkProjectOperation = async () => {
    if (!projectId || active.current || !connected) return;
    const owner = projectCheckOwner.current;
    const generation = panelGeneration.current;
    const current = () =>
      mounted.current &&
      projectCheckOwner.current.projectId === owner.projectId &&
      projectCheckOwner.current.selectedProjectId === owner.selectedProjectId &&
      panelGeneration.current === generation;
    const entries = [...projectPendingEntries];
    active.current = true;
    setCheckingProjectOperation(true);
    setProjectCheckMessages({});
    try {
      for (const [index, entry] of entries.entries()) {
        const requestId = entry.params?.requestId;
        const key = requestId ?? String(index);
        let resultMessage: UiMessage | string;
        if (typeof requestId !== "string" || !requestId) {
          resultMessage = { id: "settings.pluginCenter.originalRequestIdUnavailable" };
        } else {
          try {
            const result = await actionRef.current("reconcile", { projectId, requestId });
            const outcome = recoveredOutcome(
              result ?? {},
              requestId,
              entry.params?.threadId ?? "",
              entry.operation,
            );
            resultMessage = {
              id:
                outcome?.status === "failed"
                  ? "settings.pluginCenter.projectOperationConfirmedFailed"
                  : outcome?.status === "completed"
                    ? "settings.pluginCenter.projectOperationConfirmedComplete"
                    : "settings.pluginCenter.projectOperationStillUnconfirmed",
            };
          } catch (cause) {
            resultMessage = {
              id: "settings.pluginCenter.couldNotCheckTheOriginalSubmissionValue",
              values: { value0: failureText(failure(cause), t) },
            };
          }
        }
        if (!current()) return;
        setProjectCheckMessages((previous) => ({ ...previous, [key]: resultMessage }));
      }
      if (current()) await refresh();
    } finally {
      if (mounted.current) setCheckingProjectOperation(false);
      active.current = false;
    }
  };
  const projectRecoveryDetails = (
    <div className="grid gap-2">
      {projectPendingEntries.map((entry, index) => {
        const threadId = entry.params?.threadId ?? entry.operation?.threadId;
        return (
          <div key={entry.params?.requestId ?? index}>
            <p className="break-all text-ui-sm">
              {entry.method}
              {entry.params?.requestId && (
                <> · {t("settings.pluginCenter.requestId", { value0: entry.params.requestId })}</>
              )}
            </p>
            <Feedback message={projectCheckMessages[entry.params?.requestId ?? String(index)]} />
            {threadId && project?.state?.threads?.[threadId] && onOpenThread && (
              <Button variant="ghost" onClick={() => onOpenThread(projectId!, threadId)}>
                {t("settings.pluginCenter.openOperationConversation")}
              </Button>
            )}
          </div>
        );
      })}
      <Button
        variant="outline"
        disabled={!connected || busy || loading}
        onClick={() => void checkProjectOperation()}
      >
        {t(
          checkingProjectOperation
            ? "settings.pluginCenter.checkingProjectOperation"
            : "settings.pluginCenter.checkProjectOperation",
        )}
      </Button>
    </div>
  );
  const projectRecovery = projectPendingEntries.length > 0 && projectRecoveryDetails;
  const recoverSubmission = () =>
    recoverable ? writes.recover(recoverable, writeContext) : Promise.resolve();
  const recoveryButton = recoverable && (
    <Button variant="outline" disabled={busy || loading} onClick={() => void recoverSubmission()}>
      {recoverable?.mutation === "pluginConnection"
        ? t("settings.pluginCenter.checkConnectionResult")
        : t("settings.pluginCenter.checkPluginSubmission")}
    </Button>
  );
  const previewCurrent =
    !!detail &&
    !!preview &&
    preview.id === detail.id &&
    preview.source === detail.source &&
    preview.sourceDigest === detail.sourceDigest &&
    reviewDigest(preview) === reviewDigest(detail) &&
    preview.revision === catalog?.revision;
  const pendingKind =
    blockingPending.some(
      (entry) =>
        entry.params?.id === selected &&
        pluginMethods[entry.method] &&
        entry.awaitingResponse !== true,
    ) ||
    (submission &&
      submission.projectId === projectId &&
      (!submission.pluginId || submission.pluginId === selected) &&
      !submissionAwaiting) ||
    (error?.submissionUnknown &&
      error.operation?.projectId === projectId &&
      (!error.operation?.pluginId || error.operation?.pluginId === selected) &&
      !submissionAwaiting)
      ? "unknown"
      : blockingPending.some(
            (entry) => entry.params?.id === selected && pluginMethods[entry.method],
          ) ||
          (busy && activity?.projectId === projectId && activity?.pluginId === selected) ||
          submissionAwaiting
        ? "active"
        : "none";
  const pendingMessage =
    pendingKind === "unknown"
      ? blockingPending.some(
          (entry) =>
            entry.awaitingResponse !== true &&
            (!pluginMethods[entry.method] || typeof entry.params?.requestId !== "string"),
        ) || !recoverable
        ? t("settings.pluginCenter.aProjectOperationHasAnUnconfirmedResult")
        : t("settings.pluginCenter.theOriginalPluginSubmissionResultIsUnconfirmed")
      : pendingKind === "active"
        ? (activity?.kind === "submit" && activity.mutation === "marketplaceAddGit") ||
          blockingPending.some(
            (entry) =>
              entry.awaitingResponse === true && entry.method === "areal/marketplace/addGit",
          )
          ? t("settings.pluginCenter.addingPluginMarketplace")
          : t("settings.pluginCenter.aProjectOperationIsProcessingPleaseWait")
        : "";
  const displayedError =
    (error?.operation &&
      (error.operation.projectId !== projectId ||
        (error.operation.pluginId && error.operation.pluginId !== selected))) ||
    (error?.submissionUnknown && submissionAwaiting && error.requestId === submission?.requestId)
      ? null
      : error;
  const operationError = displayedError?.submissionUnknown ? "" : failureText(displayedError, t);
  const operationMessage = displayedError?.submissionUnknown
    ? failureText(displayedError, t)
    : message;
  const sourceRecovery = isSourceOperation(recoverable, projectId, detail?.id);
  const checkingSource =
    activity?.kind === "check" && isSourceOperation(activity, projectId, detail?.id);
  const resolvingSource =
    (activity?.kind === "submit" && isSourceOperation(activity, projectId, detail?.id)) ||
    (submissionAwaiting && isSourceOperation(submission, projectId, detail?.id)) ||
    blockingPending.some(
      (entry) =>
        entry.awaitingResponse === true &&
        entry.method === "areal/plugin/resolve" &&
        entry.params?.id === detail?.id,
    );
  const sourceFailure = isSourceOperation(displayedError?.operation, projectId, detail?.id)
    ? displayedError
    : null;
  const sourceError =
    !checkingSource && !resolvingSource && !sourceRecovery && !sourceFailure?.submissionUnknown
      ? failureText(sourceFailure, t)
      : "";
  const sourceMessage = checkingSource
    ? t("settings.pluginCenter.checkingTheOriginalSourceResolution")
    : resolvingSource
      ? t("settings.pluginCenter.resolvingSource")
      : sourceRecovery
        ? t("settings.pluginCenter.theSourceResolutionResultIsUnconfirmedAnd")
        : sourceFailure?.submissionUnknown
          ? failureText(sourceFailure, t)
          : sourceError
            ? ""
            : pendingMessage ||
              (previewCurrent
                ? t("settings.pluginCenter.sourceResolvedReviewTheDigestBeforeInstalling")
                : "");
  const install = () => {
    if (!previewCurrent || !preview) return;
    void mutate({
      operation: "pluginInstall",
      id: preview.id,
      source: preview.source,
      expectedDigest: reviewDigest(preview),
      scope,
      expectedRevision: preview.revision,
    });
  };
  const saveConnectorCredential = async () => {
    if (!detail?.installedDigest || !connectorId.trim() || !connectorToken || credentialBusy)
      return;
    const requestId = crypto.randomUUID();
    const secret = connectorToken;
    setConnectorToken("");
    setCredentialBusy(true);
    setError(null);
    try {
      const saved = await api({
        projectId,
        operation: "connectorCredential",
        id: detail.id,
        connectorId: connectorId.trim(),
        provider: "github",
        expectedDigest: detail.installedDigest,
        secret,
        requestId,
      });
      if (typeof saved.credentialRef !== "string" || !saved.credentialRef)
        throw new UiMessageError({
          id: "settings.pluginCenter.savingCredentialsDidNotReturnAProtected",
        });
      setCredentialRef(saved.credentialRef);
      setMessage({ id: "settings.pluginCenter.githubConnectorConfigurationSavedConnectThePlugin" });
      window.dispatchEvent(new Event("areal-plugins-changed"));
      await refresh();
    } catch (cause) {
      const error = failure(cause);
      if (error.submissionUnknown)
        setSubmission({
          mutation: "connectorConfigure",
          projectId: projectId!,
          requestId: error.requestId ?? requestId,
        });
      setError(error);
    } finally {
      setCredentialBusy(false);
    }
  };
  const copyMetadataLink = async (url: string | undefined, name: string) => {
    if (url === undefined) return;
    try {
      await navigator.clipboard.writeText(url);
      setMetadataCopy({ kind: "copied", name });
    } catch {
      setMetadataCopy({ kind: "failed", name });
    }
  };
  const closeDetail = () =>
    navigate(() => {
      restoringList.current = true;
      setMessage("");
      setRoute(listRoute);
    });
  useEffect(() => {
    const target = listReturn.current;
    if (
      !restoringList.current ||
      !panelActive ||
      !target ||
      target.projectId !== projectId ||
      projectId !== selectedProject?.id ||
      target.route !== route ||
      loading
    )
      return;
    const frame = requestAnimationFrame(() => {
      if (scrollRegion.current) scrollRegion.current.scrollTop = target.scrollTop;
      (pluginRows.current.get(target.pluginId) ?? searchInput.current)?.focus({
        preventScroll: true,
      });
      restoringList.current = false;
      listReturn.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [panelActive, projectId, selectedProject?.id, route, loading]);
  const catalogRevision = () => {
    if (!catalog) throw new UiMessageError({ id: "settings.pluginCenter.pluginOperationFailed" });
    return catalog.revision;
  };
  const installed = (catalog?.data ?? []).filter((item) => item.installed);
  const packageSkills: CenterSkill[] = installed.flatMap((item) =>
    (item.installedSkills ?? []).map((skill) => ({
      ...skill,
      key: `${item.id}:${item.installedDigest}:${skill.id}`,
      enabled:
        item.enabled &&
        !item.componentChoices?.disabledSkills?.includes(skill.id) &&
        !supportBlocked(item.installedComponentSupport, item.installedDigest),
      sourceLabel: {
        id: "settings.pluginCenter.pluginsValue",
        values: {
          value0: item.installedMetadata?.displayName || item.installedMetadata?.name || item.id,
        },
      },
      pluginId: item.id,
      projectId,
      scope: "plugin",
    })),
  );
  const pluginServers = allConnections.flatMap((row) => {
    const owner = installed.find(
      (item) => item.id === row.pluginId && item.installedDigest === row.installedDigest,
    );
    return owner
      ? (row.servers ?? []).map((server: Data) => ({
          key: `${row.pluginId}:${row.installedDigest}:${server.serverId}`,
          serverId: server.serverId,
          state: server.state ?? row.state,
          owner: {
            pluginId: owner.id,
            pluginName: owner.displayName || owner.name,
            installedDigest: owner.installedDigest!,
            enabled: owner.enabled,
            compatibilityBlocked: supportBlocked(
              owner.installedComponentSupport,
              owner.installedDigest,
            ),
          },
        }))
      : [];
  });
  const audience = listRoute.kind === "market" ? listRoute.audience : "personal";
  const markets = catalog?.marketplaces ?? [];
  const marketFor = (item: PluginDetail) =>
    markets.find((market) => item.id.endsWith(`@${market.name}`));
  const items = (catalog?.data ?? []).filter(
    (item) =>
      (listRoute.kind !== "installed" || item.installed) &&
      (listRoute.kind !== "market" ||
        (audience === "public"
          ? officialMarket(marketFor(item)?.sourceUrl)
          : !officialMarket(marketFor(item)?.sourceUrl))) &&
      `${item.displayName} ${item.name} ${item.id} ${item.description}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const openSkill = (skill: CenterSkill) =>
    navigateRoute({ kind: "skill", skill, returnTo: listRoute });
  const createSkill = async () => {
    if (draftBusy) return;
    setDraftBusy(true);
    setError(null);
    try {
      if (!project || project.projectless)
        throw new UiMessageError({ id: "settings.pluginCenter.selectAProjectInWhichToCreate" });
      await onStartDraft({ kind: "creator", projectId: project.id });
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setDraftBusy(false);
    }
  };
  const startPluginDraft = async (plugin: PluginDetail, text: string) => {
    if (draftBusy) return;
    const generation = detailGeneration.current;
    const activity = panelGeneration.current;
    setDraftBusy(true);
    setError(null);
    try {
      if (
        !plugin.installed ||
        !plugin.installedDigest ||
        !plugin.enabled ||
        supportBlocked(plugin.installedComponentSupport, plugin.installedDigest)
      )
        throw new UiMessageError({ id: "settings.pluginCenter.hostReadinessUnavailable" });
      const fresh: PluginReadiness = await api({
        projectId,
        operation: "pluginReadiness",
        id: plugin.id,
        expectedDigest: plugin.installedDigest,
      });
      if (
        !mounted.current ||
        !panelActiveRef.current ||
        activity !== panelGeneration.current ||
        generation !== detailGeneration.current ||
        selectedRef.current !== plugin.id
      )
        return;
      setReadiness(fresh);
      if (fresh.pluginId !== plugin.id || fresh.installedDigest !== plugin.installedDigest)
        throw new UiMessageError({ id: "settings.pluginCenter.hostReadinessUnavailable" });
      if (!fresh.available) throw new Error(readinessReason(fresh));
      const metadata = plugin.installed ? plugin.installedMetadata : plugin;
      if (!metadata) throw new UiMessageError({ id: "settings.pluginCenter.loadingPluginDetails" });
      await onStartDraft({
        text: `${buildPluginMentionMarkdown(metadata.displayName || metadata.name, plugin.id)} ${text}`,
        plugin: { id: plugin.id },
      });
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setDraftBusy(false);
    }
  };
  const pickArchive = async () => {
    setError(null);
    try {
      const selection = await api({ projectId, operation: "pluginArchivePick" });
      if (!("canceled" in selection)) setArchive(selection);
    } catch (cause) {
      setError(failure(cause));
    }
  };
  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            disabled={disabled}
            aria-label={t("settings.pluginCenter.addResource")}
          >
            {t("settings.pluginCenter.add")}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setAdding(true)}>
          <Store size={16} />
          {t("settings.pluginCenter.addMarketplace")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            navigate(() => {
              setRoute({ kind: "installed", tab: "mcp" });
              setMcpAddRequest((value) => value + 1);
            })
          }
        >
          <Plug size={16} />
          {t("settings.pluginCenter.addMCP")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void pickArchive()}>
          <Upload size={16} />
          {t("settings.pluginCenter.uploadPluginPackage")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const showPlugins =
    listRoute.kind === "market" || (listRoute.kind === "installed" && listRoute.tab === "plugins");
  const isDetail = route.kind === "plugin" || route.kind === "skill";
  const managing = !!detail?.installed || surface === "settings";
  const detailSnapshot = connections.find(
    (row) => row.pluginId === detail?.id && row.installedDigest === detail?.installedDigest,
  );
  const detailContent = detail?.installed ? detail.installedMetadata : detail;
  const detailInterface = pluginInterface(detailContent?.interface);
  const catalogInterface = pluginInterface(detail?.interface);
  const detailSkills = detail
    ? detail.installed
      ? (detail.installedSkills ?? [])
      : detail.skills
    : [];
  const hostReady =
    readiness?.pluginId === detail?.id &&
    readiness?.installedDigest === detail?.installedDigest &&
    readiness?.available === true;
  const candidateDigest = detail ? reviewDigest(detail) : null;
  const catalogChanged = !!detail?.installed && detail.installedDigest !== candidateDigest;
  const detailDigest = detail?.installed ? detail.installedDigest : candidateDigest;
  const detailSupport = detail?.installed
    ? detail.installedComponentSupport
    : detail?.componentSupport;
  const declaredMcp =
    detailSupport?.components.some((row) => row.kind === "mcp") ||
    detailContent?.components.includes("mcp");
  const connectionManagement =
    declaredMcp || !!detailSnapshot?.connectors.length || !!detailSnapshot?.diagnostics?.length;
  const componentWarning =
    detailSupport?.components.some((row) => row.status !== "supported") ||
    detailSupport?.compatibility.state === "blocked";
  const detailPresentation = detail
    ? presentPlugin({
        detail,
        runtimeObserved: connected,
        projectSelected: !!projectId,
        runtimeDiagnostics: components?.agentDiagnostics,
        connection: connectionFacts,
        hostAvailable:
          readiness?.pluginId === detail.id && readiness.installedDigest === detail.installedDigest
            ? readiness.available
            : undefined,
        submission: recoverable?.projectId === projectId ? recoverable : null,
      })
    : null;
  const connectProject = async () => {
    if (!projectId || connectingProject) return;
    const owner = projectId;
    setConnectingProject(true);
    setError(null);
    try {
      await actionRef.current("connect", { projectId: owner });
    } catch (cause) {
      if (currentProject.current === owner) setError(failure(cause));
    } finally {
      setConnectingProject(false);
    }
  };
  const configureComponent = (kind: "skill" | "mcpServer", id: string, enabled: boolean) => {
    if (!detail?.installedDigest) return;
    void mutate({
      operation: "pluginComponentConfigure",
      id: detail.id,
      component: { kind, id },
      enabled,
      expectedRevision: detail.revision,
      expectedDigest: detail.installedDigest,
    });
  };
  const title =
    route.kind === "plugin"
      ? detailContent?.displayName || detailContent?.name || selected
      : route.kind === "skill"
        ? route.skill.name
        : listRoute.kind === "market"
          ? t("settings.pluginCenter.pluginMarketplace")
          : listRoute.kind === "skills"
            ? "Skills"
            : t("settings.pluginCenter.plugins");
  return (
    <div
      className={`plugin-center ${surface === "settings" ? "plugin-center-settings" : "plugin-center-workspace"}`}
      hidden={!panelActive}
    >
      {surface === "workspace" && (
        <aside
          className="plugin-center-sidebar"
          aria-label={t("settings.pluginCenter.pluginNavigation")}
        >
          <div className="plugin-center-sidebar-title">AReaL Harness</div>
          <small className="plugin-nav-label">{t("settings.pluginCenter.extensions")}</small>
          <Button
            unstyled
            data-slot={undefined}
            type="submit"
            aria-current={listRoute.kind === "market" && !isDetail ? "page" : undefined}
            onClick={() => navigateRoute({ kind: "market", audience: "public" })}
          >
            <SettingsPluginIcon width={15} height={15} />
            {t("settings.pluginCenter.pluginMarketplace")}
          </Button>
          <Button
            unstyled
            data-slot={undefined}
            type="submit"
            aria-current={listRoute.kind === "skills" && !isDetail ? "page" : undefined}
            onClick={() => navigateRoute({ kind: "skills" })}
          >
            <Box size={15} strokeWidth={1.5} />
            Skills
          </Button>
          <small className="plugin-nav-label plugin-installed-label">
            {t("settings.pluginCenter.installed")}
          </small>
          <div className="plugin-installed-shortcuts">
            {installed.map((item) => (
              <Button
                unstyled
                data-slot={undefined}
                type="submit"
                key={item.id}
                aria-current={route.kind === "plugin" && selected === item.id ? "page" : undefined}
                onClick={() => setSelected(item.id)}
              >
                <Package size={16} />
                <span>
                  {item.installedMetadata?.displayName || item.installedMetadata?.name || item.id}
                </span>
              </Button>
            ))}
          </div>
          <Button
            unstyled
            data-slot={undefined}
            type="submit"
            className="plugin-center-manage"
            onClick={() => navigate(onSettings)}
          >
            {t("settings.pluginCenter.manageInstalled")}
          </Button>
        </aside>
      )}
      <div className="plugin-center-scroll" ref={scrollRegion} aria-busy={loading}>
        <div className={`plugin-center-content ${isDetail ? "plugin-center-detail" : ""}`}>
          {onReturnToTask && (
            <Button variant="ghost" size="sm" className="mb-4" onClick={onReturnToTask}>
              <ArrowLeft size={15} />
              {t("settings.pluginCenter.returnToTask")}
            </Button>
          )}
          {isDetail ? (
            <nav className="plugin-breadcrumb" aria-label={t("settings.pluginCenter.breadcrumb")}>
              <Button
                unstyled
                data-slot={undefined}
                type="submit"
                aria-label={t("settings.pluginCenter.backToPluginList")}
                onClick={closeDetail}
              >
                <ArrowLeft size={15} />
                {listRoute.kind === "installed"
                  ? t("settings.pluginCenter.pluginSettings")
                  : listRoute.kind === "skills"
                    ? "Skills"
                    : t("settings.pluginCenter.pluginMarketplace")}
              </Button>
              <ChevronRight size={13} />
              <span>{title}</span>
            </nav>
          ) : (
            <>
              {!(surface === "workspace" && listRoute.kind === "skills") && (
                <header className="plugin-center-header">
                  <div>
                    {project && (
                      <p className="plugin-management-context" title={project.root}>
                        {t("settings.pluginCenter.managedProjectName", {
                          name: project.name || project.root?.split(/[\\/]/).pop(),
                        })}
                      </p>
                    )}
                    <h1>{title}</h1>
                    <p>
                      {listRoute.kind === "market"
                        ? t("settings.pluginCenter.discoverAndInstallPluginsToExtendAReaL")
                        : listRoute.kind === "skills"
                          ? t("settings.pluginCenter.addReusableExpertiseForDifferentTasks")
                          : t("settings.pluginCenter.manageInstalledPluginsMCPServersAndSkills")}
                    </p>
                  </div>
                  <div className="plugin-center-toolbar">
                    {(showPlugins ||
                      (listRoute.kind === "installed" && listRoute.tab === "markets")) && (
                      <SettingsSearchInput
                        ref={searchInput}
                        containerClassName="plugin-center-search"
                        aria-label={t("settings.pluginCenter.searchPluginPackages")}
                        placeholder={t("settings.pluginCenter.searchPlugins")}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        onClear={() => setQuery("")}
                        clearLabel={t("settings.pluginCenter.clearPluginSearch")}
                      />
                    )}
                    {listRoute.kind === "skills" ? (
                      <Button disabled={draftBusy} onClick={() => void createSkill()}>
                        {t("settings.pluginCenter.createSkill")}
                      </Button>
                    ) : (
                      <>
                        {surface === "settings" && (
                          <Button variant="outline" onClick={() => navigate(onMarket)}>
                            {t("settings.pluginCenter.browseMarketplace")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("settings.pluginCenter.refreshMarketplace")}
                          disabled={!connected || busy || loading}
                          onClick={() => void refresh()}
                        >
                          <RefreshCw size={16} />
                        </Button>
                        {addMenu}
                      </>
                    )}
                  </div>
                </header>
              )}
              {listRoute.kind === "market" && (
                <SettingsSegmentedTabs
                  ariaLabel={t("settings.pluginCenter.marketplaceScope")}
                  items={[
                    { label: t("settings.pluginCenter.public"), value: "public" },
                    { label: t("settings.pluginCenter.personal"), value: "personal" },
                  ]}
                  value={audience}
                  onValueChange={(value) => {
                    setQuery("");
                    navigateRoute({ kind: "market", audience: value as "public" | "personal" });
                  }}
                />
              )}
              {listRoute.kind === "installed" && (
                <SettingsSegmentedTabs
                  ariaLabel={t("settings.pluginCenter.installedResourceType")}
                  activateOnFocus={false}
                  items={[
                    { label: t("settings.pluginCenter.plugins"), value: "plugins" },
                    { label: "MCP", value: "mcp" },
                    { label: "Skills", value: "skills" },
                    { label: t("settings.pluginCenter.marketplace"), value: "markets" },
                  ]}
                  value={listRoute.tab}
                  onValueChange={(value) => {
                    setQuery("");
                    navigateRoute({
                      kind: "installed",
                      tab: value as "plugins" | "mcp" | "skills" | "markets",
                    });
                  }}
                />
              )}
            </>
          )}
          {projectId !== selectedProject?.id && (
            <Feedback
              message={t("settings.pluginCenter.preservingTheOriginalSubmissionForProjectValue", {
                value0: project?.name || project?.root || ownerId,
              })}
            />
          )}
          <Feedback
            message={
              storeSnapshot
                ? t("settings.pluginCenter.snapshotScope", {
                    scope:
                      storeSnapshot.scope.kind === "user"
                        ? t("settings.pluginCenter.user")
                        : storeSnapshot.scope.workspace,
                    revision: storeSnapshot.revision,
                    time: new Date(storeSnapshot.observedAt).toLocaleString(),
                  })
                : ""
            }
          />
          {(!project || !connected) && (
            <>
              <Feedback message={t("settings.pluginCenter.runtimeNotObserved")} />
              {(!isDetail || pendingKind === "unknown" || pendingKind === "active") && (
                <Button
                  variant="outline"
                  disabled={connectingProject}
                  onClick={() => {
                    if (projectId) void connectProject();
                    else onChooseProject();
                  }}
                >
                  {t(
                    projectId
                      ? "settings.pluginCenter.connectProjectBackend"
                      : "settings.pluginCenter.chooseProjectToInstall",
                  )}
                </Button>
              )}
            </>
          )}
          {supported === false && (
            <Feedback error={t("settings.pluginCenter.thisCoreDoesNotSupportThePlugin")} />
          )}
          {!isDetail && <Feedback error={operationError} message={operationMessage} />}
          <Feedback error={readError} />
          <Feedback
            message={
              loading
                ? t(
                    catalog
                      ? "settings.pluginCenter.refreshingCatalog"
                      : "settings.pluginCenter.loadingCatalog",
                  )
                : ""
            }
          />
          <Feedback
            error={
              optionalReadErrors.connections
                ? t("settings.pluginCenter.connectionsUnavailable", {
                    error: formatUiMessage(t, optionalReadErrors.connections),
                  })
                : ""
            }
          />
          <Feedback
            error={
              optionalReadErrors.hooks
                ? t("settings.pluginCenter.hooksUnavailable", {
                    error: formatUiMessage(t, optionalReadErrors.hooks),
                  })
                : ""
            }
          />
          {surface === "settings" &&
            !isDetail &&
            listRoute.kind === "installed" &&
            listRoute.tab === "plugins" &&
            hookSources.length > 0 && (
              <SettingsDisclosure
                title={<> {t("settings.pluginCenter.advancedStandaloneHooks")}</>}
              >
                {hookSources.map((source) => (
                  <SettingsDisclosure
                    key={source.id}
                    className="settings-section"
                    title={
                      <>
                        {" "}
                        {source.id === "__hooks_user__"
                          ? t("settings.pluginCenter.userHooks")
                          : t("settings.pluginCenter.projectHooks")}{" "}
                        ·{" "}
                        {source.enabled
                          ? t("settings.pluginCenter.globalToggleEnabled")
                          : t("settings.pluginCenter.globalToggleDisabled")}{" "}
                      </>
                    }
                  >
                    <p className="text-ui-sm break-all">{source.origin}</p>
                    <PluginHookSettings
                      projectId={projectId}
                      id={source.id}
                      installedDigest={source.digest}
                      disabled={disabled}
                      api={api}
                      refreshKey={catalog?.revision}
                      onConfigure={async (params) => {
                        await mutate({ operation: "pluginHooksConfigure", ...params });
                      }}
                    />
                  </SettingsDisclosure>
                ))}
              </SettingsDisclosure>
            )}
          {!isDetail && (
            <PluginDoctorSummary key={projectId ?? "user"} command={api} projectId={projectId} />
          )}
          {!isDetail && !adding && recoveryButton}
          {!isDetail && setupThreadId && onOpenThread && (
            <Button onClick={() => onOpenThread(projectId, setupThreadId)}>
              {t("settings.pluginCenter.openSetupConversation")}
            </Button>
          )}
          {!isDetail && <Feedback message={pendingMessage} />}
          {!isDetail && projectRecovery}
          {!!catalog?.errors.length && (
            <div role="status">
              {catalog.errors.map((text, index) => (
                <p key={index}>{text}</p>
              ))}
            </div>
          )}
          {!isDetail && showPlugins && (
            <div
              className={
                listRoute.kind === "installed" ? "plugin-compact-list" : "plugin-market-groups"
              }
            >
              {(listRoute.kind === "installed"
                ? [{ key: "installed", value: null, label: t("settings.pluginCenter.installed") }]
                : [
                    ...new Set(
                      items.map((item) =>
                        audience === "personal"
                          ? marketFor(item)?.name || null
                          : pluginInterface(item.interface).category || null,
                      ),
                    ),
                  ].map((value) => ({
                    key: JSON.stringify([audience, value]),
                    value,
                    label:
                      value ||
                      t(
                        audience === "personal"
                          ? "settings.pluginCenter.importedPluginPackage"
                          : "settings.pluginCenter.plugins",
                      ),
                  }))
              ).map((group) => {
                const rows =
                  listRoute.kind === "installed"
                    ? items
                    : items.filter(
                        (item) =>
                          (audience === "personal"
                            ? marketFor(item)?.name || null
                            : pluginInterface(item.interface).category || null) === group.value,
                      );
                return (
                  <section className="plugin-market-group" key={group.key}>
                    <h2>{group.label}</h2>
                    <div
                      className={
                        listRoute.kind === "installed" || audience === "personal"
                          ? "plugin-row-list"
                          : "plugin-catalog-grid"
                      }
                    >
                      {rows.map((item) => (
                        <article
                          className="plugin-catalog-row"
                          key={item.id}
                          aria-label={t("settings.pluginCenter.valuePluginValue", {
                            value0: item.displayName || item.name,
                            value1: item.id,
                          })}
                        >
                          <Button
                            unstyled
                            data-slot={undefined}
                            type="submit"
                            className="plugin-row-info"
                            ref={(element) => {
                              if (element) pluginRows.current.set(item.id, element);
                              else pluginRows.current.delete(item.id);
                            }}
                            aria-label={t("settings.pluginCenter.viewPluginValue", {
                              value0: item.id,
                            })}
                            onClick={() => setSelected(item.id)}
                          >
                            <span className="plugin-resource-icon">
                              <Package size={20} />
                            </span>
                            <span>
                              <strong>{item.displayName || item.name}</strong>
                              <small>{item.description || item.id}</small>
                            </span>
                          </Button>
                          {listRoute.kind === "installed" ? (
                            <Switch
                              aria-label={t(
                                "settings.pluginCenter.valuePluginValueInTheCurrentProject",
                                {
                                  value0: item.enabled
                                    ? t("settings.pluginCenter.disable")
                                    : t("settings.pluginCenter.enable"),
                                  value1: item.id,
                                },
                              )}
                              checked={item.enabled}
                              disabled={disabled}
                              onCheckedChange={(enabled) =>
                                void mutate({
                                  operation: "pluginConfigure",
                                  id: item.id,
                                  scope: "project",
                                  enabled,
                                  expectedRevision: catalogRevision(),
                                })
                              }
                            />
                          ) : (
                            <Button
                              unstyled
                              data-slot={undefined}
                              type="submit"
                              className="plugin-row-action"
                              aria-label={t("settings.pluginCenter.valuePluginValue2", {
                                value0: item.installed
                                  ? t("settings.pluginCenter.manage")
                                  : t("settings.pluginCenter.add"),
                                value1: item.id,
                              })}
                              disabled={busy}
                              onClick={() => setSelected(item.id)}
                            >
                              {item.installed ? (
                                t("settings.pluginCenter.added")
                              ) : (
                                <Plus size={18} />
                              )}
                            </Button>
                          )}
                        </article>
                      ))}
                    </div>
                  </section>
                );
              })}
              {!loading && catalog && !items.length && (
                <div className="resource-empty">
                  <Package size={28} />
                  <strong>
                    {query
                      ? t("settings.pluginCenter.noMatchingPlugins")
                      : listRoute.kind === "installed"
                        ? t("settings.pluginCenter.noPluginsInstalled")
                        : audience === "public"
                          ? t("settings.pluginCenter.noOfficialPluginMarketplaceAdded")
                          : t("settings.pluginCenter.noPersonalPluginMarketplaceAdded")}
                  </strong>
                  <p>
                    {query
                      ? t("settings.pluginCenter.tryAnotherNameOrKeyword")
                      : t("settings.pluginCenter.addAMarketplaceToViewPluginContents")}
                  </p>
                  {!query && listRoute.kind === "market" && (
                    <Button
                      variant="outline"
                      disabled={disabled}
                      onClick={() => {
                        setAddKind(audience === "public" ? "git" : "local");
                        setRoot(
                          audience === "public" ? "https://github.com/openai/plugins.git" : "",
                        );
                        setAdding(true);
                      }}
                    >
                      {t("settings.pluginCenter.addPluginMarketplace")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
          {(route.kind === "skills" ||
            (route.kind === "installed" && route.tab === "skills") ||
            route.kind === "skill") && (
            <PluginSkillsPage
              active={panelActive}
              action={action}
              projects={projects}
              project={project}
              packageSkills={packageSkills}
              selected={route.kind === "skill" ? route.skill : null}
              onOpen={openSkill}
              onManagePlugin={setSelected}
              onStartDraft={onStartDraft}
              compact={listRoute.kind === "installed"}
              onCreate={() => void createSkill()}
              createBusy={draftBusy}
            />
          )}
          {!isDetail && listRoute.kind === "installed" && listRoute.tab === "mcp" && (
            <McpSettings
              project={project}
              thread={thread}
              action={action}
              scope={mcpScope}
              onScopeChange={setMcpScope}
              pluginServers={pluginServers}
              onManagePlugin={setSelected}
              onRefreshPlugins={refresh}
              addRequest={mcpAddRequest}
            />
          )}
          {!isDetail && listRoute.kind === "installed" && listRoute.tab === "markets" && (
            <div className="plugin-compact-list">
              {markets
                .filter((item) =>
                  `${item.name} ${item.sourceUrl || item.root}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((item) => (
                  <article className="plugin-catalog-row" key={item.root}>
                    <span className="plugin-resource-icon">
                      <Store size={19} />
                    </span>
                    <div className="plugin-market-info">
                      <strong>{item.name}</strong>
                      <small>{item.sourceUrl || item.root}</small>
                      {item.resolvedCommit && <small>{item.resolvedCommit}</small>}
                    </div>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() =>
                        void mutate({
                          operation: "marketplaceRemove",
                          root: item.root,
                          expectedRevision: catalogRevision(),
                        })
                      }
                    >
                      {t("settings.pluginCenter.removeSource")}
                    </Button>
                  </article>
                ))}
              <Button
                variant="outline"
                disabled={disabled}
                onClick={() =>
                  void mutate({
                    operation: "marketplaceUpdate",
                    expectedRevision: catalogRevision(),
                  })
                }
              >
                {t("settings.pluginCenter.refreshGitSourceSnapshot")}
              </Button>
            </div>
          )}
          {panelActive && archive && (
            <SettingsDialog
              title={t("settings.pluginCenter.uploadPluginPackage")}
              description={t("settings.pluginCenter.importAndInspectAZIPPluginPackage")}
              busy={busy}
              onClose={() => setArchive(null)}
            >
              <p>{archive.fileName}</p>
              <Feedback error={operationError} message={operationMessage || pendingMessage} />
              {recoveryButton}
              <div className="settings-form-actions">
                <Button variant="outline" disabled={busy} onClick={() => setArchive(null)}>
                  {t("settings.pluginCenter.cancel")}
                </Button>
                <Button
                  disabled={disabled}
                  onClick={() =>
                    void mutate({
                      operation: "pluginArchiveImport",
                      selectionToken: archive.selectionToken,
                      expectedRevision: catalogRevision(),
                    })
                  }
                >
                  {t("settings.pluginCenter.importAndPreview")}
                </Button>
              </div>
            </SettingsDialog>
          )}
          {panelActive && adding && (
            <SettingsDialog
              title={t("settings.pluginCenter.addPluginMarketplace")}
              description={t("settings.pluginCenter.chooseALocalDirectoryOrGitMarketplace")}
              busy={busy}
              onClose={() => setAdding(false)}
            >
              <form
                className="settings-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate({
                    ...(addKind === "git"
                      ? {
                          operation: "marketplaceAddGit",
                          url: root.trim(),
                          ...(gitRef.trim() ? { refName: gitRef.trim() } : {}),
                          ...(sparsePaths.trim()
                            ? {
                                sparsePaths: sparsePaths
                                  .split(/\r?\n/)
                                  .map((path) => path.trim())
                                  .filter(Boolean),
                              }
                            : {}),
                        }
                      : { operation: "marketplaceAdd", root: root.trim() }),
                    expectedRevision: catalogRevision(),
                  });
                }}
              >
                <div className="settings-choice-field">
                  {t("settings.pluginCenter.sourceType")}
                  <SettingsSelect
                    value={addKind}
                    onValueChange={(selectedValue) => {
                      setAddKind(selectedValue);
                      setRoot("");
                    }}
                    aria-label={t("settings.pluginCenter.sourceType")}
                  >
                    <option value="local">{t("settings.pluginCenter.localDirectory")}</option>
                    <option value="git">{t("settings.pluginCenter.gitRepository")}</option>
                  </SettingsSelect>
                  {addKind === "git"
                    ? t("settings.pluginCenter.gitUrl")
                    : t("settings.pluginCenter.marketplaceRootDirectory")}
                  <Input
                    autoFocus
                    required
                    value={root}
                    disabled={busy}
                    placeholder={
                      addKind === "git"
                        ? "https://github.com/owner/marketplace.git"
                        : "/path/to/marketplace"
                    }
                    onChange={(event) => setRoot(event.target.value)}
                  />
                </div>
                {addKind === "git" && (
                  <label>
                    {t("settings.pluginCenter.branchTagOrCommitOptional")}
                    <Input
                      value={gitRef}
                      onChange={(event) => setGitRef(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                )}
                {addKind === "git" && (
                  <label>
                    {t("settings.pluginCenter.sparseCheckoutPathsOptional")}
                    <Textarea
                      unstyled
                      data-slot={undefined}
                      rows={3}
                      value={sparsePaths}
                      onChange={(event) => setSparsePaths(event.target.value)}
                      placeholder={t("settings.pluginCenter.onePathRelativeToTheRepositoryRoot")}
                    />
                  </label>
                )}
                <Feedback error={operationError} message={operationMessage || pendingMessage} />
                {recoveryButton}
                <div className="settings-form-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setAdding(false)}
                  >
                    {t("settings.pluginCenter.cancel")}
                  </Button>
                  <Button type="submit" disabled={disabled || !root.trim()}>
                    {t("settings.pluginCenter.addDirectory")}
                  </Button>
                </div>
              </form>
            </SettingsDialog>
          )}
          {selected && (
            <article
              data-testid="plugin-detail-page"
              className="plugin-detail-page"
              hidden={route.kind !== "plugin" || !panelActive}
            >
              <header className="plugin-detail-header">
                <span className="plugin-resource-icon">
                  <Package size={30} />
                </span>
                <div>
                  <h1>{detailContent?.displayName || detailContent?.name || selected}</h1>
                  {detailInterface.developerName && <p>{detailInterface.developerName}</p>}
                  {detail && marketFor(detail) && (
                    <p className="plugin-source-label">
                      {t("settings.pluginCenter.sourceName", {
                        name: officialMarket(marketFor(detail)?.sourceUrl)
                          ? t("settings.pluginCenter.openaiPluginMarketplace")
                          : marketFor(detail)?.name,
                      })}
                    </p>
                  )}
                </div>
                <div className="plugin-detail-actions">
                  {detail && !detail.installed && !installReview && preview?.id !== detail.id && (
                    <Button
                      disabled={disabled || detailLoading}
                      onClick={() => {
                        setInstallReview(true);
                        void mutate({
                          operation: "pluginResolve",
                          id: detail.id,
                          expectedRevision: catalogRevision(),
                        });
                      }}
                    >
                      {t("settings.pluginCenter.installPlugin")}
                    </Button>
                  )}
                  {detail?.installed && (
                    <>
                      {managing ? (
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() =>
                            void mutate({
                              operation: "pluginUninstall",
                              id: detail.id,
                              expectedRevision: detail.revision,
                            })
                          }
                        >
                          {t("settings.pluginCenter.uninstallPlugin")}
                        </Button>
                      ) : null}
                      <Button
                        disabled={
                          disabled ||
                          draftBusy ||
                          !detailContent ||
                          !detail.enabled ||
                          !hostReady ||
                          supportBlocked(detail.installedComponentSupport, detail.installedDigest)
                        }
                        onClick={() =>
                          void startPluginDraft(
                            detail,
                            t("settings.pluginCenter.pleaseUseValueToHelpMeComplete", {
                              value0:
                                detailContent?.displayName || detailContent?.name || detail.id,
                            }),
                          )
                        }
                      >
                        {t("settings.pluginCenter.tryPlugin")}
                      </Button>
                    </>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("settings.pluginCenter.morePluginActions")}
                        >
                          <MoreHorizontal size={18} />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => void navigator.clipboard.writeText(detail?.id || selected)}
                      >
                        {t("settings.pluginCenter.copyPluginID")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </header>
              {detailLoading && !detail && (
                <p role="status">{t("settings.pluginCenter.loadingPluginDetails")}</p>
              )}
              <Feedback
                error={detailError || (pendingKind !== "unknown" ? displayedError?.message : "")}
              />
              {isDetail && projectRecovery}
              {detailError && (
                <Button variant="outline" onClick={() => void readDetail(selected)}>
                  {t("settings.pluginCenter.retryLoadingDetails")}
                </Button>
              )}
              {detail && (
                <div className="plugin-detail-body">
                  {pendingKind !== "unknown" && pendingKind !== "active" && !installReview && (
                    <PluginOverview
                      presentation={detailPresentation!}
                      disabled={
                        busy ||
                        loading ||
                        ((detailPresentation?.nextAction === "install" ||
                          detailPresentation?.nextAction === "enable") &&
                          disabled)
                      }
                      onNext={() => {
                        const next = detailPresentation?.nextAction;
                        if (next === "connectProject") {
                          void connectProject();
                          return;
                        }
                        if (next === "chooseProject") {
                          onChooseProject();
                          return;
                        }
                        if (next === "refresh") {
                          void refresh();
                          return;
                        }
                        if (next === "install") {
                          setInstallReview(true);
                          void mutate({
                            operation: "pluginResolve",
                            id: detail.id,
                            expectedRevision: catalogRevision(),
                          });
                          return;
                        }
                        if (next === "enable") {
                          void mutate({
                            operation: "pluginConfigure",
                            id: detail.id,
                            enabled: true,
                            scope: "project",
                            expectedRevision: catalogRevision(),
                          });
                          return;
                        }
                        if (next === "queryOriginal") {
                          void recoverSubmission();
                          return;
                        }
                        if (
                          next === "configure" &&
                          detail.userConfiguration?.missingRequired.length
                        ) {
                          document
                            .querySelector<HTMLElement>("[data-plugin-configuration]")
                            ?.scrollIntoView({ block: "nearest" });
                          return;
                        }
                        if (next === "connections" || next === "configure")
                          document
                            .querySelector<HTMLElement>("[data-plugin-connections]")
                            ?.scrollIntoView({ block: "nearest" });
                        else {
                          setDetailsOpen(true);
                          document
                            .querySelector<HTMLElement>("[data-plugin-components]")
                            ?.scrollIntoView({ block: "nearest" });
                        }
                      }}
                    />
                  )}
                  {pendingKind === "unknown" ? (
                    <section
                      className="plugin-status-panel"
                      aria-label={t("settings.pluginCenter.pluginSubmissionStatus")}
                    >
                      <h2>
                        {recoverable?.mutation === "pluginConnection"
                          ? t("settings.pluginCenter.connectionResultUnconfirmed")
                          : t("settings.pluginCenter.operationResultUnconfirmed")}
                      </h2>
                      <p className="plugin-status-description">
                        {projectPendingEntries.length
                          ? pendingMessage
                          : t("settings.pluginCenter.thePreviousOperationIsNotConfirmedComplete")}
                      </p>
                      <div className="plugin-service-row">
                        <div>
                          <strong>
                            {detailContent?.displayName || detailContent?.name || detail.id}
                          </strong>
                          <p>{t("settings.pluginCenter.resultUnconfirmed")}</p>
                        </div>
                        <div className="plugin-service-actions">
                          {recoveryButton}
                          <Button
                            variant="outline"
                            aria-expanded={submissionDetails}
                            aria-controls="plugin-submission-details"
                            onClick={() => setSubmissionDetails((value) => !value)}
                          >
                            {submissionDetails
                              ? t("settings.pluginCenter.hideThisSubmission")
                              : t("settings.pluginCenter.viewThisSubmission")}
                          </Button>
                        </div>
                      </div>
                      <p className="plugin-status-note">
                        {t("settings.pluginCenter.checkTheResultBeforeResubmittingOrChanging")}
                      </p>
                      {submissionDetails && (
                        <div id="plugin-submission-details">
                          <p>{pendingMessage}</p>
                          <pre>{failureText(displayedError, t) || recoverable?.requestId}</pre>
                        </div>
                      )}
                    </section>
                  ) : pendingKind === "active" && activity?.mutation !== "pluginAuth" ? (
                    <section
                      className="plugin-status-panel"
                      aria-label={t("settings.pluginCenter.pluginOperationProgress")}
                      aria-busy="true"
                    >
                      <h2>
                        {checkingSource
                          ? t("settings.pluginCenter.checkingTheOriginalSourceResolution")
                          : resolvingSource
                            ? t("settings.pluginCenter.resolvingSource")
                            : activity?.kind === "check"
                              ? t("settings.pluginCenter.checkingOriginalSubmission")
                              : activity?.mutation === "pluginConnection"
                                ? t("settings.pluginCenter.updatingConnection")
                                : t("settings.pluginCenter.processing")}
                      </h2>
                      <p className="plugin-status-description">
                        {t("settings.pluginCenter.pleaseWaitTheSubmissionWillNotBe")}
                      </p>
                    </section>
                  ) : installReview || (!detail.installed && preview?.id === detail.id) ? (
                    <PluginInstallReview
                      detail={detail}
                      preview={preview}
                      previewCurrent={previewCurrent}
                      sourceLabel={
                        marketFor(detail)?.sourceUrl ||
                        pluginInterface(detail.catalogSource).url ||
                        detail.source
                      }
                      sourceError={sourceError}
                      sourceMessage={sourceMessage}
                      scope={scope}
                      setScope={setScope}
                      project={project}
                      disabled={disabled}
                      busy={busy}
                      panelRef={installReviewPanel}
                      onInstall={install}
                      onResolve={() =>
                        void mutate({
                          operation: "pluginResolve",
                          id: detail.id,
                          expectedRevision: catalogRevision(),
                        })
                      }
                      onCancel={() => {
                        setInstallReview(false);
                        setPreview(null);
                      }}
                    />
                  ) : connected && managing && detail.installed && connectionManagement ? (
                    <PluginConnectionPanel
                      projectId={projectId}
                      key={`${projectId}:${detail.id}:${detail.installedDigest}`}
                      detail={{ ...detail, ...detailContent }}
                      snapshot={detailSnapshot}
                      loading={connectionLoading}
                      error={connectionError}
                      disabled={disabled || authPending}
                      command={api}
                      mutate={mutate}
                      onRefresh={() => {
                        setConnectionReadKey((value) => value + 1);
                        void refresh();
                        void readDetail(detail.id);
                      }}
                      summaryPlacement="components"
                      onFacts={onConnectionFacts}
                      onAuthActivity={onAuthActivity}
                      onComponentChange={(id, enabled) =>
                        configureComponent("mcpServer", id, enabled)
                      }
                      connectorConfiguration={
                        <SettingsDisclosure
                          title={t("settings.pluginCenter.githubConnectorConfiguration")}
                        >
                          <p>
                            {t(
                              "settings.pluginCenter.credentialsAreSavedInProtectedDesktopCredential",
                            )}
                          </p>
                          <label>
                            {t("settings.pluginCenter.originalConnectorID")}
                            <SettingsSelect
                              value={connectorId}
                              onValueChange={(value) => {
                                setConnectorId(value);
                                setCredentialRef("");
                              }}
                              disabled={disabled || credentialBusy}
                              aria-label={t("settings.pluginCenter.originalConnectorID")}
                            >
                              <option value="">
                                {t("settings.pluginCenter.selectADeclaredConnector")}
                              </option>
                              {connections.flatMap((row) =>
                                (row.connectors ?? []).map((item: Data) => (
                                  <option key={item.id} value={item.id}>
                                    {item.id}
                                  </option>
                                )),
                              )}
                            </SettingsSelect>
                          </label>
                          <label>
                            {t("settings.pluginCenter.githubAccessToken")}
                            <Input
                              type="password"
                              autoComplete="new-password"
                              value={connectorToken}
                              onChange={(event) => setConnectorToken(event.target.value)}
                              disabled={disabled || credentialBusy}
                            />
                          </label>
                          <Button
                            variant="outline"
                            disabled={
                              disabled ||
                              credentialBusy ||
                              !connectorId ||
                              !connectorToken ||
                              connections.some(
                                (row) => row.state === "connected" || row.state === "partial",
                              )
                            }
                            onClick={() => void saveConnectorCredential()}
                          >
                            {t("settings.pluginCenter.saveSecurelyAndConfigureGitHub")}
                          </Button>
                          {credentialRef && (
                            <p role="status">
                              {t("settings.pluginCenter.protectedCredentialsConfigured")}
                            </p>
                          )}
                        </SettingsDisclosure>
                      }
                    />
                  ) : null}
                  {!managing && (
                    <>
                      {(detailInterface.longDescription || detailContent?.description) && (
                        <p className="plugin-long-description">
                          {detailInterface.longDescription || detailContent?.description}
                        </p>
                      )}
                      {Array.isArray(detailInterface.defaultPrompt) &&
                        detailInterface.defaultPrompt.length > 0 && (
                          <section className="plugin-detail-resources">
                            <h2>{t("settings.pluginCenter.usageExamples")}</h2>
                            <div className="plugin-usage-examples">
                              {detailInterface.defaultPrompt.map((text: string) => (
                                <Button
                                  key={text}
                                  variant="outline"
                                  disabled={
                                    !detail.installed ||
                                    disabled ||
                                    !detail.enabled ||
                                    draftBusy ||
                                    !hostReady ||
                                    supportBlocked(
                                      detail.installedComponentSupport,
                                      detail.installedDigest,
                                    )
                                  }
                                  onClick={() => void startPluginDraft(detail, text)}
                                >
                                  {text}
                                </Button>
                              ))}
                            </div>
                          </section>
                        )}
                      {detailSkills.length > 0 && (
                        <section aria-label="Skills" className="plugin-detail-resources">
                          <h2>Skills</h2>
                          <ul className="plugin-component-list">
                            {detailSkills.map((skill) => (
                              <li key={skill.id}>
                                <strong>{skill.name}</strong>
                                <p>{skill.description}</p>
                                {detail.installed &&
                                  detail.componentChoices?.disabledSkills?.includes(skill.id) && (
                                    <p>{t("settings.pluginCenter.componentOffInProject")}</p>
                                  )}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}
                      {declaredMcp && (
                        <section
                          className="plugin-detail-resources"
                          aria-label={t("settings.pluginCenter.mcpConnections")}
                        >
                          <h2>{t("settings.pluginCenter.mcpConnections")}</h2>
                          {detail.installed && detailSnapshot ? (
                            <>
                              {detailSnapshot.servers.map((server: Data) => (
                                <div className="plugin-content-connection" key={server.serverId}>
                                  <strong>{server.config?.title || server.serverId}</strong>
                                  <p>{pluginMcpStateLabel(server.state, t)}</p>
                                  {["required", "optional", "none"].includes(
                                    server.authentication,
                                  ) && (
                                    <p>
                                      {t(
                                        server.authentication === "required"
                                          ? "settings.pluginCenter.declaredAuthenticationRequired"
                                          : server.authentication === "optional"
                                            ? "settings.pluginCenter.declaredAuthenticationOptional"
                                            : "settings.pluginCenter.declaredNoAuthentication",
                                      )}
                                    </p>
                                  )}
                                </div>
                              ))}
                              {!detailSnapshot.servers.length && (
                                <p>{t("settings.pluginCenter.mcpDeclarationNeedsReview")}</p>
                              )}
                            </>
                          ) : detail.installed ? (
                            <>
                              <Feedback error={connectionError} />
                              <p>
                                {t(
                                  connectionLoading
                                    ? "settings.pluginConnectionPanel.loadingConnectionStatus"
                                    : "settings.pluginCenter.mcpDeclarationNeedsReview",
                                )}
                              </p>
                            </>
                          ) : (
                            <p>{t("settings.pluginCenter.mcpDeclaredInstallToReview")}</p>
                          )}
                          <p className="plugin-status-note">
                            {t("settings.pluginCenter.installDoesNotConnect")}
                          </p>
                        </section>
                      )}
                      {(detailInterface.developerName ||
                        detailInterface.category ||
                        detailContent?.version ||
                        detailInterface.websiteUrl ||
                        detailInterface.privacyPolicyUrl ||
                        detailInterface.termsOfServiceUrl) && (
                        <section className="plugin-detail-resources">
                          <h2>{t("settings.pluginCenter.pluginInformation")}</h2>
                          <dl className="plugin-metadata">
                            {detailInterface.developerName && (
                              <>
                                <dt>{t("settings.pluginCenter.developer")}</dt>
                                <dd>{detailInterface.developerName}</dd>
                              </>
                            )}
                            {detailInterface.category && (
                              <>
                                <dt>{t("settings.pluginCenter.category")}</dt>
                                <dd>{detailInterface.category}</dd>
                              </>
                            )}
                            {detailContent?.version && (
                              <>
                                <dt>{t("settings.pluginCenter.packageVersion")}</dt>
                                <dd>{detailContent?.version}</dd>
                              </>
                            )}
                            {detailInterface.websiteUrl && (
                              <>
                                <dt>{t("settings.pluginCenter.website")}</dt>
                                <dd className="plugin-metadata-link">
                                  <span>{detailInterface.websiteUrl}</span>
                                  <Button
                                    variant="link"
                                    aria-label={t("settings.pluginCenter.copyMetadataLink", {
                                      name: t("settings.pluginCenter.website"),
                                    })}
                                    onClick={() =>
                                      void copyMetadataLink(
                                        detailInterface.websiteUrl,
                                        t("settings.pluginCenter.website"),
                                      )
                                    }
                                  >
                                    {t("settings.pluginCenter.copyLink")}
                                  </Button>
                                </dd>
                              </>
                            )}
                            {detailInterface.privacyPolicyUrl && (
                              <>
                                <dt>{t("settings.pluginCenter.privacyPolicy")}</dt>
                                <dd className="plugin-metadata-link">
                                  <span>{detailInterface.privacyPolicyUrl}</span>
                                  <Button
                                    variant="link"
                                    aria-label={t("settings.pluginCenter.copyMetadataLink", {
                                      name: t("settings.pluginCenter.privacyPolicy"),
                                    })}
                                    onClick={() =>
                                      void copyMetadataLink(
                                        detailInterface.privacyPolicyUrl,
                                        t("settings.pluginCenter.privacyPolicy"),
                                      )
                                    }
                                  >
                                    {t("settings.pluginCenter.copyLink")}
                                  </Button>
                                </dd>
                              </>
                            )}
                            {detailInterface.termsOfServiceUrl && (
                              <>
                                <dt>{t("settings.pluginCenter.termsOfService")}</dt>
                                <dd className="plugin-metadata-link">
                                  <span>{detailInterface.termsOfServiceUrl}</span>
                                  <Button
                                    variant="link"
                                    aria-label={t("settings.pluginCenter.copyMetadataLink", {
                                      name: t("settings.pluginCenter.termsOfService"),
                                    })}
                                    onClick={() =>
                                      void copyMetadataLink(
                                        detailInterface.termsOfServiceUrl,
                                        t("settings.pluginCenter.termsOfService"),
                                      )
                                    }
                                  >
                                    {t("settings.pluginCenter.copyLink")}
                                  </Button>
                                </dd>
                              </>
                            )}
                          </dl>
                          {metadataCopy && (
                            <Feedback
                              error={
                                metadataCopy.kind === "failed"
                                  ? t("settings.pluginCenter.metadataLinkCopyFailed", {
                                      name: metadataCopy.name,
                                    })
                                  : ""
                              }
                              message={
                                metadataCopy.kind === "copied"
                                  ? t("settings.pluginCenter.metadataLinkCopied", {
                                      name: metadataCopy.name,
                                    })
                                  : ""
                              }
                            />
                          )}
                        </section>
                      )}
                    </>
                  )}
                  {detail.installed && detail.enabled && (
                    <p className="plugin-host-readiness" role="status">
                      {readinessError
                        ? formatUiMessage(t, readinessError)
                        : readiness?.pluginId === detail.id &&
                            readiness.installedDigest === detail.installedDigest
                          ? !readiness.available
                            ? readinessReason(readiness)
                            : readiness.requiredTools.length
                              ? t("settings.pluginCenter.hostToolDeploymentReady")
                              : null
                          : t("settings.pluginCenter.checkingHostToolDeployment")}
                    </p>
                  )}
                  {componentWarning && (
                    <PluginComponentSupport
                      report={detailSupport}
                      digest={detailDigest}
                      installed={detail.installed}
                    />
                  )}
                  {managing && catalogChanged && (
                    <PluginComponentSupport
                      report={detail.componentSupport}
                      digest={candidateDigest}
                      installed={false}
                    />
                  )}
                  {operationMessage && pendingKind !== "unknown" && !busy && (
                    <Feedback message={operationMessage} />
                  )}
                  {setupThreadId && onOpenThread && (
                    <Button onClick={() => onOpenThread(projectId, setupThreadId)}>
                      {t("settings.pluginCenter.openSetupConversation")}
                    </Button>
                  )}
                  {managing && detail.installed && (detail.installedSkills ?? []).length > 0 && (
                    <section
                      aria-label={t("settings.pluginCenter.installedSkills")}
                      className="plugin-detail-resources"
                    >
                      <h2>Skills</h2>
                      <p className="plugin-status-note">
                        {t("settings.pluginCenter.componentChoiceExplanation")}
                      </p>
                      <SettingsGroupCard>
                        {(detail.installedSkills ?? []).map((skill) => {
                          const requested = !detail.componentChoices?.disabledSkills?.includes(
                            skill.id,
                          );
                          return (
                            <SettingsRow
                              key={skill.id}
                              label={
                                <Button
                                  unstyled
                                  data-slot={undefined}
                                  type="submit"
                                  disabled={
                                    !detail.enabled ||
                                    !requested ||
                                    supportBlocked(
                                      detail.installedComponentSupport,
                                      detail.installedDigest,
                                    )
                                  }
                                  className="plugin-skill-link"
                                  onClick={() =>
                                    openSkill({
                                      ...skill,
                                      key: `${detail.id}:${skill.id}`,
                                      sourceLabel: {
                                        id: "settings.pluginCenter.pluginsValue",
                                        values: {
                                          value0:
                                            detailContent?.displayName ||
                                            detailContent?.name ||
                                            detail.id,
                                        },
                                      },
                                      scope: "plugin",
                                      pluginId: detail.id,
                                      projectId,
                                      enabled:
                                        detail.enabled &&
                                        requested &&
                                        !supportBlocked(
                                          detail.installedComponentSupport,
                                          detail.installedDigest,
                                        ),
                                    })
                                  }
                                >
                                  {skill.name}
                                </Button>
                              }
                              description={
                                <>
                                  <p>{skill.description}</p>
                                  <p>
                                    {t(
                                      !requested
                                        ? "settings.pluginCenter.componentOffInProject"
                                        : !detail.enabled ||
                                            supportBlocked(
                                              detail.installedComponentSupport,
                                              detail.installedDigest,
                                            )
                                          ? "settings.pluginCenter.componentOnRestricted"
                                          : "settings.pluginCenter.skillChoiceOn",
                                    )}
                                  </p>
                                </>
                              }
                              control={
                                <Switch
                                  checked={requested}
                                  disabled={disabled || detailLoading}
                                  aria-label={t("settings.pluginCenter.enableSkillInProject", {
                                    name: skill.name,
                                  })}
                                  onCheckedChange={(enabled) =>
                                    configureComponent("skill", skill.id, enabled)
                                  }
                                />
                              }
                            />
                          );
                        })}
                      </SettingsGroupCard>
                    </section>
                  )}
                  {managing && detail.installed && (
                    <div className="plugin-detail-setting-row" id="plugin-management">
                      <div>
                        <h3>{t("settings.pluginCenter.enabledStatus")}</h3>
                        <p>
                          {t("settings.pluginCenter.projectEnabledState", {
                            enabled: String(detail.enabled),
                          })}
                        </p>
                        {detail.installedVersion && (
                          <p>
                            {t("settings.pluginCenter.installedVersionNumber", {
                              version: detail.installedVersion,
                            })}
                          </p>
                        )}
                      </div>
                      <Button
                        variant="outline"
                        disabled={disabled || authPending}
                        aria-expanded={scopeOpen}
                        aria-controls="plugin-scope-settings"
                        onClick={() => setScopeOpen((value) => !value)}
                      >
                        {scopeOpen
                          ? t("settings.pluginCenter.hideEnabledScope")
                          : t("settings.pluginCenter.manageEnabledScope")}
                      </Button>
                    </div>
                  )}
                  {managing && detail.installed && scopeOpen && (
                    <div id="plugin-scope-settings" className="plugin-scope-settings">
                      <div className="plugin-scope-field">
                        <span>{t("settings.pluginCenter.changeScope")}</span>
                        <ResourceScope
                          value={scope}
                          onChange={(value) => {
                            if (value === "user" || value === "project") setScope(value);
                          }}
                          project={project}
                          disabled={disabled}
                        />
                      </div>
                      <p>
                        {t(
                          "settings.pluginCenter.projectConfigurationCanOverrideUserConfigurationThe",
                        )}
                      </p>
                      <div className="plugin-service-actions">
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() =>
                            void mutate({
                              operation: "pluginConfigure",
                              id: detail.id,
                              scope,
                              enabled: true,
                              expectedRevision: catalogRevision(),
                            })
                          }
                        >
                          {t("settings.pluginCenter.enableForScope", { scope })}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={disabled}
                          onClick={() =>
                            void mutate({
                              operation: "pluginConfigure",
                              id: detail.id,
                              scope,
                              enabled: false,
                              expectedRevision: catalogRevision(),
                            })
                          }
                        >
                          {t("settings.pluginCenter.disableForScope", { scope })}
                        </Button>
                      </div>
                    </div>
                  )}
                  {managing && catalogChanged && (
                    <div className="plugin-detail-setting-row">
                      <div>
                        <h3>{t("settings.pluginCenter.catalogContentsChanged")}</h3>
                        <p>{t("settings.pluginCenter.currentExecutionAndSettingsStillUseThe")}</p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={disabled}
                        onClick={() => {
                          setInstallReview(true);
                          void mutate({
                            operation: "pluginResolve",
                            id: detail.id,
                            expectedRevision: catalogRevision(),
                          });
                        }}
                      >
                        {t("settings.pluginCenter.reviewNewSnapshot")}
                      </Button>
                    </div>
                  )}
                  <div className="plugin-detail-setting-row">
                    <div>
                      <h3>{t("settings.pluginCenter.sourceAndInstallationDetails")}</h3>
                      <p>
                        {t("settings.pluginCenter.viewThePluginSSourceInstallationInformation")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      aria-expanded={detailsOpen}
                      aria-controls="plugin-source-details"
                      onClick={() => setDetailsOpen((value) => !value)}
                    >
                      {detailsOpen
                        ? t("settings.pluginCenter.hideDetails")
                        : t("settings.pluginCenter.viewDetails")}
                    </Button>
                  </div>
                  {detailsOpen && (
                    <div id="plugin-source-details" className="plugin-source-details">
                      <dl className="plugin-metadata">
                        <dt>{t("settings.pluginCenter.source2")}</dt>
                        <dd>
                          {officialMarket(marketFor(detail)?.sourceUrl)
                            ? t("settings.pluginCenter.openaiPluginMarketplace")
                            : marketFor(detail)?.name ||
                              detail.sourceKind ||
                              t("settings.pluginCenter.localPluginPackage")}
                        </dd>
                        {detail.installedDigest && (
                          <>
                            <dt>{t("settings.pluginCenter.currentInstallationSnapshot")}</dt>
                            <dd>
                              <code>
                                {detail.installedDigest.slice(0, 8)}…
                                {detail.installedDigest.slice(-8)}
                              </code>{" "}
                              <Button
                                variant="link"
                                onClick={async () => {
                                  try {
                                    await navigator.clipboard.writeText(detail.installedDigest!);
                                    setCopiedDigest(true);
                                  } catch {
                                    setError({
                                      message: {
                                        id: "settings.pluginCenter.couldNotCopyTheContentDigest",
                                      },
                                    });
                                  }
                                }}
                              >
                                {copiedDigest
                                  ? t("settings.pluginCenter.fullDigestCopied")
                                  : t("settings.pluginCenter.copyFullDigest")}
                              </Button>
                            </dd>
                          </>
                        )}
                        {detail.installed && (
                          <>
                            <dt>{t("settings.pluginCenter.catalogContents")}</dt>
                            <dd>
                              {!catalogChanged
                                ? t("settings.pluginCenter.matchesInstalledSnapshot")
                                : t("settings.pluginCenter.differsFromInstalledSnapshot")}
                            </dd>
                          </>
                        )}
                        {detail.version && (
                          <>
                            <dt>{t("settings.pluginCenter.catalogVersion")}</dt>
                            <dd>{detail.version}</dd>
                          </>
                        )}
                      </dl>
                      {Array.isArray(catalogInterface.capabilities) &&
                        catalogInterface.capabilities.length > 0 && (
                          <>
                            <h3>{t("settings.pluginCenter.capabilitiesDeclaredByCatalog")}</h3>
                            <ul>
                              {catalogInterface.capabilities.map((capability: string) => (
                                <li key={capability}>{capability}</li>
                              ))}
                            </ul>
                          </>
                        )}
                      {!componentWarning && (
                        <PluginComponentSupport
                          report={detailSupport}
                          digest={detailDigest}
                          installed={detail.installed}
                        />
                      )}
                      <SettingsDisclosure title={t("settings.pluginCenter.technicalDetails")}>
                        <dl className="plugin-metadata">
                          <dt>{t("settings.pluginCenter.pluginID")}</dt>
                          <dd>{detail.id}</dd>
                          <dt>{t("settings.pluginCenter.sourceSnapshotPath")}</dt>
                          <dd>{detail.source}</dd>
                          <dt>{t("settings.pluginCenter.catalogComponents")}</dt>
                          <dd>{detail.components.join("、") || t("settings.pluginCenter.none")}</dd>
                          <dt>{t("settings.pluginCenter.catalogContentDigest")}</dt>
                          <dd>{detail.sourceDigest}</dd>
                          {detail.admissionDigest && (
                            <>
                              <dt>{t("settings.pluginCenter.definitionReviewDigest")}</dt>
                              <dd>{detail.admissionDigest}</dd>
                            </>
                          )}
                          {detail.installedDigest && (
                            <>
                              <dt>{t("settings.pluginCenter.installedSnapshotDigest")}</dt>
                              <dd>{detail.installedDigest}</dd>
                            </>
                          )}
                          {detail.installedSourceDigest && (
                            <>
                              <dt>{t("settings.pluginCenter.installedContentDigest")}</dt>
                              <dd>{detail.installedSourceDigest}</dd>
                            </>
                          )}
                        </dl>
                        {detail.catalogSource !== undefined && (
                          <pre>{JSON.stringify(detail.catalogSource, null, 2)}</pre>
                        )}
                        {!!detail.diagnostics.length && (
                          <>
                            <h3>{t("settings.pluginCenter.catalogPackageDiagnostics")}</h3>
                            <ul>
                              {detail.diagnostics.map((text, index) => (
                                <li key={index}>{text}</li>
                              ))}
                            </ul>
                          </>
                        )}
                        {displayedError && <pre>{failureText(displayedError, t)}</pre>}
                      </SettingsDisclosure>
                      {catalogChanged && detail.skills.length > 0 && (
                        <SettingsDisclosure title={t("settings.pluginCenter.catalogPackageSkills")}>
                          <ul>
                            {detail.skills.map((skill) => (
                              <li key={skill.id}>
                                <strong>{skill.name}</strong>
                                <p>{skill.description}</p>
                              </li>
                            ))}
                          </ul>
                        </SettingsDisclosure>
                      )}
                    </div>
                  )}
                  {detail.installed && (
                    <>
                      <Feedback error={componentError} />
                      <PluginConfiguration
                        key={`${projectId ?? "user"}:${detail.id}:${detail.installedDigest}`}
                        detail={detail}
                        mutate={mutate}
                        disabled={disabled}
                        active={panelActive}
                        command={api}
                        projectId={projectId}
                      />
                      <PluginTemplateActions
                        key={`${detail.id}:${detail.installedDigest}`}
                        detail={detail}
                        components={components}
                        disabled={disabled}
                        onRunCommand={onRunCommand}
                        onStartDraft={onStartDraft}
                      />
                      {components?.developmentError && (
                        <Feedback error={components.developmentError} />
                      )}
                    </>
                  )}
                  {connected && managing && detail.installed && detail.installedDigest && (
                    <PluginHookSettings
                      projectId={projectId}
                      id={detail.id}
                      installedDigest={detail.installedDigest}
                      disabled={disabled || detailLoading}
                      api={api}
                      onConfigure={async (parameters) => {
                        await mutate({ operation: "pluginHooksConfigure", ...parameters });
                      }}
                      refreshKey={catalog?.revision}
                    />
                  )}
                  {connected && managing && detail.installed && apps?.(detail.id)}
                  {managing && detail.installed && detail.installedOnboardingSkill && (
                    <section className="plugin-detail-resources">
                      <h3>{t("settings.pluginCenter.pluginSettings")}</h3>
                      <p>{t("settings.pluginCenter.runTheSetupSkillInARegular")}</p>
                      <Button
                        disabled={
                          disabled ||
                          !detail.enabled ||
                          !hostReady ||
                          supportBlocked(detail.installedComponentSupport, detail.installedDigest)
                        }
                        onClick={() =>
                          void mutate({
                            operation: "pluginSetup",
                            id: detail.id,
                            ...(thread?.id ? { threadId: thread.id } : {}),
                          })
                        }
                      >
                        {t("settings.pluginCenter.runSetup")}
                      </Button>
                    </section>
                  )}
                </div>
              )}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
