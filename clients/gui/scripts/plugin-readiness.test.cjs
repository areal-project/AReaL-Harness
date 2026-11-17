"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { manage } = require("@areal/workbench-service/desktop/core/management.cjs");
const {
  validateCommand,
  commandSemantics,
} = require("../packages/workbench/client/desktop-contract.cjs");
function fixture(tools, overrides = {}) {
  const detail = {
    id: "fixture@local",
    installed: true,
    enabled: true,
    installedDigest: "snapshot",
    installedSkills: [
      { requiredTools: ["browser_v1"] },
      { requiredTools: ["fixture_missing_tool", "browser_v1"] },
    ],
    ...overrides,
  };
  const project = {
    client: {
      request: async (method, params) => {
        assert.equal(method, "areal/plugin/read");
        assert.deepEqual(params, { id: detail.id });
        return detail;
      },
    },
  };
  const backend = {
    desktopTools: (owner) => {
      assert.equal(owner, project);
      return tools.map((name) => ({ name }));
    },
  };
  return { project, backend };
}
test("readiness is a read operation and validates exact installed identity", async () => {
  const request = {
    projectId: "p",
    operation: "pluginReadiness",
    id: "fixture@local",
    expectedDigest: "snapshot",
  };
  assert.doesNotThrow(() => validateCommand("manage", request));
  assert.equal(commandSemantics("manage", request).effect, "read");
  for (const bad of [
    { ...request, id: "" },
    { ...request, expectedDigest: "" },
  ])
    assert.throws(() => validateCommand("manage", bad));
  const { backend, project } = fixture(["browser_v1"]);
  await assert.rejects(
    manage(backend, project, { ...request, expectedDigest: "stale" }),
    /snapshot|快照/,
  );
});
test("declared requirements use actual deployed tools and never infer prose or request permissions", async () => {
  const request = {
    projectId: "p",
    operation: "pluginReadiness",
    id: "fixture@local",
    expectedDigest: "snapshot",
  };
  for (const [tools, expectedMissing, expectedAvailable] of [
    [["browser_v1", "js", "js_reset"], ["fixture_missing_tool"], false],
    [["browser_v1"], ["fixture_missing_tool"], false],
    [[], ["browser_v1", "fixture_missing_tool"], false],
  ]) {
    const { backend, project } = fixture(tools);
    const value = await manage(backend, project, request);
    assert.deepEqual(value, {
      pluginId: "fixture@local",
      installedDigest: "snapshot",
      requiredTools: ["browser_v1", "fixture_missing_tool"],
      missingTools: expectedMissing,
      available: expectedAvailable,
    });
  }
  {
    const { backend, project } = fixture(["browser_v1"], {
      installedSkills: [{ requiredTools: ["browser_v1"] }],
    });
    const value = await manage(backend, project, request);
    assert.deepEqual(value, {
      pluginId: "fixture@local",
      installedDigest: "snapshot",
      requiredTools: ["browser_v1"],
      missingTools: [],
      available: true,
    });
  }
  {
    const { backend, project } = fixture([], {
      installedSkills: [{ requiredTools: ["browser_v1"] }],
    });
    const value = await manage(backend, project, request);
    assert.deepEqual(value, {
      pluginId: "fixture@local",
      installedDigest: "snapshot",
      requiredTools: ["browser_v1"],
      missingTools: ["browser_v1"],
      available: false,
    });
  }
  const { backend, project } = fixture([], {
    installedSkills: [{ description: "use fixture_missing_tool and browser_v1" }],
  });
  assert.equal((await manage(backend, project, request)).available, true);
});
test("uninstalled, disabled, and malformed snapshot requests cannot report ready", async () => {
  for (const overrides of [{ installed: false }, { enabled: false }, { installedDigest: "new" }]) {
    const { backend, project } = fixture(["browser_v1", "fixture_missing_tool"], overrides);
    await assert.rejects(
      manage(backend, project, {
        projectId: "p",
        operation: "pluginReadiness",
        id: "fixture@local",
        expectedDigest: "snapshot",
      }),
    );
  }
});
test("disabled package Skills do not block the remaining enabled components", async () => {
  const { backend, project } = fixture(["browser_v1"], {
    installedSkills: [
      { id: "browser", requiredTools: ["browser_v1"] },
      { id: "computer", requiredTools: ["fixture_missing_tool"] },
    ],
    componentChoices: { disabledSkills: ["computer"] },
  });
  const result = await manage(backend, project, {
    projectId: "p",
    operation: "pluginReadiness",
    id: "fixture@local",
    expectedDigest: "snapshot",
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.requiredTools, ["browser_v1"]);
});
