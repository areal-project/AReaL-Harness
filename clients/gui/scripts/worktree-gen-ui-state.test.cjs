"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { CoreBackend } = require("../app/src/core/backend.cjs");
const { SharedCoreBackend } = require("../app/src/core/service-client.cjs");

async function fixture(t) {
    const home = await mkdtemp(join(tmpdir(), "areal-worktree-gen-ui-"));
    const core = new CoreBackend({ binary: "/bin/true", home });
    const shared = new SharedCoreBackend({ home });
    t.after(async () => {
        core.genUiState.dispose();
        shared.genUiState.dispose();
        await rm(home, { recursive: true, force: true });
    });
    const logical = { id: "logical", root: join(home, "source"), state: { threads: {} } };
    const physical = {
        id: "physical",
        logicalProjectId: logical.id,
        root: join(home, "checkout", "src"),
        state: { threads: { main: { id: "main" }, side: { id: "side", parentId: "main" } } },
    };
    core.worktrees.records.set("creation", {
        state: "ready",
        projectId: logical.id,
        executionProjectId: physical.id,
        record: { directory: join(home, "checkout"), branch: "areal/test" },
        events: [],
    });
    const aggregate = core.worktrees.aggregate([logical, physical])[0];
    shared.value.projects = [aggregate];
    return { home, core, shared, logical, physical, aggregate };
}

test("generated Worktree state saved through the GUI reaches the physical follow-up without private content", async (t) => {
    const { core, shared, physical, aggregate } = await fixture(t);
    const target = { ...shared.genUiScope(aggregate, "main"), path: "/artifacts/widget.html" };
    await shared.genUiState.set(target, {
        modelContent: { selectedRate: 42 },
        privateContent: { secretNote: "keep-private" },
    });
    assert.deepEqual(shared.genUiScope(aggregate, "main"), core.genUiScope(physical, "main"));
    assert.equal((await core.genUiState.list(core.genUiScope(physical, "main"))).length, 1);
    const input = await core.genUiText(physical, "main", "Recalculate");
    assert.match(input, /selectedRate/);
    assert.match(input, /42/);
    assert.doesNotMatch(input, /secretNote|keep-private|privateContent/);
    assert.equal(await core.genUiText(physical, "other", "Recalculate"), "Recalculate");
    assert.equal(
        await core.genUiText(
            { ...physical, id: "sibling", root: join(physical.root, "sibling") },
            "main",
            "Recalculate",
        ),
        "Recalculate",
    );
});

test("Side generated state uses the same physical workspace and its own session", async (t) => {
    const { core, shared, physical, aggregate } = await fixture(t);
    const scope = shared.genUiScope(aggregate, "side");
    assert.deepEqual(scope, core.genUiScope(physical, "side"));
    await shared.genUiState.set(
        { ...scope, path: "/artifacts/side.html" },
        { modelContent: { sideRate: 7 } },
    );
    assert.match(await core.genUiText(physical, "side", "Update"), /sideRate/);
    assert.equal(await core.genUiText(physical, "main", "Update"), "Update");
});

test("regular generated state keeps its existing project and Desktop profile identity", async (t) => {
    const { home, core, shared, logical } = await fixture(t);
    assert.deepEqual(shared.genUiScope(logical, "ordinary"), {
        workspacePath: logical.root,
        workspaceIdentity: `${home}:${logical.id}`,
        sessionId: "ordinary",
    });
    await shared.genUiState.set(
        { ...shared.genUiScope(logical, "ordinary"), path: "/artifacts/ordinary.html" },
        { modelContent: { ordinaryRate: 9 } },
    );
    assert.match(await core.genUiText(logical, "ordinary", "Update"), /ordinaryRate/);
    const otherProfile = new CoreBackend({
        binary: "/bin/true",
        home: join(home, "other-profile"),
    });
    t.after(() => otherProfile.genUiState.dispose());
    assert.equal(await otherProfile.genUiText(logical, "ordinary", "Update"), "Update");
});

test("an isolated thread with incomplete workspace binding cannot use logical project state", async (t) => {
    const { shared, aggregate } = await fixture(t);
    delete aggregate.state.threads.main.worktree;
    assert.throws(() => shared.genUiScope(aggregate, "main"), /执行工作区身份尚未确认/);
});
