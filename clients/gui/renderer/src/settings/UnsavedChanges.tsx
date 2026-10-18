import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import { Feedback, SettingsDialog } from "./common.js";

type DraftBlocker = { label: string; dirty: boolean; busy: boolean; save: () => Promise<void>; discard: () => void };
type Navigation = () => void;
type Guard = { busy: boolean; register: (blocker: DraftBlocker) => () => void; request: (navigation: Navigation) => void };
const Context = createContext<Guard | null>(null);

/** Guards in-app navigation; draft values and credentials stay with the editor. */
export function UnsavedChangesProvider({ children }: { children: ReactNode }) {
  const blocker = useRef<DraftBlocker | null>(null);
  const pending = useRef<Navigation | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const register = useCallback((next: DraftBlocker) => {
    blocker.current = next;
    setBusy(next.busy);
    return () => { if (blocker.current === next) { blocker.current = null; setBusy(false); } };
  }, []);
  const request = useCallback((navigation: Navigation) => {
    if (blocker.current?.busy || savingRef.current || pending.current) return;
    if (!blocker.current?.dirty) { navigation(); return; }
    pending.current = navigation;
    setError("");
    setOpen(true);
  }, []);
  const cancel = () => { if (!savingRef.current) { pending.current = null; setOpen(false); setError(""); } };
  const proceed = async (save: boolean) => {
    if (savingRef.current) return;
    savingRef.current = true; setSaving(true); setError("");
    try {
      if (save) await blocker.current?.save();
      else blocker.current?.discard();
      const navigation = pending.current;
      pending.current = null; setOpen(false);
      navigation?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <Context.Provider value={{ register, request, busy: busy || saving }}>
    {children}
    {open && <SettingsDialog className="sm:max-w-md" title={`${blocker.current?.label ?? "设置"}有未保存的修改`} description="离开前，是否保存本次修改？" onClose={cancel} busy={saving}>
      <Feedback error={error} />
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={saving} onClick={cancel}>继续编辑</Button>
        <Button variant="outline" disabled={saving} onClick={() => void proceed(false)}>放弃修改并继续</Button>
        <Button disabled={saving} onClick={() => void proceed(true)}>{saving ? "保存中…" : "保存并继续"}</Button>
      </div>
    </SettingsDialog>}
  </Context.Provider>;
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
    const preventUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [blocker.dirty, blocker.busy]);
}
