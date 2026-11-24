import { useEffect, useRef, useState } from "react";
import { currentErrorText } from "../errors/currentErrorText.js";
import { errorCode, presentError } from "../errors/errorCopy.js";
import { Smartphone } from "lucide-react";
import { Button } from "@areal/ui";
import { SettingsGroupCard } from "@areal/ui/compositions";
import { useI18n, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { MobileAdvancedNetwork, networkDiagnostics } from "./MobileAdvancedNetwork.js";
import { MobileAddDevice, type AddDeviceStep } from "./MobileAddDevice.js";
import { RelayServicePanel } from "./RelayServicePanel.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { MobileDevices } from "./MobileDevices.js";
import "./MobileSettings.css";

import type { Action, CommandParams, Data } from "../services.js";

type Tone = "good" | "warning" | "idle";
const credentialErrors = new Set([
  "remoteCredentialUnreadable",
  "storageAuthorizationRequired",
  "credentialHostRestartRequired",
  "storageLocked",
  "storageMissing",
]);

const connectionStatusErrors = new Set(["DISCONNECTED", "CORE_UNAVAILABLE", "TIMEOUT"]);

/**
 * 手机连接页：一张状态卡回答“手机现在能不能连”，下面是设备列表；
 * 网络细节收进高级网络设置。默认通过中继配对，未开启中继时才使用本机入口。
 */
export function MobileSettings({ action, projects }: { action: Action; projects: Data[] }) {
  const { t } = useI18n();
  const [state, setState] = useState<Data>({ deviceGrants: [], pending: [] });
  const [error, setError] = useState<string | UiMessage>(""),
    [errorDetail, setErrorDetail] = useState(""),
    [busy, setBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | UiMessage>("");
  const [statusErrorDetail, setStatusErrorDetail] = useState("");
  const [credentialError, setCredentialError] = useState("");
  const [invite, setInvite] = useState<Data | null>(null);
  const [inviteExpired, setInviteExpired] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pairedName, setPairedName] = useState("");
  const doneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const directUrl = useRef("");
  const run = async (request: CommandParams<"remoteControl">): Promise<Data | undefined> => {
    setBusy(true);
    setError("");
    setErrorDetail("");
    try {
      const result = await action("remoteControl", request);
      setStatusError("");
      setStatusErrorDetail("");
      setCredentialError("");
      if (request.operation === "pair") {
        setInvite(result);
        setInviteExpired(false);
      } else if (
        request.operation !== "networkPropose" &&
        request.operation !== "networkProposeScope"
      ) {
        const status = result as Data;
        setState(status);
        if (status.directUrl !== directUrl.current) setInvite(null);
        directUrl.current = status.directUrl ?? "";
      }
      return result ?? {};
    } catch (error) {
      const failure = error as Error & { code?: string };
      const presented = presentError(t, failure);
      if (credentialErrors.has(failure.code ?? "")) {
        setCredentialError(presented.message);
        return undefined;
      }
      setError(
        request.operation.startsWith("network") && typeof failure.code === "string"
          ? {
              id:
                networkDiagnostics[failure.code] ?? "settings.mobileSettings.networkStatusUnknown",
              values: { code: failure.code },
            }
          : presented.message,
      );
      setErrorDetail(presented.detail ?? "");
      // 变更出错后补拉一次权威状态，避免后台已启动或已记录诊断但界面停留在旧状态。
      if (request.operation !== "status") {
        void action("remoteControl", { operation: "status" })
          .then((latest) => {
            setState(latest);
            setStatusError("");
            setStatusErrorDetail("");
            directUrl.current = latest.directUrl ?? "";
          })
          .catch(() => {});
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    let live = true;
    const read = () =>
      action("remoteControl", { operation: "status" })
        .then((value) => {
          if (!live) return;
          setState(value);
          setStatusError("");
          setStatusErrorDetail("");
          directUrl.current = value.directUrl ?? "";
        })
        .catch((error) => {
          if (!live) return;
          const code = errorCode(error);
          const presented = presentError(t, error);
          setStatusErrorDetail(presented.detail ?? "");
          setStatusError(
            code && !connectionStatusErrors.has(code)
              ? presented.message
              : credentialErrors.has(code ?? "")
                ? currentErrorText(error)
                : {
                    id: "settings.mobileSettings.theHostIsOfflineOrTheBackground",
                    values: { value0: presented.message },
                  },
          );
        });
    void read();
    const timer = setInterval(() => {
      void read();
      setInvite((old) => {
        if (old && old.expiresAt <= Date.now()) {
          setInviteExpired(true);
          return null;
        }
        return old;
      });
    }, 2000);
    return () => {
      live = false;
      clearInterval(timer);
      clearTimeout(doneTimer.current);
    };
  }, [action, t]);

  const transport = state.enabled ? "relay" : "direct";
  const credentialHint = credentialError || state.migrationError;
  const reconnectUrl =
    transport === "relay"
      ? state.relayUrl
      : state.directUrl && state.directHostId
        ? `${state.directUrl}/#host=${encodeURIComponent(state.directHostId)}`
        : "";
  const relayConnected = Boolean(state["connected"]);
  const entryReady = transport === "relay" ? relayConnected : state.directEnabled;
  const pendingOperation: { requestId?: string; operation?: string } | null =
    state.pendingOperation && typeof state.pendingOperation === "object"
      ? state.pendingOperation
      : null;
  const localRelay =
    state.relay?.startsWith("http:") ||
    state.relayService?.local?.address === state.relay ||
    (Array.isArray(state.relayService?.profiles) &&
      state.relayService.profiles.some(
        (profile: Data) =>
          profile.kind === "local" && (profile.active || profile.origin === state.relay),
      ));
  const localRelayFailed = localRelay && state.relayService?.local?.phase === "failed";
  const pending: Data | undefined = state.pending?.[0];
  const step: AddDeviceStep = pairedName ? "done" : pending ? "review" : "scan";
  const relayHost = (() => {
    try {
      return new URL(state.relay).host;
    } catch {
      return state.relay ?? "";
    }
  })();

  const status: { tone: Tone; title: string; description: string } = state.enabled
    ? relayConnected
      ? {
          tone: "good",
          title: t("settings.mobileConnect.ready"),
          description: t(
            localRelay
              ? "settings.relayService.readyLocal"
              : "settings.mobileConnect.readyViaRelay",
            { host: relayHost },
          ),
        }
      : localRelayFailed
        ? {
            tone: "warning",
            title: t("settings.mobileConnect.relayOffline"),
            description:
              state.relayService?.local?.error ||
              t("settings.mobileConnect.relayOfflineDescription", { host: relayHost }),
          }
        : {
            tone: "warning",
            title: t("settings.mobileConnect.relayOffline"),
            description: t("settings.mobileConnect.relayOfflineDescription", { host: relayHost }),
          }
    : state.directEnabled
      ? reconnectUrl.startsWith("https://")
        ? {
            tone: "good",
            title: t("settings.mobileConnect.ready"),
            description: t("settings.mobileConnect.readyViaDirect", {
              host: new URL(state.directUrl).host,
            }),
          }
        : {
            tone: "warning",
            title: t("settings.mobileSettings.onlyABrowserOnThisComputerCan"),
            description: t("settings.mobileConnect.localOnlyDescription"),
          }
      : {
          tone: "idle",
          title: t("settings.mobileConnect.notSetUp"),
          description: t("settings.mobileConnect.notSetUpDescription"),
        };

  const pair = () => {
    setInviteExpired(false);
    void run({ operation: "pair", transport });
  };
  const startAdding = () => {
    setPairedName("");
    setAdding(true);
    pair();
  };
  const closeAdding = () => {
    // 核对中的请求保留，用户可从横幅回来；只有还在等扫码时才作废邀请。
    if (invite && !pending && !pairedName) void run({ operation: "cancelPair" });
    clearTimeout(doneTimer.current);
    setAdding(false);
    setInvite(null);
    setInviteExpired(false);
    setPairedName("");
  };
  const review = async (request: CommandParams<"remoteControl">) => {
    const name = pending?.name ?? "";
    const result = await run(request);
    if (!result) return result;
    if (request.operation === "approve") {
      setInvite(null);
      setPairedName(name);
      doneTimer.current = setTimeout(closeAdding, 2000);
    } else if (request.operation === "reject" && !invite) closeAdding();
    return result;
  };

  return (
    <div
      className="settings-sections remote-settings"
      aria-label={t("settings.mobileSettings.phoneConnectionSettings")}
    >
      {pending && !adding && (
        <div className="remote-request" role="status">
          <Smartphone size={18} aria-hidden />
          <div>
            <strong>{t("settings.mobileConnect.requestTitle", { device: pending.name })}</strong>
            <small>{t("settings.mobileConnect.requestDescription")}</small>
          </div>
          <Button onClick={() => setAdding(true)}>
            {t("settings.mobileConnect.reviewRequest")}
          </Button>
        </div>
      )}
      <SettingsGroupCard layout="grid">
        <div className="remote-status" data-tone={status.tone}>
          <span className="remote-status-icon" aria-hidden>
            {status.tone === "idle" ? <Smartphone size={18} /> : <span className="remote-dot" />}
          </span>
          <div className="remote-status-text">
            <strong>{status.title}</strong>
            <small>{status.description}</small>
          </div>
          {state.enabled || state.directEnabled ? (
            <Button disabled={busy || !entryReady} onClick={startAdding}>
              {t("settings.mobileConnect.addDevice")}
            </Button>
          ) : (
            <Button
              disabled={busy}
              onClick={() => void run({ operation: "relayServiceStartLocal" })}
            >
              {t("settings.relayService.startLocal")}
            </Button>
          )}
        </div>
        {state.enabled ? (
          <p className="remote-muted" role="status">
            {t(
              localRelay
                ? "settings.relayService.localSelected"
                : "settings.mobileConnect.enrolled",
              { host: relayHost },
            )}
          </p>
        ) : state.directEnabled ? (
          <div className="flex">
            <Button
              disabled={busy}
              onClick={() => void run({ operation: "relayServiceStartLocal" })}
            >
              {t("settings.relayService.startLocal")}
            </Button>
          </div>
        ) : null}
        {!adding && pendingOperation?.requestId && (
          <div className="remote-status" data-tone="warning" role="status">
            <div className="remote-status-text">
              <strong>上次手机连接操作结果尚未确认</strong>
              <small>
                原请求 {String(pendingOperation.requestId).slice(0, 8)}…
                尚未核对完成，核对前无法发起新的手机连接更改。
              </small>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run({ operation: "status" })}
            >
              核对上次操作
            </Button>
          </div>
        )}
        {!adding && credentialHint && (
          <p className="remote-error" role="alert">
            {credentialHint}
          </p>
        )}
      </SettingsGroupCard>
      {!adding && !credentialHint && (error || state.directError || statusError) && (
        <div className="remote-error" role="alert">
          <p>{formatUiMessage(t, error) || state.directError || formatUiMessage(t, statusError)}</p>
          {(errorDetail || (!error && !state.directError && statusErrorDetail)) && (
            <SettingsDisclosure title={t("recovery.details")}>
              <code className="remote-muted">{errorDetail || statusErrorDetail}</code>
            </SettingsDisclosure>
          )}
        </div>
      )}
      <RelayServicePanel state={state} busy={busy} run={run} />
      <MobileDevices
        devices={state.deviceGrants ?? []}
        projects={projects}
        busy={busy}
        run={run}
        reconnectUrl={reconnectUrl ?? ""}
        error={credentialHint || formatUiMessage(t, error)}
      />
      <MobileAdvancedNetwork
        state={state}
        busy={busy}
        run={run}
        reconnectUrl={reconnectUrl ?? ""}
      />
      {adding && (
        <MobileAddDevice
          step={step}
          invite={invite}
          inviteExpired={inviteExpired}
          pending={pending}
          pairedName={pairedName}
          projects={projects}
          busy={busy}
          run={review}
          onRegenerate={pair}
          onClose={closeAdding}
          error={formatUiMessage(t, error)}
        />
      )}
    </div>
  );
}
