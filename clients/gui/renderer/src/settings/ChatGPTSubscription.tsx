import { SettingsGroupCard, SettingsRow, SettingsSection } from "@areal/ui/compositions";
import { useI18n, type MessageId, type Translate, type UiMessage } from "../i18n/IntlProvider.js";
import { SettingsSelect } from "./SettingsPageParts.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button.js";

import { Feedback, useResource } from "./common.js";

import { subscriptionProjection } from "./provider-ui-state.js";
import type { Action, CommandParams, Data } from "../services.js";

const recovery: Record<string, MessageId | ""> = {
  ready: "",
  refreshing: "settings.chatGPTSubscription.refreshing",
  temporarily_unavailable: "settings.chatGPTSubscription.retryLater",
  storage_locked: "settings.chatGPTSubscription.unlockSecureStorage",
  reauth_required: "settings.chatGPTSubscription.authorizationExpired",
  permission_denied: "settings.chatGPTSubscription.checkPermissions",
  quota_exceeded: "settings.chatGPTSubscription.checkUsage",
  signed_out: "settings.chatGPTSubscription.browserAuthorization",
};

const subscriptionStatusMessages: Record<string, MessageId> = {
  ready: "settings.chatGPTSubscription.available",
  refreshing: "settings.chatGPTSubscription.refreshingCredentials",
  temporarily_unavailable: "settings.chatGPTSubscription.temporarilyUnavailable",
  reauth_required: "settings.chatGPTSubscription.reauthorizationRequired",
  permission_denied: "settings.chatGPTSubscription.permissionOrServiceRestriction",
  quota_exceeded: "settings.chatGPTSubscription.appUsageLimited",
  storage_locked: "settings.chatGPTSubscription.secureStorageNeedsUnlocking",
  signed_out: "settings.chatGPTSubscription.signedOut",
};
export function subscriptionStatusLabel(t: Translate, state: string) {
  return t(subscriptionStatusMessages[state] ?? "settings.chatGPTSubscription.statusNeedsChecking");
}

