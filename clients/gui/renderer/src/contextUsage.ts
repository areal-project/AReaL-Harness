export { modelUsage, generationStats } from "./services.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ContextPartKind,
  ContextUsageResponse,
  GenerationStats,
} from "../../packages/runtime-client/core.js";
import type { Action, Data } from "./services.js";

export const contextLabels: Record<ContextPartKind, string> = {
  systemPrompt: "System prompt",
  rules: "项目与用户规则",
  skills: "Skills",
  toolDefinitions: "工具定义",
  conversation: "对话",
  summary: "压缩摘要",
  attachments: "引用文件与附件",
  toolResults: "工具返回内容",
  other: "其他",
};
export function useContextUsage(
  project: Data,
  thread: Data | undefined,
  action: Action,
  enabled = true,
) {
  const [result, setResult] = useState<ContextUsageResponse | null>(null),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const acceptedVersion = useRef<string | null>(null);
  const sequence = useRef(0),
    inFlight = useRef<{ version: string; request: number } | null>(null);
  const last = thread?.turns?.at(-1),
    config = project.configurations?.[thread?.id ?? ""] ?? thread?.desktop?.configuration;
  const active = last?.status === "inProgress";
  const selectedModel = project.models?.find((model: Data) =>
    config?.model
      ? model.providerId === config.model.providerId && model.modelId === config.model.modelId
      : !model.providerId,
  );
  const modelCapacity = selectedModel && [
    selectedModel.providerRevision,
    selectedModel.contextWindowTokens,
    selectedModel.effectiveContextWindowTokens,
    selectedModel.reportedWindowTokens,
    selectedModel.reportedWindowSource,
    selectedModel.userBudgetTokens,
    selectedModel.windowSource,
  ];
  const version = JSON.stringify([
    project.id,
    project.state?.connected,
    project.core?.instanceId,
    thread?.id,
    config?.revision,
    config?.model,
    config?.resolvedParameters,
    modelCapacity,
    thread?.updatedAt,
    last?.id,
    last?.status,
    last?.items?.length,
    thread?.contextCheckpoint?.compactions,
    thread?.toolsetRevision,
    project.core?.connectionGeneration,
  ]);
  const current = useRef(version);
  current.current = version;
  const read = useCallback(async () => {
    if (!thread?.id || !project.state?.connected) return;
    const requestedVersion = current.current;
    if (inFlight.current?.version === requestedVersion) return;
    const request = ++sequence.current;
    inFlight.current = { version: requestedVersion, request };
    setBusy(true);
    setError("");
    try {
      const value = await action("manage", {
        projectId: project.id,
        threadId: thread.id,
        operation: "context",
        offset: 0,
        limit: 1,
      });
      if (
        request !== sequence.current ||
        requestedVersion !== current.current ||
        value.threadId !== thread.id
      )
        return;
      if (
        !active &&
        typeof config?.revision === "number" &&
        value.contextUsage.basis.configurationRevision !== config.revision
      )
        return;
      acceptedVersion.current = requestedVersion;
      setResult(value);
    } catch (cause) {
      if (request === sequence.current && requestedVersion === current.current)
        setError(cause instanceof Error ? cause.message : "读取上下文失败");
    } finally {
      if (inFlight.current?.request === request) inFlight.current = null;
      if (request === sequence.current) setBusy(false);
    }
  }, [action, project.id, project.state?.connected, thread?.id, active, config?.revision]);
  useEffect(() => {
    sequence.current++;
    inFlight.current = null;
    setBusy(false);
    setResult(null);
    setError("");
    if (!enabled) return;
    void read();
    const timer = active
      ? window.setInterval(() => {
          void read();
        }, 1500)
      : undefined;
    return () => {
      sequence.current++;
      window.clearInterval(timer);
    };
  }, [read, version, enabled, active]);
  return { result: acceptedVersion.current === version ? result : null, error, busy, read };
}

export const tokenCount = (value: number) =>
  new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
export const generationRate = (value: GenerationStats | null | undefined) =>
  value && value.measuredRequests > 0 && value.durationMs > 0
    ? (value.outputTokens * 1000) / value.durationMs
    : null;
