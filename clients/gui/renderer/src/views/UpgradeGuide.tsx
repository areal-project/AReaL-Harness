import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { useI18n } from "../i18n/IntlProvider.js";
import { call, type CommandResponse, type PlatformServices } from "../services.js";
import { describeSchedule } from "../scheduleText.js";
import { SettingsDisclosure } from "../settings/SettingsDisclosure.js";
import { UpgradeHistory } from "./UpgradeHistory.js";

type Catalog = Extract<CommandResponse<"recovery", { operation: "inspect" }>, { kind: "space" }>;

export function UpgradeGuide({
  services,
  ready,
  onModels,
  onAvailable,
  openRequest,
}: {
  services: PlatformServices;
  ready: boolean;
  onModels: () => void;
  onAvailable: (available: boolean) => void;
  openRequest: number;
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<Catalog>();
  const [inspectFailed, setInspectFailed] = useState(false);
  const [inspectAttempt, setInspectAttempt] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [history, setHistory] = useState(false);
  const [providerPending, setProviderPending] = useState<string>();
  const [providerErrors, setProviderErrors] = useState<Record<string, boolean>>({});
  const [state, setState] = useState<"idle" | "working" | "ready" | "failed" | "unknown">("idle");
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void call(services, "recovery", { operation: "inspect" })
      .then((result) => {
        if (!active || result.kind !== "space") return;
        setCatalog(result);
        onAvailable(true);
        try {
          if (localStorage.getItem(`areal:upgrade-complete:${result.spaceId}`) === "1") {
            setHidden(true);
            setState("ready");
          }
        } catch {}
      })
      .catch((error: { code?: string }) => {
        if (active && error?.code !== "CAPABILITY_UNAVAILABLE") setInspectFailed(true);
      });
    return () => {
      active = false;
    };
  }, [ready, services, onAvailable, inspectAttempt]);
  useEffect(() => {
    if (openRequest) {
      setHidden(false);
      setHistory(true);
    }
  }, [openRequest]);
  if (hidden) return null;
  if (!catalog)
    return inspectFailed ? (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) setHidden(true);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("upgrade.title")}</DialogTitle>
            <DialogDescription>{t("upgrade.inspectFailed")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setHidden(true)}>
              {t("upgrade.later")}
            </Button>
            <Button
              onClick={() => {
                setInspectFailed(false);
                setInspectAttempt((value) => value + 1);
              }}
            >
              {t("upgrade.retry")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    ) : null;
  const finish = (models: boolean) => {
    try {
      localStorage.setItem(`areal:upgrade-complete:${catalog.spaceId}`, "1");
    } catch {}
    setHidden(true);
    if (models) onModels();
  };
  const create = async () => {
    setState("working");
    try {
      await call(services, "recovery", { operation: "openWorkspace" });
      setState("ready");
    } catch (error) {
      const failure = error as { submissionUnknown?: boolean; outcome?: { kind?: string } };
      setState(
        failure?.submissionUnknown ||
          ["admitted", "unconfirmed"].includes(failure?.outcome?.kind ?? "")
          ? "unknown"
          : "failed",
      );
    }
  };
  const importProvider = async (provider: Catalog["providers"][number]) => {
    const templateDigest = provider.importOperation?.templateDigest ?? provider.templateDigest;
    if (!provider.id || !templateDigest || providerPending) return;
    const providerId = provider.id;
    const key = `areal:upgrade-provider:${catalog.spaceId}:${providerId}`;
    let requestId: string;
    try {
      requestId =
        provider.importOperation?.requestId || localStorage.getItem(key) || crypto.randomUUID();
      localStorage.setItem(key, requestId);
    } catch {
      setProviderErrors((current) => ({ ...current, [providerId]: true }));
      return;
    }
    setProviderPending(providerId);
    setProviderErrors((current) => ({ ...current, [providerId]: false }));
    try {
      const result = await call(services, "recovery", {
        operation: "importProvider",
        providerId,
        requestId,
        templateDigest,
      });
      try {
        localStorage.setItem(key, result.requestId);
      } catch {}
      setCatalog(
        (current) =>
          current && {
            ...current,
            providers: current.providers.map((item) =>
              item.id === providerId ? { ...item, importOperation: result } : item,
            ),
          },
      );
    } catch {
      setProviderErrors((current) => ({ ...current, [providerId]: true }));
    } finally {
      setProviderPending(undefined);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) setHidden(true);
      }}
    >
      <DialogContent className="max-w-lg max-h-[calc(100%-var(--spacing-panel)*2)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("upgrade.title")}</DialogTitle>
          <DialogDescription>{t("upgrade.description")}</DialogDescription>
        </DialogHeader>
        {history ? (
          <UpgradeHistory services={services} catalog={catalog} onBack={() => setHistory(false)} />
        ) : (
          <>
            <p>{t("upgrade.projects", { count: catalog.projects.length })}</p>
            {catalog.projects.length > 0 && (
              <ul>
                {catalog.projects.map((project, index) => (
                  <li key={project.id ?? index}>{project.name}</li>
                ))}
              </ul>
            )}
            <p>
              {catalog.providers.length
                ? t("upgrade.providers", {
                    names: catalog.providers
                      .map((provider) => provider.name ?? provider.id)
                      .filter(Boolean)
                      .join("、"),
                  })
                : t("upgrade.noProviders")}
            </p>
            {catalog.providerCatalogState !== "available" && (
              <p role="status">{t("upgrade.providerUnavailable")}</p>
            )}
            {catalog.providers.length > 0 && (
              <ul>
                {catalog.providers.map((provider, index) => (
                  <li key={provider.id ?? index}>
                    <span>{provider.name ?? provider.id}</span>{" "}
                    {(provider.template || provider.importOperation) &&
                      provider.id &&
                      (provider.templateDigest || provider.importOperation?.templateDigest) &&
                      (provider.importOperation?.state === "completed" ? (
                        <span>{t("upgrade.providerImported")}</span>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!!providerPending || state === "working"}
                          onClick={() => void importProvider(provider)}
                        >
                          {t(
                            provider.importOperation || providerErrors[provider.id]
                              ? "upgrade.providerCheck"
                              : "upgrade.providerImport",
                          )}
                        </Button>
                      ))}
                    {provider.id &&
                      (provider.importOperation?.state === "admissionUnknown" ||
                        providerErrors[provider.id]) && (
                        <p role="status">{t("upgrade.providerUnknown")}</p>
                      )}
                  </li>
                ))}
              </ul>
            )}
            <p>{t("upgrade.tasks")}</p>
            {catalog.scheduledTasks.length > 0 && (
              <SettingsDisclosure title={t("upgrade.taskList")}>
                <ul>
                  {catalog.scheduledTasks.map((task) => (
                    <li key={`${task.projectId}:${task.taskId}`}>
                      {task.title} ·{" "}
                      {task.schedule || task.scheduleV2
                        ? describeSchedule(task, t)
                        : t("upgrade.taskScheduleUnavailable")}
                    </li>
                  ))}
                </ul>
              </SettingsDisclosure>
            )}
            {(catalog.taskCatalogUnavailable.length > 0 || catalog.tasksTruncated) && (
              <p role="status">{t("upgrade.taskUnavailable")}</p>
            )}
            {state === "ready" && <p role="status">{t("upgrade.created")}</p>}
            {(state === "failed" || state === "unknown") && (
              <p role="alert">{t(state === "unknown" ? "upgrade.unknown" : "upgrade.failed")}</p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setHistory(true)}>
                {t("upgrade.history")}
              </Button>
              <Button variant="ghost" onClick={() => setHidden(true)}>
                {t("upgrade.later")}
              </Button>
              {state === "ready" ? (
                <>
                  <Button variant="outline" onClick={() => finish(true)}>
                    {t("upgrade.models")}
                  </Button>
                  <Button onClick={() => finish(false)}>{t("upgrade.enter")}</Button>
                </>
              ) : (
                <Button
                  disabled={state === "working" || state === "unknown" || !!providerPending}
                  onClick={() => void create()}
                >
                  {t(state === "working" ? "upgrade.creating" : "upgrade.create")}
                </Button>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