export function ChatGPTSubscription({
  action,
  status,
  connectionState = "ready",
  onStatusChange,
}: {
  action: Action;
  status?: Data;
  connectionState?: string;
  onStatusChange?: (status: Data) => void;
}) {
  const { t } = useI18n();
  const api = <P extends CommandParams<"chatgpt">>(request: P) =>
    action("chatgpt", { ...request, provider: "openai" });
  const resource = useResource(
    () => api({ operation: "status" }),
    `chatgpt-subscription-openai:${connectionState}`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState<UiMessage>();
  const value = status ?? resource.value;
  const projection = subscriptionProjection(value);
  const models: Data[] = value?.models ?? [];
  const chosenModel = models[0]?.id ?? "";
  const accounts: Data[] = value?.accounts ?? [];
  useEffect(() => {
    if (resource.value) onStatusChange?.(resource.value);
  }, [resource.value, onStatusChange]);

  useEffect(() => {
    if (!value?.login) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await resource.refresh();
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [value?.login?.loginId, resource.refresh]);

  const run = async (request: CommandParams<"chatgpt">) => {
    setBusy(true);
    setError("");
    setMessage(undefined);
    try {
      await api(request);
      if (request.operation === "probe")
        setMessage({
          id: "settings.chatGPTSubscription.connectedReceivedTheModelSCompleteResponse",
        });
      await resource.refresh();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disabled = busy || resource.loading;
  return (
    <div data-subscription-kind="openai" className="subscription-settings">
      <SettingsSection
        className="gap-field"
        title={t("settings.chatGPTSubscription.chatgptSubscription")}

        action={
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("settings.chatGPTSubscription.refreshChatGPTSignInStatus")}
            disabled={disabled}
            onClick={() => void resource.refresh()}
          >
            <RefreshCw
              size={14}
              className={resource.loading || value?.refreshing ? "animate-spin" : ""}
            />
          </Button>
        }
      >
        <Feedback
          error={error || resource.error || value?.error || value?.modelError}
          message={message}
        />
        <SettingsGroupCard>
          <SettingsRow
            label={value?.email || t("settings.chatGPTSubscription.chatgptAccount")}
            description={
              value?.login
                ? t("settings.chatGPTSubscription.waitingForBrowserAuthorization")
                : recovery[projection.state]
                  ? t(recovery[projection.state] as MessageId)
                  : projection.state === "ready"
                    ? ""
                    : t("settings.chatGPTSubscription.refreshToCheckConnectionStatus")
            }
            control={
              <>
                {value?.login ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void run({ operation: "cancel" })}
                  >
                    {t("settings.chatGPTSubscription.cancelSignIn")}
                  </Button>
                ) : projection.canSignIn ? (
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() => void run({ operation: "login" })}
                  >
                    {projection.state === "reauth_required"
                      ? t("settings.chatGPTSubscription.signInAgain")
                      : t("settings.chatGPTSubscription.signInWithChatGPT")}
                  </Button>
                ) : value?.authenticated ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => void run({ operation: "logout" })}
                  >
                    {t("settings.chatGPTSubscription.signOut")}
                  </Button>
                ) : null}
              </>
            }
          />
        </SettingsGroupCard>
        <p
          role="status"
          aria-label={t("settings.chatGPTSubscription.chatgptConnectionStatus")}
          className="settings-muted"
        >
          {t("settings.chatGPTSubscription.subscriptionStatus", {
            status:
              resource.loading && !value
                ? t("settings.chatGPTSubscription.loadingStatus")
                : subscriptionStatusLabel(t, projection.state),
          })}
        </p>
        {projection.retryable && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setError("");
              void resource.refresh();
            }}
          >
            {t("settings.chatGPTSubscription.retryStatusCheck")}
          </Button>
        )}
        {accounts.length > 1 && (
          <div>
            <label className="mb-1 block text-ui-base text-foreground-subtle">
              {t("settings.chatGPTSubscription.savedAccounts")}
            </label>
            <SettingsSelect
              aria-label={t("settings.chatGPTSubscription.savedChatGPTAccounts")}
              value={value?.activeAccountId ?? ""}
              disabled={disabled || !!value?.login || projection.state === "storage_locked"}
              onValueChange={(id) => {
                if (!id || id === value?.activeAccountId) return;
                const account = accounts.find((account) => account.id === id);
                void run({
                  operation: account?.state === "saved" ? "selectAccount" : "login",
                  accountId: id,
                });
              }}
            >
              {accounts.map((account) => (
                <option
                  key={account.id}
                  value={account.id}
                >{`${account.label}${account.email ? ` · ${account.email}` : ""}${account.active ? " · " + t("settings.chatGPTSubscription.activeAccount") : ""}`}</option>
              ))}
            </SettingsSelect>
          </div>
        )}
        {!value?.login && projection.state !== "storage_locked" && (
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => void run({ operation: "login", newAccount: true })}
          >
            {t("settings.chatGPTSubscription.addChatGPTAccount")}
          </Button>
        )}
        {value?.diagnostic && (
          <SettingsDisclosure title={<> {t("settings.chatGPTSubscription.diagnostics")}</>}>
            <p className="settings-muted break-all">
              {value.diagnostic.code} · {value.diagnostic.phase}
              {value.diagnostic.httpStatus
                ? t("settings.subscription.httpStatus", { status: value.diagnostic.httpStatus })
                : ""}
              {value.diagnostic.requestId
                ? t("settings.subscription.requestId", { id: value.diagnostic.requestId })
                : ""}
            </p>
          </SettingsDisclosure>
        )}
        {value?.authenticated && (
          <div className="subscription-models-footer flex flex-wrap items-center justify-between gap-3 pt-1">
            <span className="settings-muted">
              {t("settings.chatGPTSubscription.usesAccountAllowance")}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !projection.canTest || !!value.login || !!resource.error}
              onClick={() => void run({ operation: "probe", model: chosenModel })}
            >
              {busy
                ? t("settings.chatGPTSubscription.checking")
                : t("settings.chatGPTSubscription.testConnection")}
            </Button>
          </div>
        )}
      </SettingsSection>
    </div>
  );
}
