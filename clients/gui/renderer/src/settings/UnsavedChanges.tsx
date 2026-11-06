import { useI18n, UiMessageError, formatUiMessage, type UiMessage } from "../i18n/IntlProvider.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "../components/ui/button.js";
import { Feedback, SettingsDialog } from "./common.js";

type DraftBlocker = {
  label: string | UiMessage;
  dirty: boolean;
  busy: boolean;
  save: () => Promise<void>;
  discard: () => void;
};
type Navigation = () => void;
type PendingNavigation = { navigate: Navigation; resolve: (allowed: boolean) => void };
type Guard = {
  busy: boolean;
  register: (blocker: DraftBlocker) => () => void;
  request: (navigation: Navigation) => Promise<boolean>;
};
const Context = createContext<Guard | null>(null);

/** Guards in-app navigation; draft values and credentials stay with the editor. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const blocker = useRef<DraftBlocker | null>(null);
  const pending = useRef<PendingNavigation | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | UiMessage>("");
  const register = useCallback((next: DraftBlocker) => {
    blocker.current = next;
    setBusy(next.busy);
    return () => {
      if (blocker.current === next) {
        blocker.current = null;
        setBusy(false);
      }
    };
  }, []);
  useEffect(
    () => () => {
      pending.current?.resolve(false);
      pending.current = null;
    },
    [],
  );
  const request = useCallback(async (navigation: Navigation) => {
    if (blocker.current?.busy || savingRef.current || pending.current) return false;
    if (!blocker.current?.dirty) {
      navigation();
      return true;
    }
    setError("");
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = { navigate: navigation, resolve };
    });
  }, []);
  const cancel = () => {
    if (!savingRef.current) {
      pending.current?.resolve(false);
      pending.current = null;
      setOpen(false);
      setError("");
    }
  };
  const proceed = async (save: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      if (save) await blocker.current?.save();
      else blocker.current?.discard();
      const navigation = pending.current;
      pending.current = null;
      setOpen(false);
      if (navigation) {
        navigation.navigate();
        navigation.resolve(true);
      }
    } catch (cause) {
      setError(
        cause instanceof UiMessageError
          ? cause.descriptor
          : cause instanceof Error
            ? cause.message
            : { id: "settings.unsavedChanges.saveFailedTryAgain" },
      );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  return (
    <Context.Provider value={{ register, request, busy: busy || saving }}>
      {children}
      {open && (
        <SettingsDialog
          className="sm:max-w-md"
          title={t("settings.unsavedChanges.valueHasUnsavedChanges", {
            value0:
              formatUiMessage(t, blocker.current?.label) || t("settings.unsavedChanges.settings"),
          })}
          description={t("settings.unsavedChanges.saveTheseChangesBeforeLeaving")}
          onClose={cancel}
          busy={saving}
        >
          <Feedback error={error} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={saving} onClick={cancel}>
              {t("settings.unsavedChanges.keepEditing")}
            </Button>
            <Button variant="outline" disabled={saving} onClick={() => void proceed(false)}>
              {t("settings.unsavedChanges.discardAndContinue")}
            </Button>
            <Button disabled={saving} onClick={() => void proceed(true)}>
              {saving
                ? t("settings.unsavedChanges.saving")
                : t("settings.unsavedChanges.saveAndContinue")}
            </Button>
          </div>
        </SettingsDialog>
      )}
    </Context.Provider>
  );
}
export function useGuardedNavigation() {
  const guard = useContext(Context);
  if (!guard) throw new Error("Settings navigation requires UnsavedChangesProvider");
  return guard.request;
}
// 导航按钮与实际准入使用同一 busy 状态，避免显示可点击却丢弃请求。
export function useNavigationBusy() {
  const guard = useContext(Context);
  if (!guard) throw new Error("Settings navigation requires UnsavedChangesProvider");
  return guard.busy;
}
export function useDraftBlocker(blocker: DraftBlocker) {
  const guard = useContext(Context);
  if (!guard) throw new Error("Draft editor requires UnsavedChangesProvider");
  useLayoutEffect(() => guard.register(blocker), [guard.register, blocker]);
  useEffect(() => {
    if (!blocker.dirty && !blocker.busy) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [blocker.dirty, blocker.busy]);
}

export function useGuardedQuit(
  services: Pick<import("../services.js").PlatformServices, "onQuitRequested">,
) {
  const requestNavigation = useGuardedNavigation();
  useEffect(
    () => services.onQuitRequested?.(() => requestNavigation(() => {})),
    [services, requestNavigation],
  );
  return requestNavigation;
}
