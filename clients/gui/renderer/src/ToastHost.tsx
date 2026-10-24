import { isValidElement, useEffect, useRef, useState } from "react";
import { NotificationToast } from "@areal/ui/wip";
import { useI18n } from "./i18n/IntlProvider.js";
import type { ToastMessage } from "./components/ui/toast.js";
import "@areal/ui/notifications.css";

type ActiveToast = ToastMessage & { id: number };

export function ToastHost() {
  const { t } = useI18n();
  const [active, setActive] = useState<ActiveToast | null>(null);
  const sequence = useRef(0);
  const shown = useRef(new Set<string>());
  useEffect(() => {
    const show = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      const value = typeof detail === "string" ? { message: detail, tone: "info" as const } : detail;
      if (!value || typeof value !== "object" || !("message" in value) || typeof value.message !== "string" || !value.message.trim()) return;
      const tone = "tone" in value && (value.tone === "warning" || value.tone === "error" || value.tone === "success") ? value.tone : "info";
      const key = "key" in value && typeof value.key === "string" ? value.key : undefined;
      const actions = "actions" in value && isValidElement(value.actions) ? value.actions : undefined;
      const onDismiss = "onDismiss" in value && typeof value.onDismiss === "function" ? value.onDismiss as () => void : undefined;
      const requestId = "requestId" in value && typeof value.requestId === "string" ? value.requestId : undefined;
      const next: ToastMessage = { message: value.message, tone, key, requestId, actions, onDismiss };
      const alreadyShown = key && shown.current.has(key);
      if (key) shown.current.add(key);
      setActive(previous => alreadyShown ? previous?.key === key ? { ...previous, ...next } : previous : { id: ++sequence.current, ...next });
    };
    const dismiss = (event: Event) => {
      const key: unknown = (event as CustomEvent).detail;
      if (typeof key !== "string") return;
      shown.current.delete(key);
      setActive(previous => previous?.key === key ? null : previous);
    };
    document.addEventListener("areal:toast-dismiss", dismiss);
    document.addEventListener("areal:toast", show);
    return () => { document.removeEventListener("areal:toast", show); document.removeEventListener("areal:toast-dismiss", dismiss); };
  }, []);
  return <div data-testid={active ? "toast" : undefined} data-tone={active?.tone} className="areal-toast-viewport">
    {active && <NotificationToast key={active.id} message={active.message} tone={active.tone} actions={active.actions} requestId={active.requestId} dismissLabel={t("recovery.dismiss")} onDismiss={() => { const notice = active; setActive(null); notice.onDismiss?.(); }} />}
  </div>;
}
