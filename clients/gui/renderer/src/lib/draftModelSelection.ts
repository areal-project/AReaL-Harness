import type { ComposerModelOption } from "../ComposerModelMenu.js";
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

export function draftModelOptions(
  project: import("../services.js").Data,
  effectiveModel: string,
  currentModel: unknown,
) {
  return [
    ...project.models
      .filter(
        (item: Data) =>
          modelValue(item) === effectiveModel ||
          item.providerId ||
          !project.models.some((candidate: Data) => candidate.providerId && candidate.isDefault),
      )
      .map((item: Parameters<typeof composerModelOption>[0]) => ({
        ...composerModelOption(item),
        value: modelValue(item),
      })),
    ...(!currentModel && effectiveModel
      ? [
          {
            value: effectiveModel,
            label: effectiveModel.slice(effectiveModel.indexOf("/") + 1),
            providerId: effectiveModel.slice(0, effectiveModel.indexOf("/")),
            historical: true,
          },
        ]
      : []),
  ];
}

/** 可用性直接投影 Core 目录，不在 Renderer 重新判断凭据。 */
export function composerModelOption(model: {
  providerId?: string | null;
  providerName?: string;
  modelId: string;
  displayName?: string;
  reasoningEffortOptions?: readonly string[];
  capabilities?: { reasoning: boolean; reasoningEffortOptions?: readonly string[] };
  available?: boolean;
  availability?: "checking" | "available" | "unavailable";
  credentialState?: string;
}): ComposerModelOption {
  return {
    value: model.providerId ? `${model.providerId}/${model.modelId}` : "",
    label: model.displayName ?? model.modelId,
    providerId: model.providerId ?? undefined,
    providerName: model.providerName,
    efforts: model.reasoningEffortOptions,
    reasoning: model.capabilities?.reasoning,
    effortsKnown:
      model.capabilities?.reasoningEffortOptions !== undefined ||
      !!model.reasoningEffortOptions?.length,
    unavailableReason:
      model.availability === "unavailable" ||
      (model.available === false && model.availability !== "checking")
        ? model.credentialState === "unavailable"
          ? "缺少 API Key"
          : "模型不可用"
        : undefined,
  };
}
