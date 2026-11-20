import type { ComposerModelOption } from "../ComposerModelMenu.js";
import { resolveNewConversationModel, resolveModelEffort } from "@areal/workbench/model-selection";
import type { Data } from "../services.js";

export const modelValue = (item: Data) => `${item.providerId ?? ""}/${item.modelId}`;
export function draftModelSelection(
  project: Data,
  _chosenProfile: Data | undefined,
  model: string | null,
  efforts: Record<string, string>,
  requestedServiceTier?: "fast" | "default",
) {
  const initialSelection = resolveNewConversationModel(
    project.models,
    project.lastAcceptedModel,
    project.state?.connected === true,
  );
  const initialModel = initialSelection.candidate;
  const requested = model ?? (initialModel ? modelValue(initialModel) : "");
  const selected = project.models.find((item: Data) => modelValue(item) === requested);
  const unavailable =
    project.state?.connected === true &&
    requested &&
    (!selected ||
      selected.availability === "unavailable" ||
      (selected.available === false && selected.availability !== "checking"));
  const effectiveModel = unavailable ? "" : requested;
  const currentModel =
    project.models.find((item: Data) => modelValue(item) === effectiveModel) ??
    (initialModel && modelValue(initialModel) === effectiveModel ? initialModel : undefined);
  const rememberedEffort = model === null ? initialSelection.rememberedEffort : undefined;
  const effort = efforts[effectiveModel] ?? resolveModelEffort(currentModel, rememberedEffort);
  const notice =
    model === null
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

/** 模型菜单选项，以及没选到模型时发送按钮的原因：一个可用模型都没有，还是有但没选。 */
export function draftModelChoices(project: Data, effectiveModel: string, currentModel: unknown) {
  const options = draftModelOptions(project, effectiveModel, currentModel);
  const missing: "chat.composer.chooseModelReason" | "chat.composer.noModelsReason" | undefined =
    effectiveModel
      ? undefined
      : options.some((option) => !option.unavailableReason && !option.historical)
        ? "chat.composer.chooseModelReason"
        : "chat.composer.noModelsReason";
  return { options, missing };
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
  unavailableReason?: string;
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
      model.unavailableReason === "storageLocked" ||
      model.availability === "unavailable" ||
      (model.available === false && model.availability !== "checking")
        ? model.unavailableReason === "storageLocked"
          ? "钥匙串访问受限，请重新保存密钥"
          : model.credentialState === "unavailable"
            ? "缺少 API Key"
            : model.unavailableReason || "模型不可用"
        : undefined,
  };
}
