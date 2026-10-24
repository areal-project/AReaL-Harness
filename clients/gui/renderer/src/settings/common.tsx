import { SettingsDialog as DialogView, SettingsToolbar as Toolbar } from "@areal/ui/wip";
import { useI18n } from "../i18n/IntlProvider.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Action, Data } from "../services.js";
export type SettingsProps = { project: Data; thread?: Data; action: Action };
export function useResource(load: () => Promise<Data>, identity: string) {
  const loader = useRef(load);
  loader.current = load;
  const epoch = useRef(0);
  const [state, setState] = useState<{
    value?: Data;
    loading: boolean;
    error?: string;
  }>({ loading: true });
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const value = await loader.current();
      if (request === epoch.current) setState({ value, loading: false });
      return value;
    } catch (error) {
      if (request === epoch.current)
        setState((s) => ({
          ...s,
          loading: false,
          error: (error as Error).message,
        }));
      return undefined;
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      epoch.current++;
    };
  }, [identity, refresh]);
  const accept = useCallback((value: Data) => {
    // 已确认的写操作回执优先于更早的读请求，避免保存后重新展示旧目录。
    epoch.current++;
    setState({ value, loading: false });
  }, []);
  return { ...state, refresh, accept };
}
export { Feedback } from "../components/ui/feedback.js";
export { EmptySettings } from "@areal/ui/wip";
export function SettingsToolbar(props: import("react").ComponentProps<typeof Toolbar>) { const { t } = useI18n(); return <Toolbar refreshLabel={t("settings.common.refresh")} newLabel={t("settings.common.new")} {...props} />; }
export function SettingsDialog(props: import("react").ComponentProps<typeof DialogView>) { const { t } = useI18n(); return <DialogView closeLabel={t("common.closeDialog")} {...props} />; }
