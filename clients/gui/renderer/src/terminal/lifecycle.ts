type State = { generation: number; restarting: boolean };
/** 生命周期属于任务，面板卸载不会丢失正在进行的关闭。 */
export function createTerminalLifecycle(persistence?: { load(owner: string): number; save(owner: string, generation: number): void; remove(owner: string): void }) {
    const owners = new Map<string, State>();
    const listeners = new Set<() => void>();
    const snapshot = (owner: string) => {
        if (!owners.has(owner)) owners.set(owner, { generation: persistence?.load(owner) ?? 0, restarting: false });
        return owners.get(owner)!;
    };
    const publish = (owner: string, state: State) => { owners.set(owner, state); listeners.forEach(fn => fn()); };
    return {
        snapshot,
        forget(owner: string) { persistence?.remove(owner); owners.delete(owner); },
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
        async restart(owner: string, close: (generation: number) => Promise<void>) {
            const previous = snapshot(owner);
            if (previous.restarting) return;
            publish(owner, { ...previous, restarting: true });
            try { await close(previous.generation); persistence?.save(owner, previous.generation + 1); publish(owner, { generation: previous.generation + 1, restarting: false }); }
            catch (error) { publish(owner, previous); throw error; }
        },
    };
}
