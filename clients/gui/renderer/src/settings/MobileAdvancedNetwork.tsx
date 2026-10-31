import { useEffect, useState } from "react";
import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useI18n, type MessageId, type Translate } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import type { CommandParams, Data } from "../services.js";

type Run = (request: CommandParams<"remoteControl">) => Promise<Data | undefined>;

export const networkDiagnostics: Record<string, MessageId> = {
  "funnel-capability-unknown": "settings.mobileSettings.networkDiagnostic.funnelCapabilityUnknown",
  "funnel-port-denied": "settings.mobileSettings.networkDiagnostic.funnelPortDenied",
  "unsupported-funnel-port": "settings.mobileSettings.networkDiagnostic.unsupportedFunnelPort",
  "public-confirmation-required":
    "settings.mobileSettings.networkDiagnostic.publicConfirmationRequired",
  unavailable: "settings.mobileSettings.networkDiagnostic.unavailable",
  "unsupported-version": "settings.mobileSettings.networkDiagnostic.unsupportedVersion",
  "not-logged-in": "settings.mobileSettings.networkDiagnostic.notLoggedIn",
  "https-disabled": "settings.mobileSettings.networkDiagnostic.httpsDisabled",
  "https-unknown": "settings.mobileSettings.networkDiagnostic.httpsUnknown",
  "mapping-collision": "settings.mobileSettings.networkDiagnostic.mappingCollision",
  "mapping-exists": "settings.mobileSettings.networkDiagnostic.mappingExists",
  "mapping-changed": "settings.mobileSettings.networkDiagnostic.mappingChanged",
  "mapping-absent": "settings.mobileSettings.networkDiagnostic.mappingAbsent",
  "listener-drift": "settings.mobileSettings.networkDiagnostic.listenerDrift",
  "unverified-listener": "settings.mobileSettings.networkDiagnostic.unverifiedListener",
  "network-changed": "settings.mobileSettings.networkDiagnostic.networkChanged",
  "cleanup-pending": "settings.mobileSettings.networkDiagnostic.cleanupPending",
  "reconciliation-required": "settings.mobileSettings.networkDiagnostic.reconciliationRequired",
  "persistence-failed": "settings.mobileSettings.networkDiagnostic.persistenceFailed",
  "cli-failed": "settings.mobileSettings.networkDiagnostic.cliFailed",
  timeout: "settings.mobileSettings.networkDiagnostic.timeout",
  "stale-proposal": "settings.mobileSettings.networkDiagnostic.staleProposal",
  "invalid-origin": "settings.mobileSettings.networkDiagnostic.invalidOrigin",
  "invalid-port": "settings.mobileSettings.networkDiagnostic.invalidPort",
};
const networkLoginDiagnostics: Record<string, MessageId> = {
  "logged-in": "settings.mobileSettings.networkLogin.loggedIn",
  "not-logged-in": "settings.mobileSettings.networkLogin.notLoggedIn",
  "approval-required": "settings.mobileSettings.networkLogin.approvalRequired",
  stopped: "settings.mobileSettings.networkLogin.stopped",
  starting: "settings.mobileSettings.networkLogin.starting",
  unknown: "settings.mobileSettings.networkLogin.unknown",
};
export const networkDiagnostic = (t: Translate, code: string) =>
  t(networkDiagnostics[code] ?? "settings.mobileSettings.networkStatusUnknown", { code });

