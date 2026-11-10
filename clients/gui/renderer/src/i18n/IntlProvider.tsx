import { useCallback, useLayoutEffect, type ReactNode } from "react";
import { IntlProvider, useIntl } from "react-intl";
import { useApplicationPreferences } from "../settings/applicationPreferences.js";
import { catalogs } from "./messages.js";

export type { AppLocale, MessageId } from "./messages.js";
export type { MessageValues, Translate, UiMessage } from "./uiMessage.js";
import type { Translate, UiMessage } from "./uiMessage.js";

export function ApplicationIntlProvider({ children }: { children: ReactNode }) {
  const { locale } = useApplicationPreferences();
  useLayoutEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <IntlProvider locale={locale} defaultLocale="zh-CN" messages={catalogs[locale]}>
      {children}
    </IntlProvider>
  );
}

export function useI18n() {
  const intl = useIntl();
  const { locale } = useApplicationPreferences();
  const t: Translate = useCallback((id, values) => intl.formatMessage({ id }, values), [intl]);
  return { intl, locale, t };
}

export const useZCodeIntl = useI18n;

export { UiMessageError } from "./uiMessage.js";

export function formatUiMessage(
  t: Translate,
  value: string | UiMessage | null | undefined,
): string {
  return typeof value === "string" ? value : value ? t(value.id, value.values) : "";
}
