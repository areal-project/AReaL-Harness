import { rawText } from "./errors/errorCopy.js";
import { currentErrorText } from "./errors/currentErrorText.js";
export type PreviewFailure = {
  kind: "permission" | "unknown" | "operation";
  message: string;
};

export function previewFailure(error: unknown): PreviewFailure {
  const raw = rawText(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return {
    kind:
      code === "BROWSER_PERMISSION_DENIED"
        ? "permission"
        : raw === "outcome_unknown"
          ? "unknown"
          : "operation",
    message: currentErrorText(error),
  };
}

export function browserLabel({ id }: { id: string }): string {
  return (
    (
      {
        "browser.back": "后退",
        "browser.forward": "前进",
        "browser.reload": "刷新预览",
        "browser.stop": "停止加载",
        "browser.addressPlaceholder": "输入网址，按 Enter 打开",
        "browser.responsive.enter": "响应式预览",
        "browser.responsive.exit": "退出响应式预览",
        "browser.more": "浏览器更多操作",
        "browser.openExternal": "在默认浏览器打开",
        "browser.devtools": "开发者工具",
        "browser.details": "浏览器详情",
        "browser.title": "浏览器",
        "browser.empty": "粘贴或输入网址，按 Enter 打开页面。",
        "browser.loadError.title": "无法打开网页",
        "browser.loadError.retry": "重新加载网页",
      } as Record<string, string>
    )[id] ?? id
  );
}

export const devicePresets = [
  { id: "phone", labelMessage: "browser.viewport.phone", width: 390, height: 844 },
  { id: "tablet", labelMessage: "browser.viewport.tablet", width: 768, height: 1024 },
  { id: "desktop", labelMessage: "browser.viewport.desktop", width: 1440, height: 900 },
] as const;

export function deviceDimension(value: string | undefined, fallback: number) {
  return Math.min(2560, Math.max(240, Math.round(Number(value) || fallback)));
}
