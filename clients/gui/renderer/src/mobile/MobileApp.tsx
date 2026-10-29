import { createRoot } from "react-dom/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Input } from "@areal/ui";
import { Monitor, Settings } from "lucide-react";
import { FeedbackNotice } from "@areal/ui/experimental";
import { SettingsGroupCard, SettingsRow } from "@areal/ui/compositions";
import { ApplicationIntlProvider, useI18n, type MessageId } from "../i18n/IntlProvider.js";
import { MobileClient } from "./mobile-client.mjs";
import { keychain, observeLifecycle, scanPairingLink } from "./platform.js";
import { MobileCommands } from "./mobile-commands.mjs";
import { MobileWorkspace } from "./mobile-workspace.mjs";
import { MobileWorkspaceView } from "./MobileWorkspace.js";
import "../styles.css";
import "../workbench.css";
import "./mobile.layout.css";

const client = new MobileClient({ keychain });
const workspace = new MobileWorkspace(client);
const commands = new MobileCommands(client, workspace);

function MobileApp() {
  const { t } = useI18n();
  const state = useSyncExternalStore(client.subscribe, client.snapshot);
  const view = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const [name, setName] = useState(t("mobile.deviceFallback"));
  const [link, setLink] = useState("");
  const [paste, setPaste] = useState(false);
  const [settings, setSettings] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [error, setError] = useState<MessageId | null>(null);
  useEffect(() => {
    void keychain
      .deviceName()
      .then(({ name }) => setName(name))
      .catch(() => {});
    let disposed = false;
    const lifecycle = observeLifecycle((active) => {
      if (!disposed) void client.setActive(active);
    });
    const close = () => {
      void client.setActive(false);
    };
    window.addEventListener("pagehide", close);
    const theme = matchMedia("(prefers-color-scheme: dark)");
    const update = () => document.documentElement.classList.toggle("dark", theme.matches);
    update();
    theme.addEventListener("change", update);
    return () => {
      disposed = true;
      window.removeEventListener("pagehide", close);
      void lifecycle.then((remove) => remove());
      theme.removeEventListener("change", update);
      commands.dispose();
      workspace.dispose();
      void client.setActive(false);
    };
  }, []);
  const pair = (value: string) => {
    setError(null);
    setLink("");
    setPaste(false);
    void client.pair(value, name.trim() || t("mobile.deviceFallback"));
  };
  const scan = async () => {
    setError(null);
    try {
      const value = await scanPairingLink();
      if (value) pair(value);
    } catch {
      setError("mobile.scanFailed");
    }
  };
  const clear = async () => {
    try {
      await client.clear();
      setSettings(false);
      setClearConfirm(false);
      setError(null);
    } catch {
      setError("mobile.clearFailed");
    }
  };
  const statusKey: MessageId =
    state.kind === "connected"
      ? state.ready.capabilities.includes("submit")
        ? "mobile.connected"
        : "mobile.observer"
      : state.kind === "loading" || state.kind === "connecting"
        ? "mobile.connecting"
        : state.kind === "offline"
          ? "mobile.offline"
          : state.kind === "revoked"
            ? "mobile.revoked"
            : state.kind === "background"
              ? "mobile.background"
              : "mobile.blocked";
  return (
    <main
      className="mobile-page data-[state=connected]:h-dvh data-[state=connected]:min-h-0 data-[state=connected]:overflow-hidden data-[state=connected]:[&>.mobile-stack]:flex-1 data-[state=connected]:[&>.mobile-stack]:min-h-0 [&_h1]:[line-height:1.3] [&_h1]:font-semibold [&_h2]:[line-height:1.3] [&_h2]:font-semibold [&_h3]:[line-height:1.3] [&_h3]:font-semibold [&_[data-action=new-session]]:text-fixed-control [&_[data-action=new-session]]:font-semibold [&_[data-action=new-session]]:bg-primary [&_[data-action=new-session]]:text-primary-foreground flex flex-col gap-section [padding:calc(env(safe-area-inset-top)+var(--spacing-panel))_var(--spacing-panel)_calc(env(safe-area-inset-bottom)+var(--spacing-panel))] min-h-dvh box-border bg-background text-foreground font-sans text-fixed-body"
      data-state={state.kind}
      data-workspace-page={state.kind === "connected" && !settings ? view.page.kind : undefined}
      data-remembered={state.kind === "connected" ? state.remembered : undefined}
    >
      {(state.kind !== "connected" || settings || view.page.kind === "projects") && (
        <header className="mobile-header shrink-0 min-h-[var(--size-touch-target)] flex items-center justify-between gap-inline">
          {state.kind === "connected" && !settings && (
            <Monitor
              className="mobile-host-icon size-[var(--spacing-section)]"
              aria-hidden="true"
            />
          )}
          <div
            className={
              state.kind === "connected" && !settings
                ? "mobile-host-copy flex-1 min-w-0 [&_h1]:block [&_h1]:min-w-0 [&_h1]:max-w-full [&_h1]:truncate [&_h1]:text-fixed-body"
                : "mobile-host-copy flex-1 min-w-0 [&_h1]:block [&_h1]:min-w-0 [&_h1]:max-w-full [&_h1]:truncate"
            }
          >
            <h1
              className={
                state.kind === "connected" && !settings
                  ? "text-fixed-emphasis"
                  : "text-fixed-page-title"
              }
            >
              {t(
                settings
                  ? "mobile.settings"
                  : state.kind === "unpaired"
                    ? "mobile.connect"
                    : state.kind === "pairing"
                      ? "mobile.waiting"
                      : state.kind === "connected"
                        ? "mobile.computer"
                        : "mobile.projects",
              )}
            </h1>
            {state.kind === "connected" && !settings && (
              <p className="mobile-host-status m-0 flex items-center gap-[calc(var(--spacing-inline)/2)] text-foreground-subtle text-fixed-caption">
                <span className="bg-success mobile-status-dot inline-block size-[var(--size-status-dot)] [border-radius:var(--radius-pill)]" />
                {t(statusKey)}
              </p>
            )}
          </div>
          {state.kind !== "unpaired" && state.kind !== "pairing" && (
            <Button
              className="mobile-touch size-[var(--size-touch-target)] min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] p-inline"
              variant="ghost"
              data-action="settings"
              aria-label={t(settings ? "mobile.back" : "mobile.settings")}
              onClick={() => setSettings(!settings)}
            >
              {settings ? t("mobile.back") : <Settings aria-hidden="true" />}
            </Button>
          )}
        </header>
      )}
      {error && <FeedbackNotice tone="error" message={t(error)} />}
      {state.kind === "unpaired" && !settings ? (
        <section className="mobile-stack flex flex-col gap-field">
          {state.cleared && <FeedbackNotice tone="info" message={t("mobile.cleared")} />}
          {state.error && (
            <FeedbackNotice tone="error" message={t(`mobile.${state.error}` as MessageId)} />
          )}
          <p>{t("mobile.instructions")}</p>
          <label className="mobile-field flex flex-col gap-inline">
            {t("mobile.deviceName")}
            <Input
              className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] text-mobile-input-safe md:text-mobile-input-safe"
              aria-label={t("mobile.deviceName")}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Button
            className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
            onClick={() => void scan()}
          >
            {t("mobile.scan")}
          </Button>
          <Button
            className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
            variant="outline"
            data-action="paste"
            onClick={() => setPaste(!paste)}
          >
            {t("mobile.paste")}
          </Button>
          {paste && (
            <form
              className="mobile-stack flex flex-col gap-field"
              onSubmit={(event) => {
                event.preventDefault();
                pair(link);
              }}
            >
              <label className="mobile-field flex flex-col gap-inline">
                {t("mobile.link")}
                <Input
                  className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)] text-mobile-input-safe md:text-mobile-input-safe"
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  data-field="pairing-link"
                  aria-label={t("mobile.link")}
                  value={link}
                  onChange={(event) => setLink(event.target.value)}
                />
              </label>
              <Button
                className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                data-action="pair"
                type="submit"
                disabled={!link.trim()}
              >
                {t("mobile.continue")}
              </Button>
            </form>
          )}
          <p className="text-foreground-subtle">{t("mobile.access")}</p>
        </section>
      ) : state.kind === "pairing" ? (
        <section className="mobile-stack flex flex-col gap-field">
          <p role="status">{t("mobile.fingerprint")}</p>
          <code
            className="mobile-fingerprint [overflow-wrap:anywhere] p-field font-mono bg-hover rounded-[var(--radius-card)]"
            data-field="fingerprint"
          >
            {state.fingerprint}
          </code>
          <p>{t("mobile.access")}</p>
          <Button
            className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
            variant="outline"
            onClick={() => {
              client.disconnect();
              void client.restore();
            }}
          >
            {t("mobile.cancel")}
          </Button>
        </section>
      ) : settings ? (
        <section className="mobile-stack flex flex-col gap-field">
          <SettingsGroupCard>
            <SettingsRow label={t("mobile.deviceName")} control={name} />
            <SettingsRow label={t("mobile.notificationUnavailable")} control={null} />
          </SettingsGroupCard>
          <Button
            className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
            variant="outline"
            data-action="clear"
            onClick={() => setClearConfirm(true)}
          >
            {t("mobile.clear")}
          </Button>
          {clearConfirm && (
            <FeedbackNotice
              tone="warning"
              message={t("mobile.clearConfirm")}
              actions={
                <>
                  <Button
                    className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                    variant="destructive"
                    data-action="confirm-clear"
                    onClick={() => void clear()}
                  >
                    {t("mobile.clear")}
                  </Button>
                  <Button
                    className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
                    variant="ghost"
                    onClick={() => setClearConfirm(false)}
                  >
                    {t("mobile.cancel")}
                  </Button>
                </>
              }
            />
          )}
        </section>
      ) : (
        <section className="mobile-stack flex flex-col gap-field">
          {state.kind !== "connected" && (
            <p role="status" className="mobile-status inline-flex gap-inline items-center">
              {t(statusKey)}
            </p>
          )}
          {state.kind === "connected" && !state.remembered && (
            <FeedbackNotice tone="warning" message={t("mobile.storageFailed")} />
          )}
          {state.kind === "connected" && (
            <MobileWorkspaceView workspace={workspace} client={client} commands={commands} />
          )}
          {["offline", "blocked"].includes(state.kind) && (
            <Button
              className="mobile-touch min-h-[var(--size-touch-target)] min-w-[var(--size-touch-target)]"
              onClick={() => void client.setActive(true)}
            >
              {t("mobile.retry")}
            </Button>
          )}
        </section>
      )}
    </main>
  );
}

export function mountMobileApp() {
  createRoot(document.getElementById("root")!).render(
    <ApplicationIntlProvider>
      <MobileApp />
    </ApplicationIntlProvider>,
  );
}
