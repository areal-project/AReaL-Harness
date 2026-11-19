import { useEffect, useRef } from "react";
import type { Action, Data } from "../services.js";
import { isProjectHibernated } from "./userStates.js";

/**
 * 项目因空闲休眠时，仅在用户主动编辑出非空输入后静默预热 Core，
 * 不因输入框里原本留着未发草稿而在进入休眠时反复唤醒（否则会破坏后台回收）。
 *
 * 返回当前输入会话是否处于本次编辑触发的静默唤醒窗口内，避免编辑器在 starting 期间变灰。
 */
export function useSilentHibernatePrewarm({
  project,
  threadId,
  text,
  action,
  enabled = true,
}: {
  project: Data | undefined;
  threadId?: string;
  text: string;
  action: Action;
  enabled?: boolean;
}): boolean {
  const hibernated = isProjectHibernated(project);
  const connected = project?.state?.connected === true;
  const hostState = project?.state?.hostState;
  const scope = project ? `${project.id}:${threadId ?? ""}` : "";
  const previousTextRef = useRef<{ scope: string; text: string }>({ scope, text });
  const prewarmedScopeRef = useRef<string | null>(null);
  const requestRef = useRef(action);
  requestRef.current = action;

  if (connected || !project || project.scheduling?.suppressed === true) {
    prewarmedScopeRef.current = null;
  }

  useEffect(() => {
    const previous = previousTextRef.current;
    const textChanged = previous.scope === scope && previous.text !== text;
    previousTextRef.current = { scope, text };

    if (!enabled || !project || !hibernated || !textChanged) return;
    if (!text.trim()) return;
    if (prewarmedScopeRef.current === scope) return;

    prewarmedScopeRef.current = scope;
    void requestRef.current("connect", { projectId: project.id }).catch(() => {
      if (prewarmedScopeRef.current === scope) prewarmedScopeRef.current = null;
    });
  }, [enabled, hibernated, project, scope, text]);

  return (
    !connected && prewarmedScopeRef.current === scope && (hibernated || hostState === "starting")
  );
}
