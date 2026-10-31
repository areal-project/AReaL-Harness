import { describe, expect, it } from "vite-plus/test";
import { draftModelSelection } from "./draftModelSelection.js";

const model = {
  providerId: "direct",
  modelId: "family/shared-model",
  isDefault: true,
  parameters: { reasoningEffort: "low" },
  capabilities: { reasoning: true, reasoningEffortOptions: ["low", "high"] },
};
const project = { models: [model], state: { connected: true } };
const value = "direct/family/shared-model";

describe("desktop draft explicit effort", () => {
  it.each(["none", "minimal", "max", "custom-effort", "default"])(
    "preserves explicit %s even when absent from catalog capabilities",
    (effort) => {
      expect(draftModelSelection(project, undefined, value, { [value]: effort }).effort).toBe(
        effort,
      );
    },
  );

  it("preserves explicit effort when reasoning is disabled", () => {
    const disabled = { ...project, models: [{ ...model, capabilities: { reasoning: false } }] };
    expect(draftModelSelection(disabled, undefined, value, { [value]: "max" }).effort).toBe("max");
  });

  it("keeps independent choices for providers sharing a model ID", () => {
    const providers = { ...project, models: [model, { ...model, providerId: "relay" }] };
    const efforts = { [value]: "minimal", "relay/family/shared-model": "max" };
    expect(draftModelSelection(providers, undefined, value, efforts).effort).toBe("minimal");
    expect(
      draftModelSelection(providers, undefined, "relay/family/shared-model", efforts).effort,
    ).toBe("max");
  });

  it("retains the existing fallback for an unsupported inherited preference", () => {
    const remembered = {
      ...project,
      lastAcceptedModel: {
        model: { providerId: "direct" },
        modelId: model.modelId,
        reasoningEffort: "max",
      },
    };
    expect(draftModelSelection(remembered, undefined, null, {})).toMatchObject({
      effectiveModel: value,
      effort: "low",
      notice: "effort-unsupported",
    });
    expect(draftModelSelection(remembered, undefined, null, { [value]: "max" }).effort).toBe("max");
  });
});

describe("desktop draft Fast intent", () => {
  const fastProject = {
    ...project,
    models: [
      { ...model, parameters: { reasoningEffort: "low", serviceTier: "fast" } },
      { ...model, providerId: "relay", parameters: { reasoningEffort: "high" } },
    ],
  };

  it("inherits configured Fast independently from effort", () => {
    expect(draftModelSelection(fastProject, undefined, value, { [value]: "max" })).toMatchObject({
      effort: "max",
      serviceTier: "fast",
    });
  });

  it("keeps explicit Off over configured Fast", () => {
    expect(draftModelSelection(fastProject, undefined, value, {}, "default")).toMatchObject({
      effort: "low",
      serviceTier: "default",
    });
  });

  it("carries explicit Fast across model changes without changing effort", () => {
    expect(
      draftModelSelection(fastProject, undefined, "relay/family/shared-model", {}, "fast"),
    ).toMatchObject({ effort: "high", serviceTier: "fast" });
    expect(
      draftModelSelection(fastProject, undefined, "relay/family/shared-model", {}).serviceTier,
    ).toBeUndefined();
  });
});
