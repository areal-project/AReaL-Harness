import { useEffect, useState } from "react";
import { Button, Input } from "@areal/ui";
import { SettingsGroupCard, SettingsSection } from "@areal/ui/compositions";
import { useI18n } from "../i18n/IntlProvider.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { RelayEnrollForm } from "./MobileAdvancedNetwork.js";
import type { CommandParams, Data } from "../services.js";

type Run = (request: CommandParams<"remoteControl">) => Promise<Data | undefined>;

export function RelayServicePanel({ state, busy, run }: { state: Data; busy: boolean; run: Run }) {
  const { t } = useI18n();
  const [target, setTarget] = useState("");
  const [port, setPort] = useState("22");
  const [address, setAddress] = useState("");
  const [removeData, setRemoveData] = useState(false);
  const service = state.relayService;
  const deployment = service?.deployment;
  const job = service?.job;
  const editable = !deployment || deployment.phase === "failed" || deployment.phase === "removed";
  useEffect(() => {
    if (!deployment) return;
    setTarget(deployment.target);
    setPort(String(deployment.port));
    setAddress(deployment.address);
  }, [deployment?.target, deployment?.port, deployment?.address]);
  const working = busy || job?.phase === "running";
  const running = service?.local?.phase === "running";
  return (
    <SettingsSection
      title={t("settings.relayService.title")}
      description={t("settings.relayService.description")}
    >
      <SettingsGroupCard className="remote-relay-service">
        <div className="remote-relay-service-heading">
          <div>
            <strong>{t("settings.relayService.local")}</strong>
            <p className="remote-muted">{t("settings.relayService.localDescription")}</p>
          </div>
          <Button
            variant={running ? "outline" : "default"}
            disabled={working || service?.local?.phase === "starting"}
            onClick={() =>
              void run({ operation: running ? "relayServiceStopLocal" : "relayServiceStartLocal" })
            }
          >
            {t(running ? "settings.relayService.stopLocal" : "settings.relayService.startLocal")}
          </Button>
        </div>
        {running && (
          <p className="remote-muted" role="status">
            {t("settings.relayService.localRunning", { address: service.local.address })}
          </p>
        )}
        {service?.local?.error && (
          <p className="remote-error" role="alert">
            {service.local.error}
          </p>
        )}
        <SettingsDisclosure title={t("settings.relayService.ssh")}>
          <p className="remote-muted">{t("settings.relayService.sshDescription")}</p>
          {deployment ? (
            <div className="remote-relay-form">
              <p>
                {deployment.target} · {deployment.address}
              </p>
              <p className="remote-muted" role="status">
                {t(
                  deployment.phase === "pending"
                    ? "settings.relayService.pending"
                    : deployment.active
                      ? "settings.relayService.serverRunning"
                      : "settings.relayService.serverStopped",
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={working}
                  onClick={() => void run({ operation: "relayServiceInspect" })}
                >
                  {t("settings.relayService.inspect")}
                </Button>
                <Button
                  variant="outline"
                  disabled={
                    working || deployment.phase === "pending" || deployment.phase === "removed"
                  }
                  onClick={() => void run({ operation: "relayServiceUpgrade" })}
                >
                  {t("settings.relayService.upgrade")}
                </Button>
              </div>
              <SettingsDisclosure title={t("settings.relayService.remove")}>
                <label className="remote-relay-remove-data">
                  <Input
                    type="checkbox"
                    unstyled
                    data-slot={undefined}
                    checked={removeData}
                    onChange={(event) => setRemoveData(event.target.checked)}
                  />
                  {t("settings.relayService.removeData")}
                </label>
                <Button
                  variant="outline"
                  disabled={
                    working ||
                    deployment.phase === "pending" ||
                    (deployment.phase === "removed" && deployment.canReconfigure)
                  }
                  onClick={() => void run({ operation: "relayServiceRemove", removeData })}
                >
                  {t("settings.relayService.remove")}
                </Button>
              </SettingsDisclosure>
            </div>
          ) : null}
          {editable && (
            <fieldset className="remote-relay-form" disabled={working}>
              {deployment && (
                <p className="remote-muted">
                  {t(
                    deployment.canReconfigure
                      ? "settings.relayService.reconfigure"
                      : "settings.relayService.correctAddress",
                  )}
                </p>
              )}
              <label>
                {t("settings.relayService.target")}
                <Input
                  aria-label={t("settings.relayService.target")}
                  value={target}
                  disabled={deployment && !deployment.canReconfigure}
                  placeholder={t("settings.relayService.targetPlaceholder")}
                  onChange={(event) => setTarget(event.target.value)}
                />
              </label>
              <label>
                {t("settings.relayService.port")}
                <Input
                  aria-label={t("settings.relayService.port")}
                  type="number"
                  min="1"
                  max="65535"
                  value={port}
                  disabled={deployment && !deployment.canReconfigure}
                  onChange={(event) => setPort(event.target.value)}
                />
              </label>
              <label>
                {t("settings.relayService.address")}
                <Input
                  aria-label={t("settings.relayService.address")}
                  value={address}
                  placeholder="https://relay.example.com"
                  onChange={(event) => setAddress(event.target.value)}
                />
              </label>
              <Button
                disabled={!target || !address || !Number.isInteger(Number(port))}
                onClick={() =>
                  void run({ operation: "relayServiceDeploy", target, port: Number(port), address })
                }
              >
                {t("settings.relayService.deploy")}
              </Button>
            </fieldset>
          )}
          {job && (
            <p
              className={job.error ? "remote-error" : "remote-muted"}
              role={job.error ? "alert" : "status"}
            >
              {job.phase === "running"
                ? t("settings.relayService.working")
                : job.error || t("settings.relayService.finished")}
            </p>
          )}
        </SettingsDisclosure>
        <SettingsDisclosure title={t("settings.relayService.external")}>
          <p className="remote-muted">{t("settings.relayService.externalDescription")}</p>
          <RelayEnrollForm state={state} busy={busy} run={run} />
        </SettingsDisclosure>
        {service?.profiles?.length > 0 && (
          <SettingsDisclosure title={t("settings.relayService.saved")}>
            <div className="remote-relay-profiles">
              {service.profiles.map((profile: Data) => (
                <div key={profile.origin} className="remote-relay-service-heading">
                  <span>{profile.origin}</span>
                  <Button
                    variant="outline"
                    disabled={working || profile.active}
                    onClick={() => void run({ operation: "relayUse", origin: profile.origin })}
                  >
                    {t(
                      profile.active
                        ? "settings.relayService.selected"
                        : "settings.relayService.use",
                    )}
                  </Button>
                </div>
              ))}
            </div>
          </SettingsDisclosure>
        )}
      </SettingsGroupCard>
    </SettingsSection>
  );
}
