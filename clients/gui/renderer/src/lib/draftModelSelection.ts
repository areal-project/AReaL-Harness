import { resolveNewConversationModel, resolveModelEffort } from "@areal/workbench/model-selection";
import type { Data } from "../services.js";

export const modelValue = (item: Data) => `${item.providerId ?? ""}/${item.modelId}`;
export function draftModelSelection(
  project: Data,
  chosenProfile: Data | undefined,
  model: string | null,
  efforts: Record<string, string>,
  requestedServiceTier?: "fast" | "default",
) {
  const initialSelection = resolveNewConversationModel(
    project.models,
    project.lastAcceptedModel,
    project.state?.connected === true,
  );
  const initialModel = chosenProfile?.model
    ? project.models.find(
        (item: Data) =>
          item.providerId === chosenProfile.model.providerId &&
          item.modelId === chosenProfile.model.modelId,
      )
    : initialSelection.candidate;
  const effectiveModel =
    model ??
    (chosenProfile?.model
      ? `${chosenProfile.model.providerId}/${chosenProfile.model.modelId}`
      : initialModel
        ? modelValue(initialModel)
        : "");
  const currentModel =
    project.models.find((item: Data) => modelValue(item) === effectiveModel) ??
    (initialModel && modelValue(initialModel) === effectiveModel ? initialModel : undefined);
  const rememberedEffort =
    !chosenProfile?.model && model === null ? initialSelection.rememberedEffort : undefined;
  const effort = efforts[effectiveModel] ?? resolveModelEffort(currentModel, rememberedEffort);
  const notice =
    model === null && !chosenProfile?.model
      ? initialSelection.notice === "effort-unsupported"
        ? "effort-unsupported"
        : ""
      : "";
  const serviceTier = requestedServiceTier ?? currentModel?.parameters?.serviceTier;
  return { effectiveModel, currentModel, effort, serviceTier, notice };
}
