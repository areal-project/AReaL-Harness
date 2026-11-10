import { useEffect, useRef, useState } from "react";
import { currentErrorText } from "../errors/currentErrorText.js";
import { Smartphone } from "lucide-react";
import { Button } from "@areal/ui";
import { SettingsGroupCard } from "@areal/ui/compositions";
import { useI18n, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import { MobileAdvancedNetwork, networkDiagnostics } from "./MobileAdvancedNetwork.js";
import { MobileAddDevice, type AddDeviceStep } from "./MobileAddDevice.js";
import { RelayServicePanel } from "./RelayServicePanel.js";
import { MobileDevices } from "./MobileDevices.js";
import "./MobileSettings.css";

import type { Action, CommandParams, Data } from "../services.js";

type Tone = "good" | "warning" | "idle";

/**
 * 手机连接页：一张状态卡回答“手机现在能不能连”，下面是设备列表；
 * 网络细节收进高级网络设置。默认通过中继配对，未开启中继时才使用本机入口。
 */
export function MobileSettings({ action, projects }: { action: Action; projects: Data[] }) {
  const { t } = useI18n();
  const [state, setState] = useState<Data>({ deviceGrants: [], pending: [] });
  const [error, setError] = useState<string | UiMessage>(""),
    [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<Data | null>(null);
  const [inviteExpired, setInviteExpired] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pairedName, setPairedName] = useState("");
  const doneTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const directUrl = useRef("");
  const run = async (request: CommandParams<"remoteControl">): Promise<Data | undefined> => {
    setBusy(true);
    setError("");
    try {
      const result = await action("remoteControl", request);
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
      setError(
        request.operation.startsWith("network") && typeof failure.code === "string"
          ? {
              id:
                networkDiagnostics[failure.code] ?? "settings.mobileSettings.networkStatusUnknown",
              values: { code: failure.code },
            }
          : currentErrorText(failure),
      );
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
          directUrl.current = value.directUrl ?? "";
        })
        .catch((error) => {
          if (live)
            setError({
              id: "settings.mobileSettings.theHostIsOfflineOrTheBackground",
              values: { value0: currentErrorText(error) },
            });
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
  }, [action]);

  const transport = state.enabled ? "relay" : "direct";
  const reconnectUrl =
    transport === "relay"
      ? state.relayUrl
      : state.directUrl && state.directHostId
        ? `${state.directUrl}/#host=${encodeURIComponent(state.directHostId)}`
        : "";
  const entryReady = transport === "relay" ? state.connected : state.directEnabled;
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
    ? state.connected
      ? {
          tone: "good",
          title: t("settings.mobileConnect.ready"),
          description: t(
            state.relay?.startsWith("http:")
              ? "settings.relayService.readyLocal"
              : "settings.mobileConnect.readyViaRelay",
            { host: relayHost },
          ),
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
      <SettingsGroupCard className="remote-status-card">
        <div className="remote-status" data-tone={status.tone}>
          <span className="remote-status-icon" aria-hidden>
            {status.tone === "idle" ? <Smartphone size={18} /> : <span className="remote-dot" />}
          </span>
          <div className="remote-status-text">
            <strong>{status.title}</strong>
            <small>{status.description}</small>
          </div>
          {(state.enabled || state.directEnabled) && (
            <Button disabled={busy || !entryReady} onClick={startAdding}>
              {t("settings.mobileConnect.addDevice")}
            </Button>
          )}
        </div>
        {state.enabled ? (
          <p className="remote-muted" role="status">
            {t(
              state.relay?.startsWith("http:")
                ? "settings.relayService.localSelected"
                : "settings.mobileConnect.enrolled",
              { host: relayHost },
            )}
          </p>
        ) : (
          <Button disabled={busy} onClick={() => void run({ operation: "relayServiceStartLocal" })}>
            {t("settings.relayService.startLocal")}
          </Button>
        )}
      </SettingsGroupCard>
      {!adding && (error || state.directError || state.migrationError) && (
        <p className="remote-error" role="alert">
          {formatUiMessage(t, error) || state.directError || state.migrationError}
        </p>
      )}
      <RelayServicePanel state={state} busy={busy} run={run} />
      <MobileDevices
        devices={state.deviceGrants ?? []}
        projects={projects}
        busy={busy}
        run={run}
        reconnectUrl={reconnectUrl ?? ""}
        error={formatUiMessage(t, error)}
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
