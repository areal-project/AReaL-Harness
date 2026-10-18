import { useRef, useState } from "react";

/** UI admission only. The caller owns drafts and the backend owns save success. */
export function useSettingsOperation() {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const execute = async <T,>(task: () => Promise<T>): Promise<T> => {
    if (active.current) throw new Error("操作正在进行，请稍候。");
    active.current = true;
    setBusy(true); setError(""); setMessage("");
    try { return await task(); }
    finally { active.current = false; setBusy(false); }
  };
  // Event handlers report locally; navigation saves use execute so failure blocks leaving.
  const run = async (task: () => Promise<unknown>) => {
    if (active.current) return;
    try { await execute(task); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
  };
  return { busy, error, message, setError, setMessage, execute, run };
}
