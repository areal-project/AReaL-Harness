import assert from "node:assert/strict";
import { test } from "node:test";
import { presentPlugin } from "../renderer/src/settings/pluginPresentation.ts";
const detail = {
  id: "example@local",
  installed: true,
  enabled: true,
  installedDigest: "fixed",
  installedSkills: [{ id: "skill" }],
  componentChoices: {},
  installedComponentSupport: {
    digest: "fixed",
    compatibility: { state: "allowed" },
    components: [
      { kind: "skills", status: "supported" },
      { kind: "mcp", status: "supported" },
      { kind: "hooks", required: false, status: "supported" },
    ],
  },
};
const connection = {
  pluginId: detail.id,
  installedDigest: "fixed",
  authRequired: false,
  authPending: false,
  authUnknown: false,
  connected: false,
  partial: false,
  cleanupUnknown: false,
  uncertain: false,
  configurationBlocked: false,
  mappingRequired: false,
};
test("mixed plugins preserve enabled Skills and independent Hook review while MCP needs login", () => {
  const result = presentPlugin({
    detail,
    runtimeObserved: true,
    connection: { ...connection, authRequired: true },
  });
  assert.deepEqual(result, {
    state: "partial",
    nextAction: "connections",
    skillsAvailable: true,
    hookReviewRequired: true,
  });
  assert.equal(
    presentPlugin({
      detail,
      runtimeObserved: true,
      connection: { ...connection, authPending: true },
    }).state,
    "authenticationPending",
  );
});
test("unobserved and mismatched runtime facts cannot report ready", () => {
  assert.equal(presentPlugin({ detail, runtimeObserved: false }).state, "notObserved");
  const result = presentPlugin({
    detail,
    runtimeObserved: true,
    connection: { ...connection, installedDigest: "old", connected: true },
  });
  assert.notEqual(result.state, "available");
  assert.equal(result.skillsAvailable, true);
});
test("an unresolved original receipt wins only for its own plugin and never changes facts", () => {
  const submission = {
    mutation: "pluginInstall",
    requestId: "original",
    projectId: "p",
    pluginId: detail.id,
  };
  const frozen = structuredClone(detail);
  assert.equal(
    presentPlugin({ detail, runtimeObserved: false, submission }).nextAction,
    "queryOriginal",
  );
  assert.notEqual(
    presentPlugin({ detail: { ...detail, id: "other" }, runtimeObserved: false, submission }).state,
    "unknown",
  );
  assert.deepEqual(detail, frozen);
  assert.equal(submission.requestId, "original");
});
test("optional Hooks do not block pure Skills, required compatibility and partial support remain visible", () => {
  const skills = {
    ...detail,
    installedComponentSupport: {
      ...detail.installedComponentSupport,
      components: detail.installedComponentSupport.components.filter((row) => row.kind !== "mcp"),
    },
  };
  assert.equal(presentPlugin({ detail: skills, runtimeObserved: true }).state, "available");
  assert.equal(
    presentPlugin({
      detail: {
        ...skills,
        installedComponentSupport: {
          ...skills.installedComponentSupport,
          compatibility: { state: "blocked" },
        },
      },
      runtimeObserved: true,
    }).state,
    "blocked",
  );
  assert.equal(
    presentPlugin({
      detail: {
        ...skills,
        installedComponentSupport: {
          ...skills.installedComponentSupport,
          components: [
            { kind: "skills", status: "supported" },
            { kind: "agents", status: "unsupported" },
          ],
        },
      },
      runtimeObserved: true,
    }).state,
    "partial",
  );
});

test("required configuration and Agent publication diagnostics preserve available Skills and give a concrete next step", () => {
  const missing = presentPlugin({
    detail: { ...detail, userConfiguration: { missingRequired: ["TOKEN"] } },
    runtimeObserved: true,
  });
  assert.equal(missing.state, "partial");
  assert.equal(missing.nextAction, "configure");
  assert.equal(missing.skillsAvailable, true);
  const diagnostics = presentPlugin({
    detail,
    runtimeObserved: true,
    runtimeDiagnostics: ["Profile capacity exceeded"],
  });
  assert.equal(diagnostics.state, "partial");
  assert.equal(diagnostics.nextAction, "components");
});

test("offline installation gives an explicit project selection or connection step before source resolution", () => {
  const candidate = { ...detail, installed: false, installedDigest: null };
  assert.equal(
    presentPlugin({ detail: candidate, runtimeObserved: false, projectSelected: false }).nextAction,
    "chooseProject",
  );
  assert.equal(
    presentPlugin({ detail: candidate, runtimeObserved: false, projectSelected: true }).nextAction,
    "connectProject",
  );
  assert.equal(
    presentPlugin({ detail: candidate, runtimeObserved: true, projectSelected: true }).nextAction,
    "install",
  );
  assert.equal(
    presentPlugin({ detail, runtimeObserved: false, projectSelected: true }).nextAction,
    "connectProject",
  );
});
