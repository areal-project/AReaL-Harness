import type { PluginCommand } from "./pluginTypes.js";
import { Textarea } from "@areal/ui";
import { useI18n, type UiMessage } from "../i18n/IntlProvider.js";
import { SettingsDisclosure } from "./SettingsDisclosure.js";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Feedback } from "./common.js";
import type { Data } from "../services.js";

export function PluginAuthConfiguration({
  projectId,
  pluginId,
  server,
  digest,
  disabled,
  command,
  onSaved,
  onActivityChange,
}: {
  projectId: string;
  pluginId: string;
  server: Data;
  digest: string;
  disabled: boolean;
  command: PluginCommand;
  onSaved: () => void;
  onActivityChange?: (id: string, pending: boolean) => void;
}) {
  const { t } = useI18n();
  const requirements = server.config?.authenticationRequirements ?? {};
  const [clientSecret, setClientSecret] = useState("");
  const [privateKeyPem, setPrivateKeyPem] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [privateKeyId, setPrivateKeyId] = useState("");
  const [clientMetadataUrl, setClientMetadataUrl] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<UiMessage | string>("");
  const [error, setError] = useState<UiMessage | string>("");
  const [pendingId, setPendingId] = useState<string>();
  useEffect(() => {
    const id = `${pluginId}:${server.serverId}:${digest}`;
    onActivityChange?.(id, busy || !!pendingId);
    return () => onActivityChange?.(id, false);
  }, [busy, pendingId, onActivityChange, pluginId, server.serverId, digest]);
  const blocked = disabled || busy || !!pendingId;
  const save = async () => {
    if (blocked) return;
    const requestId = crypto.randomUUID();
    const credentials = {
      ...(clientSecret ? { clientSecret } : {}),
      ...(privateKeyPem ? { privateKeyPem } : {}),
      ...(apiKey ? { apiKey } : {}),
    };
    // Clear transient values before IPC; saved secrets are never read back into renderer state.
    setClientSecret("");
    setPrivateKeyPem("");
    setApiKey("");
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await command({
        projectId,
        operation: "pluginAuthCredential",
        id: pluginId,
        server: server.serverId,
        expectedDigest: digest,
        requestId,
        credentials,
        configuration: {
          ...(privateKeyId.trim() ? { privateKeyId: privateKeyId.trim() } : {}),
          ...(clientMetadataUrl.trim() ? { clientMetadataUrl: clientMetadataUrl.trim() } : {}),
          ...(callbackUrl.trim() ? { callbackUrl: callbackUrl.trim() } : {}),
        },
      });
      setMessage({
        id: "settings.pluginAuthConfiguration.authenticationConfigurationSavedEnableAuthenticationAndCheck",
      });
      onSaved();
    } catch (cause) {
      const failure = cause as { message?: string; submissionUnknown?: boolean };
      setError(
        failure.message ?? {
          id: "settings.pluginAuthConfiguration.authenticationConfigurationIncomplete",
        },
      );
      if (failure.submissionUnknown) setPendingId(requestId);
    } finally {
      setBusy(false);
    }
  };
  const recover = async () => {
    if (!pendingId || busy) return;
    setBusy(true);
    setError("");
    try {
      const receipt = await command({
        projectId,
        operation: "pluginSubmission",
        mutation: "pluginAuthConfigure",
        requestId: pendingId,
      });
      if (!receipt.confirmed) {
        setMessage({
          id: "settings.pluginAuthConfiguration.theResultIsStillUnconfirmedCheckAgain",
        });
        return;
      }
      setPendingId(undefined);
      if (!receipt.accepted)
        setError(
          receipt.error?.message ?? {
            id: "settings.pluginAuthConfiguration.authenticationConfigurationWasNotAccepted",
          },
        );
      else {
        setMessage({
          id: "settings.pluginAuthConfiguration.authenticationConfigurationConfirmedSaved",
        });
        onSaved();
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsDisclosure
      title={<> {t("settings.pluginAuthConfiguration.authenticationConfiguration")}</>}
    >
      <p>{t("settings.pluginAuthConfiguration.disconnectThePluginFirstCredentialsAreSaved")}</p>
      {requirements.clientSecret && (
        <label>
          {t("settings.pluginAuthConfiguration.oauthClientSecret")}
          <Input
            type="password"
            autoComplete="new-password"
            value={clientSecret}
            disabled={blocked}
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </label>
      )}
      {requirements.privateKey && (
        <>
          <label>
            {t("settings.pluginAuthConfiguration.oauthSigningPrivateKeyPEM")}
            <Textarea
              unstyled
              data-slot={undefined}
              autoComplete="off"
              value={privateKeyPem}
              disabled={blocked}
              onChange={(event) => setPrivateKeyPem(event.target.value)}
            />
          </label>
          <label>
            {t("settings.pluginAuthConfiguration.signingKeyID")}
            <Input
              value={privateKeyId}
              disabled={blocked}
              onChange={(event) => setPrivateKeyId(event.target.value)}
            />
          </label>
        </>
      )}
      {requirements.apiKey && (
        <label>
          {requirements.headerScheme === "basic"
            ? t("settings.pluginAuthConfiguration.apiCredentialsUsernamePassword")
            : t("settings.pluginAuthConfiguration.apiCredentials")}
          <Input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={blocked}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
      )}
      {!requirements.apiKey && (
        <>
          <label>
            {t("settings.pluginAuthConfiguration.cimdClientMetadataURLOptional")}
            <Input
              type="url"
              value={clientMetadataUrl}
              disabled={blocked}
              onChange={(event) => setClientMetadataUrl(event.target.value)}
              placeholder="https://example.com/oauth/client.json"
            />
          </label>
          <label>
            {t("settings.pluginAuthConfiguration.registeredLoopbackCallbackURLOptional")}
            <Input
              type="url"
              value={callbackUrl}
              disabled={blocked}
              onChange={(event) => setCallbackUrl(event.target.value)}
              placeholder="http://127.0.0.1:PORT/callback"
            />
          </label>
        </>
      )}
      <Feedback error={error} message={message} />
      <Button
        variant="outline"
        disabled={
          blocked ||
          (requirements.clientSecret && !clientSecret) ||
          (requirements.privateKey && !privateKeyPem) ||
          (requirements.apiKey && !apiKey)
        }
        onClick={() => void save()}
      >
        {t("settings.pluginAuthConfiguration.saveAuthenticationConfiguration")}
      </Button>
      {pendingId && (
        <Button variant="outline" disabled={busy} onClick={() => void recover()}>
          {t("settings.pluginAuthConfiguration.checkAuthenticationSubmission")}
        </Button>
      )}
    </SettingsDisclosure>
  );
}
