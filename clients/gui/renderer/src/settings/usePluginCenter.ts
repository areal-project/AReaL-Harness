import { useCallback, useEffect, useRef, useState } from "react";
import type { ManagementResponseMap } from "@areal/workbench/desktop-contract/management";
import { UiMessageError, type UiMessage } from "../i18n/IntlProvider.js";
import type { PluginCommand, PluginDetail, PluginList, PluginReadiness } from "./pluginTypes.js";
import type { Data } from "../services.js";

type OptionalReadErrors = Partial<Record<"connections" | "hooks", UiMessage | string>>;
const readFailure = (cause: unknown): UiMessage | string =>
  cause instanceof UiMessageError
    ? cause.descriptor
    : cause instanceof Error
      ? cause.message
      : { id: "settings.pluginCenter.pluginOperationFailed" };

export function usePluginCenter({
  api,
  projectId,
  connected,
  active,
  selected,
}: {
  api: PluginCommand;
  projectId?: string;
  connected: boolean;
  active: boolean;
  selected: string | null;
}) {
  const [catalog, setCatalog] = useState<PluginList | null>(null);
  const [snapshot, setSnapshot] = useState<ManagementResponseMap["pluginStoreSnapshot"] | null>(
    null,
  );
  const [supported, setSupported] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<UiMessage | string>("");
  const [optionalReadErrors, setOptionalReadErrors] = useState<OptionalReadErrors>({});
  const [allConnections, setAllConnections] = useState<Data[]>([]);
  const [hookSources, setHookSources] = useState<
    { id: string; digest: string; origin: string; enabled: boolean }[]
  >([]);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<UiMessage | string>("");
  const [components, setComponents] = useState<ManagementResponseMap["pluginComponents"] | null>(
    null,
  );
  const [componentError, setComponentError] = useState<UiMessage | string>("");
  const [readiness, setReadiness] = useState<PluginReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<UiMessage | string>("");
  const mounted = useRef(true);
  const scope = useRef({ projectId, active });
  scope.current = { projectId, active };
  const readGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const refresh = useCallback(async () => {
    if (!active || !scope.current.active || scope.current.projectId !== projectId) return;
    const generation = ++readGeneration.current;
    setLoading(true);
    setReadError("");
    setOptionalReadErrors({});
    setSupported(null);
    setAllConnections([]);
    setHookSources([]);
    try {
      const value = await api({
        operation: "pluginStoreSnapshot",
        ...(projectId ? { projectId } : {}),
      });
      if (!mounted.current || generation !== readGeneration.current) return;
      setSnapshot(value);
      setCatalog(value.list);
      if (!connected || !projectId) return;
      const [capability, connections, hooks] = await Promise.allSettled([
        api({ projectId, operation: "pluginCapabilities" }),
        api({ projectId, operation: "pluginMcp" }),
        api({ projectId, operation: "pluginHooks" }),
      ]);
      if (!mounted.current || generation !== readGeneration.current) return;
      if (capability.status === "fulfilled") setSupported(capability.value.enabled);
      if (connections.status === "fulfilled") setAllConnections(connections.value.data);
      if (hooks.status === "fulfilled")
        setHookSources(
          hooks.value.data
            .filter(
              (row) => row.pluginId === "__hooks_user__" || row.pluginId === "__hooks_project__",
            )
            .map((row) => ({
              id: row.pluginId,
              digest: row.installedDigest,
              origin: row.pluginId,
              enabled: row.definitions.some((definition) => definition.trusted),
            })),
        );
      setOptionalReadErrors({
        ...(connections.status === "rejected"
          ? { connections: readFailure(connections.reason) }
          : {}),
        ...(hooks.status === "rejected" ? { hooks: readFailure(hooks.reason) } : {}),
      });
    } catch (cause) {
      if (mounted.current && generation === readGeneration.current) {
        setReadError(readFailure(cause));
        setCatalog(null);
        setSnapshot(null);
      }
    } finally {
      if (mounted.current && generation === readGeneration.current) setLoading(false);
    }
  }, [api, projectId, connected, active]);
  const readDetail = useCallback(
    async (id: string) => {
      if (
        !active ||
        !scope.current.active ||
        scope.current.projectId !== projectId ||
        selectedRef.current !== id
      )
        return;
      const generation = ++detailGeneration.current;
      setDetailLoading(true);
      setDetail((current) => (current?.id === id ? current : null));
      setDetailError("");
      try {
        const value = await api({
          operation: "pluginStoreSnapshot",
          id,
          ...(projectId ? { projectId } : {}),
        });
        if (
          mounted.current &&
          generation === detailGeneration.current &&
          selectedRef.current === id
        ) {
          setDetail(value.detail);
          if (!value.detail) setDetailError({ id: "settings.pluginCenter.pluginNotInSnapshot" });
        }
      } catch (cause) {
        if (mounted.current && generation === detailGeneration.current)
          setDetailError(readFailure(cause));
      } finally {
        if (mounted.current && generation === detailGeneration.current) setDetailLoading(false);
      }
    },
    [api, projectId, active],
  );
  useEffect(() => {
    mounted.current = true;
    setCatalog(null);
    setSnapshot(null);
    setDetail(null);
    const changed = () => void refresh();
    window.addEventListener("areal-plugins-changed", changed);
    void refresh();
    return () => {
      mounted.current = false;
      readGeneration.current++;
      detailGeneration.current++;
      window.removeEventListener("areal-plugins-changed", changed);
    };
  }, [refresh]);
  useEffect(() => {
    if (selected) void readDetail(selected);
  }, [selected, readDetail, catalog?.revision]);
  useEffect(() => {
    let current = true;
    const refreshReadiness = async () => {
      setReadiness(null);
      setReadinessError("");
      if (
        !active ||
        !connected ||
        !projectId ||
        !detail?.installed ||
        !detail.installedDigest ||
        !detail.enabled
      )
        return;
      try {
        const value = await api({
          projectId,
          operation: "pluginReadiness",
          id: detail.id,
          expectedDigest: detail.installedDigest,
        });
        if (current) setReadiness(value);
      } catch (cause) {
        if (current) setReadinessError(readFailure(cause));
      }
    };
    void refreshReadiness();
    window.addEventListener("focus", refreshReadiness);
    window.addEventListener("areal-plugins-changed", refreshReadiness);
    return () => {
      current = false;
      window.removeEventListener("focus", refreshReadiness);
      window.removeEventListener("areal-plugins-changed", refreshReadiness);
    };
  }, [
    api,
    active,
    connected,
    projectId,
    detail?.id,
    detail?.installedDigest,
    detail?.enabled,
    catalog?.revision,
  ]);
  useEffect(() => {
    let current = true;
    setComponents(null);
    setComponentError("");
    if (!active || !connected || !projectId || !detail?.installedDigest) return;
    void api({ projectId, operation: "pluginComponents", id: detail.id })
      .then((value) => {
        if (!current) return;
        if (value.pluginId !== detail.id || value.installedDigest !== detail.installedDigest) {
          setComponentError({ id: "settings.pluginCenter.componentSnapshotChanged" });
          return;
        }
        setComponents(value);
      })
      .catch((cause) => {
        if (current) setComponentError(readFailure(cause));
      });
    return () => {
      current = false;
    };
  }, [api, active, connected, projectId, detail?.id, detail?.installedDigest, catalog?.revision]);
  return {
    catalog,
    components,
    componentError,
    snapshot,
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
  };
}
