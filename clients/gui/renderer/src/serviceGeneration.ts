declare const serviceGenerationBrand: unique symbol;
export type ServiceGeneration = string & { readonly [serviceGenerationBrand]: true };

/** 从公开读取或共享投影取得服务代际；instanceId 是另一种身份。 */
export function serviceGeneration(core: unknown): ServiceGeneration | undefined {
  if (!core || typeof core !== "object" || !("serviceGeneration" in core)) return undefined;
  const value = core.serviceGeneration;
  return typeof value === "string" && value.length > 0 ? (value as ServiceGeneration) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function executionGeneration(
  project: unknown,
  threadId: string,
): ServiceGeneration | undefined {
  const value = record(project);
  const state = record(value?.state);
  const thread = record(record(state?.threads)?.[threadId]);
  const core = thread?.executionCore ?? value?.core;
  return serviceGeneration(core);
}
