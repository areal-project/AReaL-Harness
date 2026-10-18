import type { ITheme, IWindowsPty } from '@xterm/xterm';
import type { Action } from '../services.js';
interface Disposable {
    dispose(): void;
}
export interface TerminalServices {
    terminalService: {
        create(params: {
            cols: number;
            rows: number;
            cwd?: string;
            lifetime?: "turn" | "thread";
            clientId?: string;
        }): Promise<{
            id: string;
            shell: string;
            fontFamily?: string;
            fontSize?: number;
            theme?: ITheme;
            fontFamilySource?: string;
            windowsPty?: IWindowsPty;
        }>;
        hasPartialOutput(id: string): boolean;
        recover(clientId: string): Promise<boolean>;
        hasAttempt(clientId: string): boolean;
        creationFailure(clientId: string): { message: string; unknown: boolean } | undefined;
        forget(clientId: string): void;
        resize(params: {
            id: string;
            cols: number;
            rows: number;
        }): Promise<unknown>;
        write(params: {
            id: string;
            data: string;
        }): Promise<unknown>;
        dispose(params: {
            id: string;
        }): Promise<unknown>;
        onDynamicData(id: string): (fn: (data: string) => void) => Disposable;
        onDynamicExit(id: string): (fn: (code: number | null) => void) => Disposable;
    };
}
const encode = (data: string) => btoa(Array.from(new TextEncoder().encode(data), b => String.fromCharCode(b)).join(''));
export function createTerminalServices(action: Action, projectId: string, threadId: string, onError: (message: string) => void, storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): TerminalServices {
    type Process = {
        after?: string;
        closed: boolean;
        data: Set<(text: string) => void>;
        exit: Set<(code: number | null) => void>;
        chain: Promise<unknown>;
        buffer: string;
        timer?: ReturnType<typeof setTimeout>;
        decoder: TextDecoder;
        failed?: Error;
        controls: number;
        cleanupDone?: boolean;
        partialOutput?: boolean;
    };
    const processes = new Map<string, Process>();
    // A tab generation owns one create attempt. Unknown attempts are retained;
    // only an explicit receipt lookup can reconnect them, never another start.
    type Attempt = { requestId: string; state: 'pending' | 'confirmed' | 'rejected'; inFlight?: boolean; message?: string; result?: { id: string; closed?: boolean; controls?: number } };
    const creations = new Map<string, Attempt>();
    const attemptKey = (clientId: string) => `areal-gui:terminal-create:${projectId}:${threadId}:${clientId}`;
    const saveAttempt = (clientId: string, attempt: Attempt) => {
        // Only the request identity and UI acknowledgement are durable here.
        // Process identity/liveness and consumed controls are re-read from Core.
        storage?.setItem(attemptKey(clientId), JSON.stringify({ requestId: attempt.requestId, state: attempt.state, message: attempt.message }));
        creations.set(clientId, attempt);
    };
    const unknown = (message: string, requestId?: string) => Object.assign(new Error(message), { submissionUnknown: true, requestId });
    const readAttempt = (clientId: string): Attempt | undefined => {
        if (creations.has(clientId)) return creations.get(clientId);
        try {
            const raw = storage?.getItem(attemptKey(clientId));
            if (!raw) return;
            const value = JSON.parse(raw);
            if (!value || typeof value.requestId !== 'string' || !/^[0-9a-f-]{36}$/.test(value.requestId) || !['pending', 'confirmed', 'rejected'].includes(value.state)) throw new Error('invalid terminal record');
            const attempt: Attempt = { requestId: value.requestId, state: value.state, message: typeof value.message === 'string' ? value.message : undefined };
            creations.set(clientId, attempt);
            return attempt;
        } catch { throw unknown('原终端创建记录不可用，请从进程管理核对资源；不会自动重建。'); }
    };
    // CoreBackend's durable journal admits one mutation per owning Thread.
    // Multiple PTYs share that owner; serialize writes/resize/create/terminate
    // across instances while keeping long-poll output reads independent.
    let mutations: Promise<unknown> = Promise.resolve();
    const api = (operation: string, params: Record<string, unknown>): Promise<any> => {
        const request = () => action('manage', { projectId, threadId, operation, ...params });
        if (operation === 'processOutput') return request();
        const result = mutations.then(request);
        mutations = result.catch(() => {});
        return result;
    };
    const recover = async (clientId: string) => {
        const attempt = readAttempt(clientId);
        if (!attempt) throw new Error('原终端创建标识不可用；请从进程管理核对资源。');
        const receipt = await api('processSubmission', { requestId: attempt.requestId, guiOwned: true });
        if (!receipt.confirmed) return false;
        saveAttempt(clientId, { ...attempt, state: 'confirmed', result: receipt.result });
        return true;
    };
    const fail = (p: Process, error: unknown) => { p.failed = error instanceof Error ? error : new Error(String(error)); onError(p.failed.message); };
    const publishExit = async (id: string, p: Process) => {
        // Output closure is not an exit code. Ask Core for the actual outcome;
        // unavailable/old handles must never be presented as successful exit 0.
        let code: number | null = null;
        try { const result = await api('process', { id }); code = result.runtime?.exitCode ?? null; }
        catch (error) { onError((error as Error).message); }
        p.exit.forEach(fn => fn(code));
    };
    // Runtime records at most 256 controls per process, including terminate.
    // Reserve cleanup capacity and never silently create a replacement shell.
    const control = (id: string, p: Process, operation: string, values: Record<string, unknown>) => {
        p.chain = p.chain.then(async () => {
            if (p.failed || p.closed) return;
            if (p.controls >= 240) {
                p.closed = true;
                clearTimeout(p.timer);
                p.buffer = '';
                try { await api('processTerminate', { id }); p.cleanupDone = true; }
                catch (error) { fail(p, error); return; }
                const message = '当前 Core 终端控制次数已接近上限，终端已关闭。请点击重开终端继续。';
                p.data.forEach(fn => fn('\r\n[' + message + ']\r\n'));
                await publishExit(id, p); onError(message); return;
            }
            p.controls++;
            await api(operation, { id, ...values });
        }).catch(error => fail(p, error));
        return p.chain;
    };
    const flush = (id: string, p: Process) => { clearTimeout(p.timer); p.timer = undefined; if (!p.buffer || p.failed || p.closed)
        return p.chain; const data = p.buffer; p.buffer = ''; return control(id, p, 'processWrite', { dataBase64: encode(data) }); };
    const poll = async (id: string, p: Process) => { while (!p.closed) {
        try {
            const result = await api('processOutput', { id, after: p.after, maxBytes: 65536, waitMs: 1000 });
            if (p.closed)
                return;
            if ((result.gap || result.truncated) && !p.partialOutput) {
                p.partialOutput = true;
                p.data.forEach(fn => fn('\r\n[终端输出存在缺口或截断]\r\n'));
            }
            for (const chunk of result.chunks ?? []) {
                const text = p.decoder.decode(Uint8Array.from(atob(chunk.dataBase64), c => c.charCodeAt(0)), { stream: true });
                p.data.forEach(fn => fn(text));
            }
            p.after = result.nextCursor ?? p.after;
            if (result.closed) {
                p.closed = true;
                p.data.forEach(fn => fn(p.decoder.decode()));
                await publishExit(id, p);
                return;
            }
            if (!result.chunks?.length)
                await new Promise(r => setTimeout(r, 100));
        }
        catch (e) {
            fail(p, e);
            p.closed = true;
            return;
        }
    } };
    return { terminalService: {
            async create({ cols, rows, lifetime = "thread", clientId = crypto.randomUUID() }) {
                let previous = readAttempt(clientId);
                if (previous?.state === 'rejected') throw new Error(previous.message || '终端创建被拒绝，请显式重试。');
                if (previous?.state === 'pending') throw unknown('终端创建结果尚未确认，请核对原请求', previous.requestId);
                if (previous && !previous.result) {
                    const requestId = previous.requestId;
                    try {
                        if (!await recover(clientId)) throw new Error('尚未找到原终端，请核对创建结果。');
                        previous = readAttempt(clientId);
                    } catch (error) { throw unknown((error as Error).message, requestId); }
                }
                const attempt: Attempt = previous ?? { requestId: crypto.randomUUID(), state: 'pending' };
                // Persist before dispatch. A reload between dispatch and reply
                // must never turn an uncertain creation into a fresh request.
                if (!previous) { attempt.inFlight = true; saveAttempt(clientId, attempt); }
                let result;
                try { result = attempt.result ?? await api('processStart', { requestId: attempt.requestId, argv: ['/bin/sh', '-i'], lifetime, guiOwned: true, timeoutMs: 86_400_000, tty: true, cols, rows }); }
                catch (error) {
                    attempt.inFlight = false;
                    if (!(error as { submissionUnknown?: boolean }).submissionUnknown) saveAttempt(clientId, { ...attempt, state: 'rejected', message: (error as Error).message });
                    throw error;
                }
                try { saveAttempt(clientId, { ...attempt, state: 'confirmed', inFlight: false, result }); }
                catch { throw unknown('终端已创建，但本机恢复记录未保存，请核对原请求。', attempt.requestId); }
                const p: Process = { closed: result.closed === true, cleanupDone: result.closed === true, data: new Set(), exit: new Set(), chain: Promise.resolve(), controls: result.controls ?? 0, buffer: '', decoder: new TextDecoder() };
                processes.set(result.id, p);
                setTimeout(() => { if (p.closed) void publishExit(result.id, p); else void poll(result.id, p); }, 0);
                return { id: result.id, shell: '/bin/sh' };
            },
            hasPartialOutput: id => processes.get(id)?.partialOutput === true,
            recover,
            hasAttempt(clientId) { return creations.has(clientId) || storage?.getItem(attemptKey(clientId)) != null; },
            creationFailure(clientId) {
                try {
                    const attempt = readAttempt(clientId);
                    if (attempt?.state === 'pending' && !attempt.inFlight) return { message: '终端创建结果尚未确认，请核对原请求', unknown: true };
                    if (attempt?.state === 'rejected') return { message: attempt.message || '终端创建被拒绝，请显式重试。', unknown: false };
                } catch (error) { return { message: (error as Error).message, unknown: true }; }
            },
            forget(clientId) { storage?.removeItem(attemptKey(clientId)); creations.delete(clientId); },
            async resize({ id, cols, rows }) { const p = processes.get(id); if (p) return control(id, p, 'processResize', { cols, rows }); },
            async write({ id, data }) { const p = processes.get(id); if (!p || p.closed || p.failed)
                return; p.buffer += data; if (!p.timer)
                p.timer = setTimeout(() => void flush(id, p), 35); },
            async dispose({ id }) { const p = processes.get(id); if (!p)
                return; clearTimeout(p.timer); p.closed = true; await p.chain; if (p.cleanupDone) { processes.delete(id); return; } try {
                const result = await api('processTerminate', { id }); processes.delete(id); return result;
            }
            catch (e) {
                onError(e instanceof Error ? e.message : String(e)); throw e;
            } },
            onDynamicData: id => fn => { const p = processes.get(id); p?.data.add(fn); return { dispose: () => { p?.data.delete(fn); } }; },
            onDynamicExit: id => fn => { const p = processes.get(id); p?.exit.add(fn); return { dispose: () => { p?.exit.delete(fn); } }; },
        } };
}
