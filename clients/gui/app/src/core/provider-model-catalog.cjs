// @ts-check
"use strict";
const providerContract = require("./provider-contract.cjs");
/** @typedef {import('./project-state.cjs').CoreProject} CoreProject */
/** @param {InstanceType<typeof import('./providers.cjs').AppProviders>} providers @param {import('./provider-contract.cjs').ModelCatalogEntry[]} models @param {CoreProject} project */
function catalog(providers, models, project) {
  const configuration = project.providerSnapshot ?? providers.config.value;
  const references = Object.values(project.configurations ?? {}).flatMap((value) =>
    value?.model?.providerId === "areal_openai" ? [value.model.modelId] : [],
  );
  const configured = JSON.stringify(references);
  const previous = providers.catalogs.get(project);
  if (
    previous?.models === models &&
    previous.configuration === configuration &&
    previous.subscription === providers.subscription &&
    previous.accepted === providers.lastAcceptedModel &&
    previous.configured === configured
  )
    return previous.result;
  const metadata = providers.subscription.models;
  const accepted = providers.lastAcceptedModel?.model;
  const rememberedIds = new Set([
    ...references,
    ...(accepted?.providerId === "areal_openai" ? [accepted.modelId] : []),
  ]);
  const remembered =
    providers.subscription.availability === "checking"
      ? [...rememberedIds]
          .filter((id) => !metadata.some((model) => model.id === id))
          .map((id) => ({ id }))
      : [];
  /** @type {import('@areal/workbench/desktop-contract/provider').SubscriptionModel[]} */
  const subscriptionModels = [...metadata, ...remembered];
  const known = new Set(
    models.filter((m) => m.providerId === "areal_openai").map((m) => m.modelId),
  );
  /** @type {import('./provider-contract.cjs').ModelCatalogEntry[]} */
  const cached = providers.subscription.authenticated
    ? subscriptionModels
        .filter((m) => !known.has(m.id))
        .map((m) => ({
          providerId: "areal_openai",
          modelId: m.id,
          providerRevision: null,
          displayName: m.name ?? m.id,
          parameters: m.parameters ?? {},
          ...(m.parameters ? { contextWindowTokens: m.parameters.contextWindowTokens } : {}),
          reasoningEffortOptions: m.reasoningEffortOptions ?? [],
          ...(m.reasoningEffortOptions === undefined
            ? {}
            : {
                capabilities: {
                  tools: true,
                  vision: true,
                  reasoning: true,
                  reasoningEffortOptions: m.reasoningEffortOptions,
                },
              }),
        }))
    : [];
  const result = [...models, ...cached].map(
    /** @returns {import('./provider-contract.cjs').ModelCatalogEntry} */ (m) => ({
      ...m,
      providerName:
        m.providerId === "areal_openai"
          ? "ChatGPT"
          : configuration?.data.find((provider) => provider.id === m.providerId)?.name,
      ...(m.providerId === "areal_openai"
        ? {
            availability: m.invalidReason
              ? "unavailable"
              : providers.subscription.availability === "checking"
                ? "checking"
                : providers.subscription.authenticated &&
                    metadata.some((item) => item.id === m.modelId)
                  ? "available"
                  : "unavailable",
            available: m.invalidReason
              ? false
              : providers.subscription.availability === "checking"
                ? undefined
                : providers.subscription.authenticated &&
                  metadata.some((item) => item.id === m.modelId),
          }
        : {}),
      displayName:
        m.providerId === "areal_openai"
          ? (metadata.find((item) => item.id === m.modelId)?.name ?? m.displayName ?? m.modelId)
          : providers.model(m, project)?.displayName || m.displayName || m.modelId,
    }),
  );
  providers.catalogs.set(project, {
    models,
    configuration,
    subscription: providers.subscription,
    accepted: providers.lastAcceptedModel,
    configured,
    result,
  });
  return result;
}
/** @param {InstanceType<typeof import('./providers.cjs').AppProviders>} providers @param {CoreProject} project @param {import('./provider-contract.cjs').ModelRef|null|undefined} model @param {unknown} error */
function rejectModel(providers, project, model, error) {
  if (
    !model ||
    !providerContract.record(error) ||
    error.code !== -32602 ||
    !["unknown model", "MODEL_NOT_CONFIGURED"].includes(String(error.message))
  )
    return;
  const entries = project.models ?? [];
  const existing = entries.some(
    (item) => item.providerId === model.providerId && item.modelId === model.modelId,
  );
  const rejected = entries.map(
    /** @returns {import('./provider-contract.cjs').ModelCatalogEntry} */ (item) =>
      item.providerId === model.providerId && item.modelId === model.modelId
        ? {
            ...item,
            available: false,
            availability: "unavailable",
            invalidReason: String(error.message),
          }
        : item,
  );
  if (!existing)
    rejected.push({
      ...model,
      providerRevision: null,
      available: false,
      availability: "unavailable",
      invalidReason: String(error.message),
    });
  project.models = rejected;
  providers.backend.onChange();
}

/** @param {InstanceType<typeof import('./providers.cjs').AppProviders>} providers @param {import('./provider-contract.cjs').ModelCatalogEntry} model @param {CoreProject} project */
function subscriptionAvailable(providers, model, project) {
  if (model.providerId !== "areal_openai") return true;
  const application = providers.subscriptionApplications.get(project),
    service = providers.openaiService;
  const scope = application?.scope;
  return (
    !!scope &&
    !providers.closed &&
    !providers.backend.closing &&
    scope.service === service &&
    !!service?.endpoint &&
    (!providers.backend.projects || providers.backend.projects.get(project.id) === project) &&
    scope.target.serviceId === project.service?.serviceId &&
    scope.target.generation === project.service?.generation &&
    scope.accountRevision === service.account.revision &&
    scope.accountLifetime === service.account.lifetime &&
    !!scope.accountLifetime &&
    !scope.accountLifetime.signal.aborted &&
    model.providerRevision === application.providerRevision &&
    service.models.some((item) => item.id === model.modelId)
  );
}

module.exports = { subscriptionAvailable, catalog, rejectModel };
