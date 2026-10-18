import { useSyncExternalStore } from "react";
import type { Action } from "../services.js";
import { createTerminalServices } from "./coreTerminalService.js";
import { createTerminalLifecycle } from "./lifecycle.js";
import { sidePaneTerminalSessionRegistry } from "./sidePaneTerminalSessionRegistry.js";

type Workspace = { ids: string[]; active: string; closing: string[] };
const workspaces = new Map<string, Workspace>();
const listeners = new Set<() => void>();
const services = new Map<string, ReturnType<typeof createTerminalServices>>();
const failures = new Map<string, { message: string; unknown: boolean }>();
const generationKey = (owner: string) => `areal-gui:terminal-generation:${owner}`;
export const terminalLifecycle = createTerminalLifecycle({
  load(owner) { const value = Number(localStorage.getItem(generationKey(owner))); return Number.isSafeInteger(value) && value >= 0 ? value : 0; },
  save(owner, generation) { localStorage.setItem(generationKey(owner), String(generation)); },
  remove(owner) { localStorage.removeItem(generationKey(owner)); },
});
export const terminalOwner = (projectId: string, threadId: string) => `${projectId}:${threadId}`;
export const isTerminalTab = (id: string) => id.startsWith("terminal:");
const snapshot = (owner: string): Workspace => {
  if (!workspaces.has(owner)) {
    let ids: string[] = [], active = "";
    try {
      const saved = JSON.parse(localStorage.getItem(`areal-gui:terminals:${owner}`) ?? 'null');
      if (Array.isArray(saved?.ids)) ids = [...new Set<string>(saved.ids.filter((id: unknown) => typeof id === 'string' && /^terminal:[0-9a-f-]{36}$/.test(id)))];
      active = ids.includes(saved?.active) ? saved.active : ids.at(-1) ?? "";
    } catch { /* No execution can be inferred from invalid UI metadata. */ }
    workspaces.set(owner, { ids, active, closing: [] });
  }
  return workspaces.get(owner)!;
};
const publish = (owner: string, state: Workspace) => {
  localStorage.setItem(`areal-gui:terminals:${owner}`, JSON.stringify({ ids: state.ids, active: state.active }));
  workspaces.set(owner, state); listeners.forEach(fn => fn());
};
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useTerminalWorkspace = (owner: string) => useSyncExternalStore(subscribe, () => snapshot(owner));
export const terminalFailure = (owner: string, id: string) => failures.get(`${owner}:${id}`);
export function recordTerminalFailure(owner: string, id: string, error?: unknown) {
  if (!snapshot(owner).ids.includes(id)) return;
  if (error) failures.set(`${owner}:${id}`, { message: error instanceof Error ? error.message : String(error), unknown: !!(error as { submissionUnknown?: boolean }).submissionUnknown });
  else failures.delete(`${owner}:${id}`);
  publish(owner, { ...snapshot(owner) });
}
export type TerminalLifetime = 'turn' | 'thread';
const lifetimeKey = (owner: string, id: string) => `areal-gui:terminal-lifetime:${owner}:${id}`;
export const terminalLifetime = (owner: string, id: string): TerminalLifetime => localStorage.getItem(lifetimeKey(owner, id)) === 'turn' ? 'turn' : 'thread';
export function addTerminal(owner: string, lifetime: TerminalLifetime = 'thread') {
  const id = `terminal:${crypto.randomUUID()}`, state = snapshot(owner);
  localStorage.setItem(lifetimeKey(owner, id), lifetime);
  publish(owner, { ...state, ids: [...state.ids, id], active: id });
  return id;
}
export const ensureTerminal = (owner: string) => snapshot(owner).active || addTerminal(owner);
export function selectTerminal(owner: string, id: string) {
  const state = snapshot(owner);
  if (state.ids.includes(id) && state.active !== id) publish(owner, { ...state, active: id });
}
export function terminalTitle(owner: string, id: string, root: string) {
  const state = snapshot(owner), name = root.split(/[\\/]/).filter(Boolean).at(-1) || "终端";
  return state.ids.length > 1 ? `${name} ${state.ids.indexOf(id) + 1}` : name;
}
export function terminalServices(action: Action, projectId: string, threadId: string, onError: (s: string) => void) {
  const owner = terminalOwner(projectId, threadId);
  if (!services.has(owner)) services.set(owner, createTerminalServices(action, projectId, threadId, onError, localStorage));
  return services.get(owner)!;
}
export async function closeTerminal(owner: string, id: string) {
  const state = snapshot(owner);
  if (!state.ids.includes(id)) return;
  if (state.closing.includes(id)) throw new Error("终端正在关闭，请稍候。");
  const lifecycle = terminalLifecycle.snapshot(`${owner}:${id}`);
  if (lifecycle.restarting) throw new Error("终端正在重开，请稍候。");
  const entry = sidePaneTerminalSessionRegistry.get(`${owner}:${id}:${lifecycle.generation}`);
  const failure = terminalFailure(owner, id) ?? services.get(owner)?.terminalService.creationFailure(`${owner}:${id}:${lifecycle.generation}`);
  if (failure?.unknown) throw new Error("终端创建结果尚未确认，请先检查发送状态；不会自动重建。");
  if (!entry?.terminalId && !failure) throw new Error("终端仍在创建，请稍后关闭。");
  publish(owner, { ...state, closing: [...state.closing, id] });
  try {
    // Keep identity and its tab until the existing process owner confirms cleanup.
    if (entry?.terminalId) await services.get(owner)!.terminalService.dispose({ id: entry.terminalId });
    if (entry) sidePaneTerminalSessionRegistry.release(entry.key);
    failures.delete(`${owner}:${id}`);
    const current = snapshot(owner), ids = current.ids.filter(value => value !== id);
    publish(owner, { ids, active: current.active === id ? ids.at(-1) ?? "" : current.active, closing: current.closing.filter(value => value !== id) });
    services.get(owner)?.terminalService.forget(`${owner}:${id}:${lifecycle.generation}`);
    terminalLifecycle.forget(`${owner}:${id}`);
    localStorage.removeItem(lifetimeKey(owner, id));
  } catch (error) {
    const current = snapshot(owner);
    publish(owner, { ...current, closing: current.closing.filter(value => value !== id) });
    throw error;
  }
}
