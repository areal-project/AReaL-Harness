import { useEffect, useState } from "react";
import { LogIn, LogOut, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button.js";
import { Feedback, useResource } from "./common.js";
import {
  SettingsGroupCard,
  SettingsRow,
  SettingsSection,
} from "./SettingsPageParts.js";
import type { Action, Data } from "../services.js";

export function ChatGPTSubscription({ action, onModelsChange, onAccountChange }: { action: Action; onModelsChange?: (models: Data[]) => void; onAccountChange?: (label: string) => void }) {
  const api = (operation: string, values: Data = {}) =>
    action("chatgpt", { operation, provider: "openai", ...values });
  const state = useResource(() => api("status"), "chatgpt-subscription-openai");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const value = state.value;
  const models: Data[] = value?.models ?? [];
  useEffect(() => {
    onModelsChange?.(value?.authenticated ? value.models ?? [] : []);
    onAccountChange?.(value?.authenticated ? value.email || "已登录" : value?.login ? "等待授权" : "未登录");
  }, [value, onModelsChange, onAccountChange]);
  const chosenModel = models[0]?.id ?? "";

  useEffect(() => {
    if (!value?.login) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await state.refresh();
      if (!disposed) timer = setTimeout(poll, 1500);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [value?.login?.loginId, state.refresh]);

  const run = async (operation: string) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await api(operation, { model: chosenModel });
      if (operation === "probe")
        setMessage("连接成功，已收到模型的完整回复。");
      await state.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-subscription-kind="openai">
    <SettingsSection
      className="subscription-settings"
      title="ChatGPT API"
      description="通过 ChatGPT 授权使用 OpenAI API，无需自备 API Key。"
      action={
        <Button
          variant="ghost"
          size="icon"
          aria-label="刷新 ChatGPT 登录状态"
          disabled={busy || state.loading}
          onClick={() => void state.refresh()}
        >
          <RefreshCw size={14} className={state.loading ? "animate-spin" : ""} />
        </Button>
      }
    >
      <Feedback error={error || state.error || value?.error || value?.modelError} message={message} />
      <SettingsGroupCard>
        <SettingsRow
          label="ChatGPT API"
          description={
            value?.authenticated
              ? `已登录 · ${value.email || "ChatGPT 账号"}${value.planType ? ` · ${value.planType}` : ""}`
              : value?.login
                ? "等待浏览器授权，完成后此页面会自动更新。"
                : "尚未登录。请在浏览器中授权应用使用 ChatGPT API。"
          }
          control={
            <>
              {value?.authenticated ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run("logout")}
                >
                  <LogOut size={14} />
                  退出登录
                </Button>
              ) : value?.login ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run("cancel")}
                >
                  取消登录
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={busy || state.loading}
                  onClick={() => void run("login")}
                >
                  <LogIn size={14} />
                  使用 ChatGPT 登录
                </Button>
              )}
            </>
          }
        />
      </SettingsGroupCard>

      {!value?.authenticated && !value?.login && (
        <Button variant="ghost" size="sm" disabled={busy || state.loading} onClick={() => void run("forget")}>更换账号</Button>
      )}

      {value?.authenticated && (
        <div className="subscription-models-footer flex items-center justify-between pt-1">
          <span className="settings-muted">模型来自当前账号目录。可用性和额度以服务端为准。</span>
          <Button variant="outline" size="sm" disabled={busy || !chosenModel} onClick={() => void run("probe")}>
            {busy ? "正在检查…" : "测试连接"}
          </Button>
        </div>
      )}
    </SettingsSection>
    </div>
  );
}
