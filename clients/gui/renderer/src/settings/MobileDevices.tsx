import { useState } from "react";
import { Monitor, MoreHorizontal, Smartphone } from "lucide-react";
import {
  Button,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from "@areal/ui";
import { SettingsGroupCard } from "@areal/ui/compositions";
import { useI18n } from "../i18n/IntlProvider.js";
import { SettingsDialog } from "./common.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { GrantReview } from "./RemoteGrantReview.js";
import type { CommandParams, Data } from "../services.js";

type Run = (request: CommandParams<"remoteControl">) => Promise<Data | undefined>;

const deviceName = (device: Data) => device.displayName ?? device.name ?? "";

function DeviceIcon({ device }: { device: Data }) {
  return ["ios", "android"].includes(device.clientKind) ? (
    <Smartphone size={18} aria-hidden />
  ) : (
    <Monitor size={18} aria-hidden />
  );
}

/** 设备行固定四列：图标、名称与说明、权限、更多操作。 */
function DeviceRow({
  device,
  meta,
  status,
  actions,
}: {
  device: Data;
  meta: string;
  status: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="remote-device-row" data-status={device.status}>
      <DeviceIcon device={device} />
      <div className="remote-device-text">
        <strong>{deviceName(device)}</strong>
        <small>{meta}</small>
      </div>
      <span className="remote-device-status">{status}</span>
      <span className="remote-device-actions">{actions}</span>
    </div>
  );
}

export function MobileDevices({
  devices,
  projects,
  busy,
  run,
  reconnectUrl,
  error,
}: {
  devices: Data[];
  projects: Data[];
  busy: boolean;
  run: Run;
  reconnectUrl: string;
  error?: string;
}) {
  const { t, intl } = useI18n();
  const failure = error ? (
    <p className="remote-error" role="alert">
      {error}
    </p>
  ) : null;
  const [managing, setManaging] = useState<Data | null>(null);
  const [renaming, setRenaming] = useState<{ device: Data; name: string } | null>(null);
  const [revoking, setRevoking] = useState<Data | null>(null);
  const active = devices.filter((device) => device.status !== "revoked");
  const revoked = devices.filter((device) => device.status === "revoked");
  const when = (value: number) =>
    intl.formatDate(value, {
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  const metaOf = (device: Data) =>
    [
      t(
        device.clientKind === "ios"
          ? "settings.mobileSettings.clientKindIOS"
          : device.clientKind === "android"
            ? "settings.mobileSettings.clientKindAndroid"
            : "settings.mobileSettings.clientKindWeb",
      ),
      t("settings.mobileConnect.projectCount", { count: device.projectIds?.length ?? 0 }),
      device.online
        ? t("settings.mobileConnect.online")
        : device.lastSeenAt
          ? t("settings.mobileConnect.lastSeen", { time: when(device.lastSeenAt) })
          : device.pairedAt
            ? t("settings.mobileConnect.pairedAt", { time: when(device.pairedAt) })
            : "",
      device.clientKind === "ios"
        ? t(
            device.pushRegistered
              ? "settings.mobileSettings.pushRegistered"
              : "settings.mobileSettings.pushUnregistered",
          )
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const statusOf = (device: Data) =>
    device.status === "reviewRequired" ? (
      <span className="remote-status-warning">{t("settings.mobileSettings.needsReview")}</span>
    ) : device.capabilities?.includes("submit") ? (
      t("settings.mobileSettings.canOperate")
    ) : (
      t("settings.mobileSettings.viewOnly")
    );
  const finish = async (request: CommandParams<"remoteControl">, close: () => void) => {
    if (await run(request)) close();
  };
  return (
    <section className="remote-devices" aria-label={t("settings.mobileConnect.devices")}>
      <header className="remote-section-head">
        <h2>{t("settings.mobileConnect.devices")}</h2>
        {active.length > 0 && (
          <small>{t("settings.mobileConnect.activeCount", { count: active.length })}</small>
        )}
      </header>
      <SettingsGroupCard className="remote-device-list">
        {active.map((device) => (
          <DeviceRow
            key={device.devicePeerId}
            device={device}
            meta={metaOf(device)}
            status={statusOf(device)}
            actions={
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("settings.mobileConnect.deviceActions", {
                        device: deviceName(device),
                      })}
                    >
                      <MoreHorizontal size={18} />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setManaging(device)}>
                    {t("settings.mobileConnect.editAccess")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setRenaming({ device, name: deviceName(device) })}
                  >
                    {t("settings.mobileConnect.rename")}
                  </DropdownMenuItem>
                  {reconnectUrl && (
                    <DropdownMenuItem
                      onClick={() =>
                        void navigator.clipboard.writeText(reconnectUrl).catch(() => {})
                      }
                    >
                      {t("settings.mobileConnect.copyReconnectLink")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setRevoking(device)}>
                    {t("settings.mobileSettings.revokeAccess")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            }
          />
        ))}
        {!active.length && (
          <p className="settings-card-empty">{t("settings.mobileConnect.noDevices")}</p>
        )}
      </SettingsGroupCard>
      {revoked.length > 0 && (
        <SettingsDisclosure
          className="remote-revoked"
          title={
            <span>{t("settings.mobileConnect.revokedDevices", { count: revoked.length })}</span>
          }
        >
          <div className="remote-revoked-body">
            <SettingsGroupCard className="remote-device-list">
              {revoked.map((device) => (
                <DeviceRow
                  key={`${device.devicePeerId}:${device.revision}`}
                  device={device}
                  meta={[
                    t(
                      device.clientKind === "ios"
                        ? "settings.mobileSettings.clientKindIOS"
                        : device.clientKind === "android"
                          ? "settings.mobileSettings.clientKindAndroid"
                          : "settings.mobileSettings.clientKindWeb",
                    ),
                    device.revokedAt
                      ? t("settings.mobileConnect.revokedAt", { time: when(device.revokedAt) })
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  status={t("settings.mobileSettings.revoked")}
                />
              ))}
            </SettingsGroupCard>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run({ operation: "forgetRevoked" })}
            >
              {t("settings.mobileConnect.forgetRevoked")}
            </Button>
          </div>
        </SettingsDisclosure>
      )}
      {managing && (
        <SettingsDialog
          className="remote-dialog"
          title={t("settings.mobileConnect.editAccessTitle", { device: deviceName(managing) })}
          description={t("settings.mobileConnect.editAccessDescription")}
          busy={busy}
          onClose={() => setManaging(null)}
        >
          {failure}
          <GrantReview
            device={managing}
            projects={projects}
            busy={busy}
            onCancel={() => setManaging(null)}
            run={async (request) => {
              const result = await run(request);
              if (result) setManaging(null);
              return result;
            }}
          />
        </SettingsDialog>
      )}
      {renaming && (
        <SettingsDialog
          className="remote-dialog"
          title={t("settings.mobileConnect.rename")}
          description={t("settings.mobileConnect.renameDescription")}
          busy={busy}
          onClose={() => setRenaming(null)}
        >
          {failure}
          <form
            className="remote-rename"
            onSubmit={(event) => {
              event.preventDefault();
              void finish(
                {
                  operation: "renameDevice",
                  id: renaming.device.devicePeerId,
                  name: renaming.name,
                },
                () => setRenaming(null),
              );
            }}
          >
            <Input
              aria-label={t("settings.mobileConnect.deviceName")}
              autoFocus
              maxLength={80}
              value={renaming.name}
              onChange={(event) => setRenaming({ ...renaming, name: event.target.value })}
            />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
                {t("settings.mobileConnect.cancel")}
              </Button>
              <Button type="submit" disabled={busy || !renaming.name.trim()}>
                {t("settings.mobileConnect.save")}
              </Button>
            </DialogFooter>
          </form>
        </SettingsDialog>
      )}
      {revoking && (
        <SettingsDialog
          className="remote-dialog"
          title={t("settings.mobileConnect.revokeTitle", { device: deviceName(revoking) })}
          description={t("settings.mobileConnect.revokeDescription")}
          busy={busy}
          onClose={() => setRevoking(null)}
        >
          {failure}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {t("settings.mobileConnect.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void finish({ operation: "revoke", id: revoking.devicePeerId }, () =>
                  setRevoking(null),
                )
              }
            >
              {t("settings.mobileSettings.revokeAccess")}
            </Button>
          </DialogFooter>
        </SettingsDialog>
      )}
    </section>
  );
}
