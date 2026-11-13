import { createIntl } from "react-intl";
import { catalogs } from "../i18n/messages.js";
import { errorText } from "./errorCopy.js";

const intls = new Map<string, ReturnType<typeof createIntl>>();

/** 组件外（服务、回调、没有 useI18n 的地方）按当前界面语言取错误文案。 */
export function currentErrorText(cause: unknown) {
  // ApplicationIntlProvider 把当前语言写在 <html lang>；不在浏览器里时用默认语言。
  const locale =
    typeof document !== "undefined" && document.documentElement.lang === "en" ? "en" : "zh-CN";
  let intl = intls.get(locale);
  if (!intl) {
    intl = createIntl({ locale, defaultLocale: "zh-CN", messages: catalogs[locale] });
    intls.set(locale, intl);
  }
  const current = intl;
  return errorText((id, values) => current.formatMessage({ id }, values), cause);
}
