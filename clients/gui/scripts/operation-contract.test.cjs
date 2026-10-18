"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    validateCommand,
    validateCommandResponse,
} = require("../packages/workbench/client/desktop-contract.cjs");
test("Side model modes reject malformed references and ambiguous default selection", () => {
    const start = {
        projectId: "p",
        operation: "start",
        sourceThreadId: "s",
        requestId: "r",
        text: "question",
        workspaceAccess: "none",
    };
    for (const extra of [{}, { resetModel: true }, { model: { providerId: "p", modelId: "C" } }])
        assert.doesNotThrow(() => validateCommand("side", { ...start, ...extra }));
    for (const extra of [
        { resetModel: true, model: { providerId: "p", modelId: "C" } },
        { model: {} },
        { workspaceAccess: "write" },
    ])
        assert.throws(() => validateCommand("side", { ...start, ...extra }));
});
test("critical operation responses fail malformed identity, pages and recovery outcomes", () => {
    for (const [name, params, bad] of [
        ["fork", {}, {}],
        ["configure", {}, {}],
        ["side", { operation: "recover" }, { confirmed: true }],
        ["side", { operation: "list" }, { data: null }],
        ["side", { operation: "context" }, { snapshotId: "s", evidence: null }],
    ])
        assert.throws(() => validateCommandResponse(name, params, bad));
    assert.doesNotThrow(() =>
        validateCommandResponse("side", { operation: "recover" }, { confirmed: false }),
    );
    assert.doesNotThrow(() =>
        validateCommandResponse(
            "side",
            { operation: "recover" },
            { confirmed: true, threadId: "s" },
        ),
    );
});