/** 中继登记表单：未开启时显示在状态卡里，开启后移到高级网络设置。 */
export function RelayEnrollForm({ state, busy, run }: { state: Data; busy: boolean; run: Run }) {
  const { t } = useI18n();
  const [relayOrigin, setRelayOrigin] = useState("");
  const [enrollmentCode, setEnrollmentCode] = useState("");
  const [relayConfirmed, setRelayConfirmed] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  useEffect(() => {
    setRelayOrigin(state.relay?.startsWith("https://") ? state.relay : "");
  }, [state.relay]);
  const enable = async () => {
    setEnrolling(true);
    const result = await run({
      operation: "enable",
      relay: relayOrigin,
      confirmed: true,
      ...(enrollmentCode ? { code: enrollmentCode } : {}),
    });
    setEnrolling(false);
    if (!result?.enabled) return;
    setEnrollmentCode("");
    setRelayConfirmed(false);
  };
  return (
    <fieldset disabled={busy || enrolling} aria-busy={enrolling} className="remote-relay-form">
      <legend className="sr-only">{t("settings.mobileSettings.enrollOrReconnectRelay")}</legend>
      <label>
        <span>{t("settings.mobileConnect.relayOrigin")}</span>
        <Input
          aria-label={t("settings.mobileSettings.relayHTTPSOrigin")}
          value={relayOrigin}
          placeholder="https://relay.example.org"
          onChange={(event) => {
            setRelayOrigin(event.target.value);
            setRelayConfirmed(false);
          }}
        />
      </label>
      <label>
        <span>{t("settings.mobileConnect.enrollmentCode")}</span>
        <Input
          aria-label={t("settings.mobileSettings.administratorOneTimeEnrollmentCode")}
          type="password"
          autoComplete="off"
          placeholder={t("settings.mobileConnect.enrollmentCodePlaceholder")}
          value={enrollmentCode}
          onChange={(event) => {
            setEnrollmentCode(event.target.value);
            setRelayConfirmed(false);
          }}
        />
      </label>
      {state.enabled && (
        <p className="remote-muted">
          {t("settings.mobileSettings.initialEnrollmentChangingTheOriginOrRe")}
        </p>
      )}
      <label className="remote-relay-consent">
        <Input
          unstyled
          data-slot={undefined}
          type="checkbox"
          checked={relayConfirmed}
          onChange={(event) => setRelayConfirmed(event.target.checked)}
        />
        <span>{t("settings.mobileSettings.iTrustTheRemotePageProvidedBy")}</span>
      </label>
      <div className="remote-relay-actions">
        {state.enabled && (
          <Button variant="outline" onClick={() => void run({ operation: "disable" })}>
            {t("settings.mobileSettings.disconnectRelay")}
          </Button>
        )}
        <Button disabled={!relayConfirmed || !relayOrigin} onClick={() => void enable()}>
          {enrolling
            ? t("settings.mobileConnect.enrolling")
            : state.enabled
              ? t("settings.mobileSettings.enrollOrEnableRelay")
              : t("settings.mobileConnect.turnOn")}
        </Button>
      </div>
      {state.enabled && state.connected && (
        <p className="remote-muted">
          {t(
            state.pushSupported
              ? "settings.mobileSettings.pushSupported"
              : "settings.mobileSettings.pushUnsupported",
          )}
        </p>
      )}
      {state.relayError && <p role="alert">{state.relayError}</p>}
    </fieldset>
  );
}

