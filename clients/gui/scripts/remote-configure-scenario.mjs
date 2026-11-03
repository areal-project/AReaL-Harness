import assert from "node:assert/strict";

export async function fastPreservation({ rpc, native }) {
  const fastThread = (await rpc("session.create")).result.threadId;
  const fastBaseline = await native("areal/thread/observe", { threadId: fastThread });
  await native("areal/thread/configure", {
    threadId: fastThread,
    expectedRevision: fastBaseline.thread.desktop.configuration.revision,
    parameters: { serviceTier: "fast", reasoningEffort: "low" },
  });
  const fastConfigured = await native("areal/thread/observe", { threadId: fastThread });
  const effortSaved = await rpc("session.control", {
    threadId: fastThread,
    operation: "configure",
    expectedRevision: fastConfigured.thread.desktop.configuration.revision,
    values: { parameters: { reasoningEffort: "high" } },
  });
  assert.equal(effortSaved.result?.admissionState, "accepted", JSON.stringify(effortSaved));
  const fastRetained = await native("areal/thread/observe", { threadId: fastThread });
  assert.equal(fastRetained.thread.desktop.configuration.parameters.serviceTier, "fast");
  assert.equal(fastRetained.thread.desktop.configuration.parameters.reasoningEffort, "high");
  return { fastThread, effortSaved, configuration: fastRetained.thread.desktop.configuration };
}
