"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");
const { serve } = require("../src/channel.cjs");

function harness(domains) {
    const input = new PassThrough();
    const output = new PassThrough();
    const frames = [];
    const waiting = [];
    require("node:readline")
        .createInterface({ input: output })
        .on("line", (line) => {
            const frame = JSON.parse(line);
            const index = waiting.findIndex((entry) => entry.match(frame));
            if (index >= 0) waiting.splice(index, 1)[0].resolve(frame);
            else frames.push(frame);
        });
    const next = (match) => {
        const index = frames.findIndex(match);
        if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0]);
        return new Promise((resolve) => waiting.push({ match, resolve }));
    };
    const done = serve({ input, output, domains });
    const send = (frame) => input.write(JSON.stringify({ version: 1, ...frame }) + "\n");
    return { next, send, done, close: () => input.end() };
}

test("announces methods, answers requests and relays Host calls", async () => {
    const channel = harness({
        "library.read": async (params, context) => ({
            params,
            projectId: context.projectId,
            core: await context.host("core.request", { method: "areal/thread/list" }),
        }),
        "library.fail": async () => {
            throw Object.assign(new Error("nope"), { code: "INVALID_PARAMS" });
        },
    });
    assert.deepEqual(await channel.next((frame) => frame.event === "ready"), {
        version: 1,
        event: "ready",
        methods: ["library.fail", "library.read"],
    });
    channel.send({ id: 1, method: "library.read", params: { q: 1 }, context: { projectId: "p" } });
    const call = await channel.next((frame) => frame.call === "core.request");
    channel.send({ id: call.id, result: { threads: [] } });
    assert.deepEqual(await channel.next((frame) => frame.id === 1), {
        version: 1,
        id: 1,
        result: { params: { q: 1 }, projectId: "p", core: { threads: [] } },
    });
    channel.send({ id: 2, method: "library.fail", params: {}, context: {} });
    assert.equal((await channel.next((frame) => frame.id === 2)).error.code, "INVALID_PARAMS");
    channel.send({ id: 3, method: "toString", params: {}, context: {} });
    assert.equal((await channel.next((frame) => frame.id === 3)).error.code, "methodNotFound");
    channel.close();
    await channel.done;
});
