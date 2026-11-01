import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { Button, Input } from "@areal/ui";
import { useI18n } from "../i18n/IntlProvider.js";
import { SettingsDialog } from "./common.js";
import { GrantReview } from "./RemoteGrantReview.js";
import type { CommandParams, Data } from "../services.js";

type Run = (request: CommandParams<"remoteControl">) => Promise<Data | undefined>;
export type AddDeviceStep = "scan" | "review" | "done";

/** 剩余秒数，按 m:ss 显示；邀请由 Host 在 120 秒后作废。 */
function useRemaining(expiresAt: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  const seconds = Math.max(0, Math.ceil(((expiresAt ?? now) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Steps({ step }: { step: AddDeviceStep }) {
  const { t } = useI18n();
  const order: AddDeviceStep[] = ["scan", "review", "done"];
  const labels = {
    scan: t("settings.mobileConnect.stepScan"),
    review: t("settings.mobileConnect.stepReview"),
    done: t("settings.mobileConnect.stepDone"),
  };
  const current = order.indexOf(step);
  return (
    <ol className="remote-steps" aria-label={t("settings.mobileSettings.connectionSteps")}>
      {order.map((value, index) => (
        <li
          key={value}
          data-current={index === current}
          data-complete={index < current}
          aria-current={index === current ? "step" : undefined}
        >
          {index < current && <Check size={12} aria-hidden />}
          {labels[value]}
        </li>
      ))}
    </ol>
  );
}

/**
 * 添加设备对话框：扫码 → 核对 → 完成。手机扫码后 Host 出现待确认请求，对话框自动进入核对。
 * 从横幅打开时没有邀请，直接从核对开始。
 */
export function MobileAddDevice({
  step,
  invite,
  inviteExpired,
  pending,
  pairedName,
  projects,
  busy,
  run,
  onRegenerate,
  onClose,
  error,
}: {
  step: AddDeviceStep;
  invite: Data | null;
  inviteExpired: boolean;
  pending?: Data;
  pairedName: string;
  projects: Data[];
  busy: boolean;
  run: Run;
  onRegenerate: () => void;
  onClose: () => void;
  error?: string;
}) {
  const { t } = useI18n();
  const remaining = useRemaining(invite?.expiresAt);
  const [copied, setCopied] = useState(false);
  const localApp =
    invite?.payload.startsWith("http://") &&
    new URLSearchParams(invite.payload.split("#")[1]).get("local") === "1";
  const scannable = invite?.payload.startsWith("https://") || localApp;
  const title =
    step === "review" && pending
      ? t("settings.mobileConnect.reviewTitle", { device: pending.name })
      : step === "done"
        ? t("settings.mobileConnect.doneTitle", { device: pairedName })
        : invite && !scannable
          ? t("settings.mobileSettings.onlyABrowserOnThisComputerCan")
          : t("settings.mobileConnect.scanTitle");
  const description =
    step === "review"
      ? t("settings.mobileConnect.reviewDescription")
      : step === "done"
        ? t("settings.mobileConnect.doneDescription")
        : localApp
          ? t("settings.relayService.scanLocal")
          : scannable
            ? t("settings.mobileConnect.scanDescription")
            : invite
              ? t("settings.mobileConnect.localInvitationDescription")
              : t("settings.mobileConnect.generating");
  return (
    <SettingsDialog
      className="remote-dialog remote-add-device"
      title={title}
      description={description}
      onClose={onClose}
    >
      <Steps step={step} />
      {error && (
        <p className="remote-error" role="alert">
          {error}
        </p>
      )}
      {step === "scan" && (
        <div className="remote-invitation">
          {invite && !inviteExpired && (
            <img
              width="168"
              height="168"
              src={invite.qr}
              alt={t("settings.mobileSettings.phonePairingQRCode")}
            />
          )}
          {inviteExpired ? (
            <div className="remote-invitation-expired" role="status">
              <p>{t("settings.mobileSettings.thePairingInvitationHasExpiredGenerateA")}</p>
              <Button disabled={busy} onClick={onRegenerate}>
                {t("settings.mobileConnect.regenerate")}
              </Button>
            </div>
          ) : invite ? (
            <p className="remote-invitation-timer" role="status">
              <span className="remote-dot" data-tone="good" aria-hidden />
              {t(
                scannable
                  ? "settings.mobileConnect.waiting"
                  : "settings.mobileConnect.waitingLocal",
                { time: remaining },
              )}
            </p>
          ) : (
            <p className="remote-invitation-timer" role="status">
              {t("settings.mobileConnect.generating")}
            </p>
          )}
          {invite && !inviteExpired && (
            <div className="remote-invitation-link">
              <Input
                aria-label={t("settings.mobileSettings.pairingLink")}
                readOnly
                value={invite.payload}
                // 对话框打开时会聚焦这里；保持显示链接开头。
                onFocus={(event) => (event.currentTarget.scrollLeft = 0)}
              />
              <Button
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(invite.payload)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false));
                }}
              >
                {copied
                  ? t("settings.mobileConnect.copied")
                  : t("settings.mobileSettings.copyLink")}
              </Button>
            </div>
          )}
        </div>
      )}
      {step === "review" && pending && (
        <GrantReview device={pending} projects={projects} pending busy={busy} run={run} />
      )}
      {step === "done" && (
        <p className="remote-done" role="status">
          <Check size={16} aria-hidden />
          {t("settings.mobileConnect.connected")}
        </p>
      )}
    </SettingsDialog>
  );
}
