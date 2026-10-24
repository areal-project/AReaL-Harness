import { useI18n, type UiMessage } from "../i18n/IntlProvider.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { Feedback } from "./common.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { PluginAuthConfiguration } from "./PluginAuthConfiguration.js";
import { supportBlocked } from "./PluginComponentSupport.js";
import { Switch } from "../components/ui/switch.js";
import { pluginMcpStateLabel } from "./pluginResources.js";
import type { PluginDetail } from "./PluginCenter.js";
import type { Data } from "../services.js";

type AuthState = "notStarted" | "pending" | "ready" | "failed" | "cancelled" | "unknown";
type Props = {
  detail: PluginDetail;
  snapshot?: Data;
  loading: boolean;
  error: string | UiMessage;
  disabled: boolean;
  command: (operation: string, values?: Data) => Promise<Data>;
  mutate: (operation: "pluginAuth" | "pluginConnection", values: Data) => Promise<Data | undefined>;
  onRefresh: () => void;
  onAuthActivity: (id: string, pending: boolean) => void;
  onComponentChange: (serverId: string, enabled: boolean) => void;
  connectorConfiguration: ReactNode;
};

/** Projects the installed package's authoritative connection snapshot; consent is only a local draft. */
export function PluginConnectionPanel({ detail, snapshot, loading, error, disabled, command, mutate,
  onRefresh, onAuthActivity, onComponentChange, connectorConfiguration }: Props) {
  const { t } = useI18n();
  const [auth, setAuth] = useState<Record<string, AuthState>>({});
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<UiMessage | string>("");
  const [consentOpen, setConsentOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [acting, setActing] = useState("");
  const [fullDigest, setFullDigest] = useState(false);
  const generation = useRef(0);
  const actingRef = useRef(false);
  const servers: Data[] = snapshot?.servers ?? [];
  const connectors: Data[] = snapshot?.connectors ?? [];
  const authenticatedServers = servers.filter(server => server.projectEnabled !== false && server.state !== "disabled" && server.config?.authentication);
  useEffect(() => {
    const request = ++generation.current;
    setAuthLoading(true);
    setAuthError("");
    void Promise.allSettled(authenticatedServers.map(async server => {
      const result = await command("pluginAuth", { id: detail.id, server: server.serverId, authOperation: "status" });
      // Core returns null before the first authentication attempt; this is not UNKNOWN.
      return [server.serverId, result === null ? "notStarted" : result.status] as const;
    })).then(results => {
      if (request !== generation.current) return;
      const next: Record<string, AuthState> = {};
      results.forEach((result, index) => {
        const id = authenticatedServers[index].serverId;
        next[id] = result.status === "fulfilled" && ["notStarted", "pending", "ready", "failed", "cancelled"].includes(result.value[1])
          ? result.value[1] : "unknown";
      });
      setAuth(next);
      if (results.some(result => result.status === "rejected")) setAuthError({ id: "settings.pluginConnectionPanel.authenticationStatusCouldNotBeConfirmedCheck" });
      setAuthLoading(false);
    });
    return () => { ++generation.current; };
  }, [detail.id, detail.installedDigest, snapshot, command]);

  const authenticate = async (server: Data, operation: string) => {
    if (disabled || actingRef.current) return;
    actingRef.current = true;
    const request = generation.current;
    setActing(`${server.serverId}:${operation}`);
    const result = await mutate("pluginAuth", { id: detail.id, server: server.serverId,
      authOperation: operation, expectedDigest: detail.installedDigest });
    // A refresh may have replaced this projection while the operation was in flight.
    if (request === generation.current) {
      setAuth(previous => ({ ...previous, [server.serverId]: result === null ? "notStarted" : result?.status ?? "unknown" }));
      if (result === undefined) setAuthError({ id: "settings.pluginConnectionPanel.theAuthenticationResultIsUnconfirmedCheckAuthentication" });
    }
    setActing("");
    actingRef.current = false;
  };
  const needsAuth = (server: Data) => server.state !== "disabled" && ((server.state === "authRequired" && auth[server.serverId] !== "ready") ||
    (server.config?.authentication && auth[server.serverId] !== "ready" &&
      (server.authentication === "required" || snapshot?.authenticationTiming === "ON_INSTALL")));
  const authPending = authenticatedServers.some(server => auth[server.serverId] === "pending" || auth[server.serverId] === "unknown");
  const authUnknown = authenticatedServers.some(server => auth[server.serverId] === "unknown");
  const authRequired = servers.some(needsAuth);
  const connected = snapshot?.state === "connected" && servers.some(server => server.state === "connected");
  const partial = snapshot?.state === "partial";
  const cleanupUnknown = snapshot?.state === "cleanupUnknown";
  const uncertain = snapshot?.state === "unknown" || servers.some(server => server.state === "unknown");
  const allDisabled = servers.length > 0 && servers.every(server => server.state === "disabled") && !connectors.length;
  const configurationBlocked = !servers.length && !connectors.length && snapshot?.diagnostics?.some((item: Data) => item.class === "configuration" || item.class === "policy");
  const mappingRequired = connectors.some(connector => connector.state === "missingMapping" || connector.state === "authRequired");
  const hasConnections = servers.length > 0 || connectors.length > 0;
  const blocked = supportBlocked(detail.installedComponentSupport, detail.installedDigest) || disabled || loading || authLoading || !!acting;
  const title = loading || !snapshot ? t("settings.pluginConnectionPanel.loadingConnectionStatus") : cleanupUnknown ? t("settings.pluginConnectionPanel.cleanupResultUnconfirmed")
    : uncertain ? t("settings.pluginConnectionPanel.connectionStatusUnconfirmed") : allDisabled ? t("settings.pluginConnectionPanel.servicesDisabled") : configurationBlocked ? t("settings.pluginConnectionPanel.connectionConfigurationNeedsAttention")
    : partial ? t("settings.pluginConnectionPanel.someServicesAreDisconnected") : authUnknown ? t("settings.pluginConnectionPanel.authenticationResultUnconfirmed") : authPending ? t("settings.pluginConnectionPanel.waitingForAuthentication") : authRequired ? t("settings.pluginConnectionPanel.authenticationRequired") : mappingRequired ? t("settings.pluginConnectionPanel.connectionConfigurationRequired")
    : connected ? t("settings.pluginConnectionPanel.connected") : !hasConnections ? t("settings.pluginConnectionPanel.installed")
    : authenticatedServers.length && authenticatedServers.every(server => auth[server.serverId] === "ready") ? t("settings.pluginConnectionPanel.authenticatedWaitingToConnect") : t("settings.pluginConnectionPanel.waitingToConnect");
  const description = cleanupUnknown ? t("settings.pluginConnectionPanel.cleanupOfThePreviousServiceIsUnconfirmed")
    : uncertain ? t("settings.pluginConnectionPanel.reloadTheCurrentConnectionStatusFirstThe")
    : allDisabled ? t("settings.pluginConnectionPanel.noMCPServicesAreEnabledInThe")
    : configurationBlocked ? t("settings.pluginConnectionPanel.serviceDeclarationsAreInvalidOrRestrictedBy")
    : authUnknown ? t("settings.pluginConnectionPanel.theAuthenticationResultHasNotBeenConfirmed")
    : authPending ? t("settings.pluginConnectionPanel.completeAuthenticationAndCheckItsStatusDisconnected")
    : authRequired ? t("settings.pluginConnectionPanel.completeAuthenticationThenConfirmTrustAndConnect")
    : mappingRequired ? t("settings.pluginConnectionPanel.configureTheConnectorsDeclaredByThisPlugin")
    : connected ? t("settings.pluginConnectionPanel.connectedServicesSubjectToProfile")
    : partial ? t("settings.pluginConnectionPanel.someServicesAreAvailableCheckTheStatus")
    : !hasConnections && snapshot ? t("settings.pluginConnectionPanel.thePluginIsInstalledAndEnabled") : t("settings.pluginConnectionPanel.confirmThatYouTrustTheCurrentInstallation");

  return <section className="plugin-status-panel" aria-label={t("settings.pluginConnectionPanel.pluginConnectionStatus")}>
    <h2>{title}</h2><p className="plugin-status-description">{description}</p>
    {servers.length > 0 && <p className="plugin-status-note">{t("settings.pluginConnectionPanel.componentReconnectRequired")}</p>}
    <Feedback error={error || authError} />
    {!!error && <Button variant="outline" onClick={onRefresh}>{t("settings.pluginConnectionPanel.reloadConnectionStatus")}</Button>}
    {!loading && snapshot && <>
      {servers.map(server => {
        const status = auth[server.serverId];
        const pending = status === "pending" || status === "unknown";
        const requires = needsAuth(server);
        return <div className="plugin-service-row" key={server.serverId}>
          <div className="plugin-service-info"><strong>{server.config?.title || (servers.length === 1 ? `${detail.displayName || detail.name} MCP` : server.serverId)}</strong>
            <p>{status === "unknown" ? t("settings.pluginConnectionPanel.authenticationResultUnconfirmed") : pending ? t("settings.pluginConnectionPanel.authenticationInProgress") : requires ? t("settings.pluginConnectionPanel.authenticationRequired") : status === "ready" ? t("settings.pluginConnectionPanel.authenticatedServiceState", { state: pluginMcpStateLabel(server.state, t) }) : pluginMcpStateLabel(server.state, t)}</p>
            {server.projectEnabled !== false && server.config?.enabled === false && <p>{t("settings.pluginCenter.componentOnRestricted")}</p>}
            {server.message && <Feedback error={String(server.message)} />}
          </div>
          <Switch checked={server.projectEnabled !== false} disabled={disabled || loading || authLoading || !!acting} aria-label={t("settings.pluginCenter.enableMcpInProject", { name: server.config?.title || server.serverId })} onCheckedChange={enabled => onComponentChange(server.serverId, enabled)} />
          {server.projectEnabled !== false && server.state !== "disabled" && server.config?.authentication && <div className="plugin-service-actions">
            {pending ? <><Button disabled={blocked} onClick={() => void authenticate(server, "status")}>{t("settings.pluginConnectionPanel.checkAuthenticationStatus")}</Button>
              {status === "pending" && <Button variant="outline" disabled={blocked} onClick={() => void authenticate(server, "cancel")}>{t("settings.pluginConnectionPanel.cancelThisAuthentication")}</Button>}</>
              : requires ? <Button disabled={blocked} onClick={() => void authenticate(server, "start")}>{server.config.authenticationRequirements?.apiKey ? t("settings.pluginConnectionPanel.enableAuthentication") : t("settings.pluginConnectionPanel.authenticateInBrowser")}</Button> : null}
          </div>}
        </div>;
      })}
      {mappingRequired && connectorConfiguration}
      {uncertain && <Button variant="outline" disabled={loading} onClick={onRefresh}>{t("settings.pluginConnectionPanel.checkConnectionStatus")}</Button>}
      {(connected || partial) && <div className="plugin-connection-actions plugin-service-actions">
        <Button variant="outline" disabled={blocked} onClick={() => {
          setConsent(false); setConsentOpen(false);
          void mutate("pluginConnection", { id: detail.id, expectedDigest: detail.installedDigest, connect: false });
        }}>{t("settings.pluginConnectionPanel.disconnectAndRevokeTrust")}</Button>
      </div>}
      {(connected || partial) && <p className="plugin-status-note">{t("settings.pluginConnectionPanel.afterDisconnectingConfirmTrustAgainToReconnect")}</p>}
      {hasConnections && !connected && !cleanupUnknown && !uncertain && !allDisabled && !authPending && !authRequired && !mappingRequired && <>
        {!consentOpen ? <Button disabled={blocked} onClick={() => setConsentOpen(true)}>{t("settings.pluginConnectionPanel.reviewAndConnect")}</Button> :
          <div className="plugin-trust-review">
            <h3>{t("settings.pluginConnectionPanel.thisAuthorization")}</h3><p>{t("settings.pluginConnectionPanel.allowTheMCPServicesDeclaredByThis")}</p>
            <p>{t("settings.pluginConnectionPanel.installationSnapshot")}{" "}<code>{fullDigest ? detail.installedDigest : `${detail.installedDigest?.slice(0, 8)}…${detail.installedDigest?.slice(-8)}`}</code>{" "}
              <Button variant="link" onClick={() => setFullDigest(value => !value)}>{fullDigest ? t("settings.pluginConnectionPanel.hideFullDigest") : t("settings.pluginConnectionPanel.viewFullDigest")}</Button></p>
            <label className="plugin-consent"><input type="checkbox" checked={consent} disabled={blocked}
              onChange={event => setConsent(event.target.checked)} />
              <span>{t("settings.pluginConnectionPanel.iTrustTheCurrentInstallationSnapshotAnd")}</span></label>
            <div className="plugin-service-actions"><Button disabled={blocked || !consent} onClick={() => {
              if (!consent) return;
              setConsent(false);
              void mutate("pluginConnection", { id: detail.id, expectedDigest: detail.installedDigest, connect: true });
            }}>{t("settings.pluginConnectionPanel.trustAndConnect")}</Button><Button variant="outline" disabled={blocked} onClick={() => { setConsent(false); setConsentOpen(false); }}>{t("settings.pluginConnectionPanel.connectLater")}</Button></div>
            {!consent && <p className="plugin-status-note">{t("settings.pluginConnectionPanel.confirmThatYouTrustTheCurrentInstallation2")}</p>}
          </div>}
      </>}
      {!connected && !partial && !consentOpen && authenticatedServers.map(server => <PluginAuthConfiguration key={server.serverId} pluginId={detail.id}
        server={server} digest={detail.installedDigest!} disabled={disabled || connected || partial}
        command={command} onActivityChange={onAuthActivity} onSaved={onRefresh} />)}
      {!mappingRequired && connectors.length > 0 && connectorConfiguration}
      {!!snapshot.diagnostics?.length && <SettingsDisclosure title={t("settings.pluginConnectionPanel.connectionDiagnostics")}><pre>{JSON.stringify(snapshot.diagnostics, null, 2)}</pre></SettingsDisclosure>}
    </>}
  </section>;
}