/** 高级网络设置：Tailscale、组织 HTTPS、本机入口与已开启的中继。主路径不需要理解这些。 */
export function MobileAdvancedNetwork({
  state,
  busy,
  run: runCommand,
  reconnectUrl,
}: {
  state: Data;
  busy: boolean;
  run: Run;
  reconnectUrl: string;
}) {
  const { t, intl } = useI18n();
  const [proposal, setProposal] = useState<Data | null>(null);
  const [serveConfirmed, setServeConfirmed] = useState(false);
  const [scopeConfirmed, setScopeConfirmed] = useState(false);
  const [funnelConfirmed, setFunnelConfirmed] = useState(false);
  const [accessMethod, setAccessMethod] = useState<"private" | "public" | "organization">(
    "private",
  );
  const [httpsPort, setHttpsPort] = useState("443");
  const [organizationOrigin, setOrganizationOrigin] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [organizationConfirmed, setOrganizationConfirmed] = useState(false);
  const [publicConfirmed, setPublicConfirmed] = useState(false);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const clearConsent = () => {
    setProposal(null);
    setServeConfirmed(false);
    setScopeConfirmed(false);
    setFunnelConfirmed(false);
    setOrganizationConfirmed(false);
    setPublicConfirmed(false);
    setRecoveryConfirmed(false);
  };
  // 方案与确认勾选只对一次操作有效：生成新方案、应用或失败后都要重新确认。
  const run = async (request: CommandParams<"remoteControl">) => {
    const proposing = ["networkPropose", "networkProposeScope"].includes(request.operation);
    if (proposing) clearConsent();
    const result = await runCommand(request);
    if (proposing) setProposal(result ?? null);
    else if (request.operation !== "networkInspect") clearConsent();
  };
  return (
    <SettingsDisclosure
      className="remote-network-settings"
      title={<span>{t("settings.mobileConnect.advancedNetwork")}</span>}
    >
      <div className="remote-network-content">
        <SettingsSection
          title={t("settings.mobileSettings.configurePhoneAccess")}
          description={t("settings.mobileSettings.chooseHowYourPhoneConnects")}
        >
          <SettingsGroupCard>
            <SettingsRow
              label={t("settings.mobileSettings.accessMethod")}
              control={
                <SettingsSelect
                  aria-label={t("settings.mobileSettings.phoneAccessMethod")}
                  value={accessMethod}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (busy) return;
                    setAccessMethod(value as "private" | "public" | "organization");
                    setProposal(null);
                    setServeConfirmed(false);
                    setScopeConfirmed(false);
                    setFunnelConfirmed(false);
                    setOrganizationConfirmed(false);
                    setPublicConfirmed(false);
                    setRecoveryConfirmed(false);
                  }}
                >
                  <option value="private">{t("settings.mobileSettings.privateNetwork")}</option>
                  <option value="public">{t("settings.mobileSettings.publicInternet")}</option>
                  <option value="organization">
                    {t("settings.mobileSettings.organizationNetwork")}
                  </option>
                </SettingsSelect>
              }
            />
          </SettingsGroupCard>
          <SettingsGroupCard className="remote-access-panel">
            <SettingsDisclosure
              className="remote-connection-details"
              title={<> {t("settings.mobileSettings.connectionDetailsAndDiagnostics")}</>}
            >
              <p>{t("settings.mobileSettings.phonesUsingServeMustJoinTheSame")}</p>
              <p>{t("settings.mobileSettings.ifTheHostIsOfflineCheckThe")}</p>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run({ operation: "networkInspect" })}
              >
                {t("settings.mobileSettings.checkNetworkTools")}
              </Button>
              {state.network?.inspection && (
                <div role="status">
                  <p>
                    {t("settings.mobileSettings.tailscaleVersionValue", {
                      version:
                        state.network.inspection.version ?? t("settings.mobileSettings.unknown"),
                    })}
                  </p>
                  {state.network.inspection.diagnostic && (
                    <p>{networkDiagnostic(t, state.network.inspection.diagnostic)}</p>
                  )}
                  {state.network.inspection.login && (
                    <p>
                      {t(
                        networkLoginDiagnostics[state.network.inspection.login] ??
                          networkLoginDiagnostics.unknown,
                      )}
                    </p>
                  )}
                  {state.network.inspection.https && (
                    <p>
                      {state.network.inspection.https === "enabled"
                        ? t("settings.mobileSettings.hostHTTPSSupportIsEnabledThePhone")
                        : networkDiagnostic(
                            t,
                            state.network.inspection.https === "disabled"
                              ? "https-disabled"
                              : "https-unknown",
                          )}
                    </p>
                  )}
                </div>
              )}
            </SettingsDisclosure>
            {state.network?.diagnostic && (
              <p className="remote-error" role="alert">
                {networkDiagnostic(t, state.network.diagnostic)}
              </p>
            )}
            <fieldset
              disabled={busy}
              hidden={accessMethod !== "private"}
              className="remote-access-fields"
            >
              <legend>{t("settings.mobileSettings.tailscaleServePrivateNetwork")}</legend>
              <p className="remote-muted">
                {t("settings.mobileSettings.yourPhoneAndComputerMustJoinThe")}
              </p>
              <label>
                {t("settings.mobileSettings.httpsPort")}
                <Input
                  aria-label={t("settings.mobileSettings.serveHTTPSPort")}
                  type="number"
                  min={1}
                  max={65535}
                  value={httpsPort}
                  onChange={(event) => {
                    setHttpsPort(event.target.value);
                    setProposal(null);
                    setServeConfirmed(false);
                  }}
                />
              </label>
              <Button
                disabled={busy || !state.directEnabled}
                onClick={() =>
                  void run({
                    operation: "networkPropose",
                    httpsPort: Number(httpsPort),
                  })
                }
              >
                {t("settings.mobileSettings.generateServePlan")}
              </Button>
              {proposal && !proposal.scope && (
                <div>
                  <p>{proposal.confirmation}</p>
                  <p>
                    {t("settings.mobileSettings.entryAddress", { origin: proposal.publicOrigin })}
                  </p>
                  <label>
                    <Input
                      unstyled
                      data-slot={undefined}
                      type="checkbox"
                      checked={serveConfirmed}
                      onChange={(event) => setServeConfirmed(event.target.checked)}
                    />
                    {t("settings.mobileSettings.iConfirmThisPlanMayChangeThe")}
                  </label>
                  <Button
                    disabled={busy || !serveConfirmed}
                    onClick={() =>
                      void run({
                        operation: "networkApply",
                        proposalId: proposal.proposalId,
                        confirmed: true,
                      })
                    }
                  >
                    {t("settings.mobileSettings.confirmAndApplyServe")}
                  </Button>
                </div>
              )}
              {!proposal && <p>{t("settings.mobileSettings.generateAPlanThenConfirmItBefore")}</p>}
            </fieldset>
            <fieldset
              disabled={busy}
              hidden={accessMethod !== "public"}
              className="remote-access-fields"
            >
              <legend>{t("settings.mobileSettings.tailscaleFunnelPublicInternet")}</legend>
              <p className="remote-muted">
                {t("settings.mobileSettings.publishTheRemoteEntryPairingAndOperations")}
              </p>
              {state.network?.scope !== "private" && state.network?.scope !== "public" && (
                <p className="remote-muted">
                  {t("settings.mobileSettings.configureServeOnThePrivateNetworkBefore")}
                </p>
              )}
              <SettingsDisclosure title={<> {t("settings.mobileSettings.aboutPublicAccess")}</>}>
                <p>{t("settings.mobileSettings.theEntryStaysPrivateByDefaultFunnel")}</p>
                <p>
                  {t("settings.mobileSettings.savedScopeValue", {
                    scope:
                      state.network?.scope === "public"
                        ? t("settings.mobileSettings.publicInternet")
                        : state.network?.scope === "private"
                          ? t("settings.mobileSettings.private")
                          : t("settings.mobileSettings.needsVerification"),
                  })}
                </p>
                {state.network?.inspection && (
                  <p>
                    {t("settings.mobileSettings.funnelPorts", {
                      ports:
                        state.network.inspection.funnelPorts == null
                          ? t("settings.mobileSettings.unknown")
                          : state.network.inspection.funnelPorts.length
                            ? intl.formatList(state.network.inspection.funnelPorts.map(String), {
                                type: "conjunction",
                              })
                            : t("settings.mobileSettings.none"),
                    })}
                  </p>
                )}
                {state.network?.reconciliation && (
                  <p>
                    {t("settings.mobileSettings.reconciliationReview", {
                      status:
                        {
                          destination: t("settings.mobileSettings.theTargetScopeIsStillPresent"),
                          source: t("settings.mobileSettings.theOriginalScopeIsStillPresent"),
                          absent: t("settings.mobileSettings.theMappingNoLongerExists"),
                          changed: t("settings.mobileSettings.theMappingWasChangedExternally"),
                        }[state.network.reconciliation as string] ??
                        t("settings.mobileSettings.unknown"),
                    })}
                  </p>
                )}
              </SettingsDisclosure>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={
                    busy ||
                    !state.directEnabled ||
                    state.network?.kind !== "tailscale" ||
                    state.network?.scope !== "private"
                  }
                  onClick={() =>
                    void run({
                      operation: "networkProposeScope",
                      scope: "public",
                    })
                  }
                >
                  {t("settings.mobileSettings.generatePublicFunnelPlan")}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    busy ||
                    !state.directEnabled ||
                    state.network?.kind !== "tailscale" ||
                    state.network?.scope !== "public"
                  }
                  onClick={() =>
                    void run({
                      operation: "networkProposeScope",
                      scope: "private",
                    })
                  }
                >
                  {t("settings.mobileSettings.generatePlanToRestorePrivateEntry")}
                </Button>
              </div>
              {proposal?.scope && (
                <div>
                  <p>{proposal.confirmation}</p>
                  <p>
                    {t(
                      "settings.mobileSettings.changingScopeInvalidatesCurrentInvitationsAndConnections",
                    )}
                  </p>
                  <p>
                    {t("settings.mobileSettings.scopeEntryPlan", {
                      origin: proposal.publicOrigin,
                      source:
                        proposal.sourceScope === "private"
                          ? t("settings.mobileSettings.private")
                          : t("settings.mobileSettings.publicInternet"),
                      destination:
                        proposal.scope === "public"
                          ? t("settings.mobileSettings.publicInternet")
                          : t("settings.mobileSettings.private"),
                    })}
                  </p>
                  <label className="block">
                    <Input
                      unstyled
                      data-slot={undefined}
                      type="checkbox"
                      checked={scopeConfirmed}
                      onChange={(event) => setScopeConfirmed(event.target.checked)}
                    />
                    {t("settings.mobileSettings.iConfirmThisPlanMayChangeThe2")}
                  </label>
                  {proposal.scope === "public" && (
                    <label className="block">
                      <Input
                        unstyled
                        data-slot={undefined}
                        type="checkbox"
                        checked={funnelConfirmed}
                        onChange={(event) => setFunnelConfirmed(event.target.checked)}
                      />
                      {t("settings.mobileSettings.iConfirmAgainThatThisRemoteEntry")}
                    </label>
                  )}
                  <Button
                    disabled={
                      busy || !scopeConfirmed || (proposal.scope === "public" && !funnelConfirmed)
                    }
                    onClick={() =>
                      void run({
                        operation: "networkChangeScope",
                        proposalId: proposal.proposalId,
                        confirmed: true,
                        publicConfirmed: funnelConfirmed,
                      })
                    }
                  >
                    {t("settings.mobileSettings.confirmAccessScopeChange")}
                  </Button>
                </div>
              )}
            </fieldset>
            <fieldset
              disabled={busy}
              hidden={accessMethod !== "organization"}
              className="remote-access-fields"
            >
              <legend>{t("settings.mobileSettings.organizationHTTPS")}</legend>
              <p className="remote-muted">
                {t("settings.mobileSettings.useAnHTTPSEntryConfiguredByYour")}
              </p>
              <label>
                {t("settings.mobileSettings.httpsOrigin")}
                <Input
                  aria-label={t("settings.mobileSettings.organizationHTTPSOrigin")}
                  placeholder="https://remote.example.com"
                  value={organizationOrigin}
                  onChange={(event) => {
                    setOrganizationOrigin(event.target.value);
                    setOrganizationConfirmed(false);
                    setPublicConfirmed(false);
                  }}
                />
              </label>
              <div className="settings-choice-field">
                {t("settings.mobileSettings.accessScope")}
                <SettingsSelect
                  aria-label={t("settings.mobileSettings.organizationEntryAccessScope")}
                  value={visibility}
                  onValueChange={(selectedValue) => {
                    if (selectedValue !== "private" && selectedValue !== "public") return;
                    setVisibility(selectedValue);
                    setOrganizationConfirmed(false);
                    setPublicConfirmed(false);
                  }}
                >
                  <option value="private">
                    {t("settings.mobileSettings.privateOrganizationNetwork")}
                  </option>
                  <option value="public">
                    {t("settings.mobileSettings.mayBePubliclyAccessible")}
                  </option>
                </SettingsSelect>
              </div>
              <SettingsDisclosure
                title={<> {t("settings.mobileSettings.organizationEntryRequirements")}</>}
              >
                <p>{t("settings.mobileSettings.thisSavesOnlyTheExactHTTPSOrigin")}</p>
              </SettingsDisclosure>
              <label className="block">
                <Input
                  unstyled
                  data-slot={undefined}
                  type="checkbox"
                  checked={organizationConfirmed}
                  onChange={(event) => setOrganizationConfirmed(event.target.checked)}
                />
                {t("settings.mobileSettings.iConfirmTheOrganizationEntryIsReady")}
              </label>
              {visibility === "public" && (
                <label className="block">
                  <Input
                    unstyled
                    data-slot={undefined}
                    type="checkbox"
                    checked={publicConfirmed}
                    onChange={(event) => setPublicConfirmed(event.target.checked)}
                  />
                  {t("settings.mobileSettings.iConfirmAgainThatThisHTTPSEntry")}
                </label>
              )}
              <Button
                disabled={
                  busy ||
                  !state.directEnabled ||
                  !organizationConfirmed ||
                  (visibility === "public" && !publicConfirmed)
                }
                onClick={() =>
                  void run({
                    operation: "networkConfigureOrganization",
                    publicOrigin: organizationOrigin,
                    visibility,
                    confirmed: true,
                    publicConfirmed,
                  })
                }
              >
                {t("settings.mobileSettings.saveOrganizationHTTPSOrigin")}
              </Button>
            </fieldset>
            <div
              className="remote-network-status"
              role="status"
              aria-label={t("settings.mobileSettings.networkConfigurationStatus")}
            >
              <span>{t("settings.mobileSettings.configurationStatus")}</span>
              <strong>
                {state.network?.kind
                  ? !state.network.scope
                    ? t("settings.mobileSettings.needsVerification")
                    : state.network.kind === "organization"
                      ? t("settings.mobileSettings.organizationEntry")
                      : state.network.scope === "public"
                        ? t("settings.mobileSettings.publicEntry")
                        : t("settings.mobileSettings.privateEntry")
                  : t("settings.mobileSettings.notConfigured")}
              </strong>
              <span>{t("settings.mobileSettings.phoneConnectionNeedsVerification")}</span>
            </div>
            {state.network?.kind && (
              <SettingsDisclosure
                className="remote-network-recovery"
                title={<> {t("settings.mobileSettings.restoreOrRemoveThisAppSNetwork")}</>}
              >
                <fieldset disabled={busy} className="p-4">
                  <p>{t("settings.mobileSettings.restoreChecksTheActualScopeOfThe")}</p>
                  <label>
                    <Input
                      unstyled
                      data-slot={undefined}
                      type="checkbox"
                      checked={recoveryConfirmed}
                      onChange={(event) => setRecoveryConfirmed(event.target.checked)}
                    />
                    {t("settings.mobileSettings.iConfirmOnlyThisAppSRecords")}
                  </label>
                  <div className="flex gap-2">
                    <Button
                      disabled={busy || !recoveryConfirmed}
                      onClick={() =>
                        void run({
                          operation: "networkRecover",
                          confirmed: true,
                        })
                      }
                    >
                      {t("settings.mobileSettings.verifyAndRestore")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy || !recoveryConfirmed}
                      onClick={() =>
                        void run({
                          operation: "networkRemove",
                          confirmed: true,
                        })
                      }
                    >
                      {t("settings.mobileSettings.removeNetworkConfiguration")}
                    </Button>
                  </div>
                </fieldset>
              </SettingsDisclosure>
            )}
          </SettingsGroupCard>
        </SettingsSection>
        <SettingsSection
          title={t("settings.mobileConnect.directEntry")}
          description={t("settings.mobileConnect.directEntryDescription")}
        >
          {state.directEnabled ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void runCommand({ operation: "disableDirect" })}
            >
              {t("settings.mobileSettings.turnOffRemoteAndRemoveMapping")}
            </Button>
          ) : (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void runCommand({ operation: "enableDirect" })}
            >
              {t("settings.mobileSettings.enableLocalEntry")}
            </Button>
          )}
        </SettingsSection>
        {reconnectUrl && (
          <SettingsDisclosure
            className="remote-reconnect"
            title={<> {t("settings.mobileSettings.howDoExistingDevicesReconnect")}</>}
          >
            <p>{t("settings.mobileSettings.openThisLinkInAnAuthorizedBrowser")}</p>
            <Input
              aria-label={t("settings.mobileSettings.currentConnectionLink")}
              readOnly
              value={reconnectUrl}
              onFocus={(event) => event.target.select()}
            />
          </SettingsDisclosure>
        )}
      </div>
    </SettingsDisclosure>
  );
}
