"use strict";
// 与 Host 的私有通道：每行一个 JSON 帧。设计见 docs/design/workbench-service.md。
const readline = require("node:readline");

const MAX_FRAME = 1024 * 1024;

/**
 * @param {{input: NodeJS.ReadableStream, output: NodeJS.WritableStream, domains: Record<string, (params: unknown, context: {host: (call: string, params: unknown) => Promise<unknown>, projectId?: string, principal?: unknown}) => Promise<unknown>>}} options
 */
function serve({ input, output, domains }) {
    const calls = new Map();
    let next = 0;
    const send = (frame) => {
        const line = JSON.stringify({ version: 1, ...frame });
        if (Buffer.byteLength(line) >= MAX_FRAME) throw new Error("LIMIT_EXCEEDED");
        output.write(line + "\n");
    };
    /** 反向调用 Host（core.request、vault.read）；授权由 Host 决定。 */
    const host = (call, params) =>
        new Promise((resolve, reject) => {
            const id = `w${++next}`;
            calls.set(id, { resolve, reject });
            send({ id, call, params });
        });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    lines.on("line", (line) => {
        if (Buffer.byteLength(line) >= MAX_FRAME) return;
        let frame;
        try {
            frame = JSON.parse(line);
        } catch {
            return;
        }
        if (frame?.version !== 1) return;
        if (frame.method === undefined) {
            const pending = calls.get(frame.id);
            if (!pending) return;
            calls.delete(frame.id);
            if (frame.error)
                pending.reject(Object.assign(new Error(frame.error.code), frame.error));
            else pending.resolve(frame.result);
            return;
        }
        const handler = Object.hasOwn(domains, frame.method) ? domains[frame.method] : undefined;
        if (!handler) return send({ id: frame.id, error: { code: "methodNotFound" } });
        Promise.resolve()
            .then(() => handler(frame.params, { ...frame.context, host }))
            .then(
                (result) => send({ id: frame.id, result: result ?? null }),
                (error) =>
                    send({
                        id: frame.id,
                        error: {
                            code: typeof error?.code === "string" ? error.code : "CORE_UNAVAILABLE",
                        },
                    }),
            );
    });
    send({ event: "ready", methods: Object.keys(domains).sort() });
    return new Promise((resolve) => lines.on("close", resolve));
}

module.exports = { serve, MAX_FRAME };
