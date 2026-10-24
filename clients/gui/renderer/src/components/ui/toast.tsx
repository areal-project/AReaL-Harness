import type { ReactNode } from "react";
export type ToastTone = "info" | "success" | "warning" | "error";
export type ToastMessage = { message: string; tone: ToastTone; key?: string; requestId?: string; actions?: ReactNode; onDismiss?: () => void };
export function toast(message: string, tone: ToastTone = "info", options: Omit<ToastMessage, "message" | "tone"> = {}) {
  document.dispatchEvent(new CustomEvent<ToastMessage>("areal:toast", { detail: { message, tone, ...options } }));
}
export function dismissToast(key: string) { document.dispatchEvent(new CustomEvent("areal:toast-dismiss", { detail: key })); }
