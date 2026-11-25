"use strict";

function resolveNewConversationModel(models, lastAcceptedModel, catalogReady = models.length > 0) {
  const remembered =
    lastAcceptedModel &&
    models.find(
      (item) =>
        (item.providerId ?? null) === (lastAcceptedModel.model?.providerId ?? null) &&
        item.modelId === lastAcceptedModel.modelId &&
        item.availability !== "unavailable" &&
        (item.available !== false || item.availability === "checking"),
    );
  const pending = !catalogReady;
  const useRemembered = !!lastAcceptedModel && (!!remembered || pending);
  const candidate = useRemembered
    ? (remembered ?? {
        providerId: lastAcceptedModel.model?.providerId ?? null,
        modelId: lastAcceptedModel.modelId,
        availability: "checking",
      })
    : undefined;
  const effort = useRemembered ? lastAcceptedModel.reasoningEffort : undefined;
  const supported =
    candidate?.capabilities?.reasoningEffortOptions ??
    (candidate?.reasoningEffortOptions?.length ? candidate.reasoningEffortOptions : undefined);
  const configuredEffort = effort ?? candidate?.parameters?.reasoningEffort;
  const unsupportedEffort =
    configuredEffort != null &&
    configuredEffort !== "default" &&
    (candidate?.capabilities?.reasoning === false ||
      (supported != null && !supported.includes(configuredEffort)));
  return {
    candidate,
    rememberedEffort: unsupportedEffort ? resolveModelEffort(candidate, configuredEffort) : effort,
    notice: unsupportedEffort ? "effort-unsupported" : undefined,
  };
}

function resolveModelEffort(model, preferredEffort) {
  if (!model || model.capabilities?.reasoning === false) return undefined;
  const options =
    model.capabilities?.reasoningEffortOptions ??
    (model.reasoningEffortOptions?.length ? model.reasoningEffortOptions : undefined);
  if (options == null) return preferredEffort ?? model.parameters?.reasoningEffort;
  const configured = [preferredEffort, model.parameters?.reasoningEffort];
  const selected = configured.find(
    (effort) => effort != null && (effort === "default" || options.includes(effort)),
  );
  if (selected !== undefined) return selected;
  if (!options.length) return "default";
  if (configured.some((effort) => effort != null))
    return options.includes("medium") ? "medium" : options[0];
  return undefined;
}

module.exports = { resolveNewConversationModel, resolveModelEffort };
