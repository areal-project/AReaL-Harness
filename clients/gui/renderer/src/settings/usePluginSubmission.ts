import { useRef, useState, type RefObject } from "react";
import type {
  ManagementResponseMap,
  PluginMutation,
} from "@areal/workbench/desktop-contract/management";
import type {
  PluginCommand,
  PluginMutationRequest,
  PluginOperation,
  PluginActivity,
  PluginReceipt,
} from "./pluginTypes.js";
import {
  UiMessageError,
  formatUiMessage,
  type UiMessage,
  type MessageId,
  type Translate,
} from "../i18n/IntlProvider.js";
export type PluginFailure = {
  message: string | UiMessage;
  context?: MessageId;
  code?: string | number;
  reason?: string;
  submissionUnknown?: boolean;
  requestId?: string;
  operation?: PluginOperation;
};
export function failure(cause: unknown): PluginFailure {
  if (cause instanceof UiMessageError) return { message: cause.descriptor };
  if (cause instanceof Error) return cause;
  return { message: { id: "settings.pluginCenter.pluginOperationFailed" } };
}
export function failureText(error: PluginFailure | null, t: Translate) {
  const text = error ? formatUiMessage(t, error.message) : "";
  if (!error) return "";
  return [
    error.submissionUnknown ? t("settings.pluginCenter.submissionResultUnconfirmed") : "",
    error.context ? t(error.context, { value0: text }) : text,
    error.code !== undefined ? t("settings.pluginCenter.errorCode", { value0: error.code }) : "",
    error.reason,
    error.requestId ? t("settings.pluginCenter.requestId", { value0: error.requestId }) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

type Result = ManagementResponseMap[PluginMutation | "pluginAuth"];
type Context = {
  projectId?: string;
  connected: boolean;
  disabled: boolean;
  api: PluginCommand;
  mounted: RefObject<boolean>;
  selectedRef: RefObject<string | null>;
  refresh: () => Promise<void>;
  readDetail: (id: string) => Promise<void>;
  onPreparing: (operation: PluginOperation) => void;
  onAccepted: (
    result: Result | undefined,
    operation: PluginOperation,
    recovered: boolean,
  ) => boolean;
};
export function usePluginSubmission() {
  const [error, setError] = useState<PluginFailure | null>(null);
  const [message, setMessage] = useState<UiMessage | string>("");
  const [submission, setSubmission] = useState<PluginOperation | null>(null);
  const [activity, setActivity] = useState<PluginActivity | null>(null);
  const active = useRef(false);
  const settleRead = async (context: Context) => {
    if (!context.mounted.current) return;
    await context.refresh();
    if (context.selectedRef.current) await context.readDetail(context.selectedRef.current);
    if (context.mounted.current) setActivity(null);
  };
  const mutate = async (values: PluginMutationRequest, context: Context) => {
    if (active.current || context.disabled || !context.connected || !context.projectId) return;
    active.current = true;
    const requestId = crypto.randomUUID();
    const original: PluginOperation = {
      mutation: values.operation,
      projectId: context.projectId,
      requestId,
      ...("id" in values ? { pluginId: values.id } : {}),
    };
    setActivity({ ...original, kind: "submit" });
    setError(null);
    setMessage("");
    context.onPreparing(original);
    try {
      const result = await context.api({ projectId: context.projectId, ...values, requestId });
      if (!context.mounted.current) return;
      context.onAccepted(result, original, false);
      window.dispatchEvent(new Event("areal-plugins-changed"));
      return result;
    } catch (cause) {
      if (context.mounted.current) {
        const error = failure(cause);
        const originalFailure = { ...original, requestId: error.requestId ?? requestId };
        if (error.submissionUnknown && values.operation !== "pluginAuth")
          setSubmission(originalFailure);
        setError({
          ...error,
          ...(values.operation === "pluginAuth" ? { submissionUnknown: false } : {}),
          ...(error.submissionUnknown ? { requestId: originalFailure.requestId } : {}),
          operation: originalFailure,
        });
      }
    } finally {
      await settleRead(context);
      active.current = false;
    }
  };
  const recover = async (original: PluginOperation, context: Context) => {
    if (original.mutation === "pluginAuth" || active.current || !context.connected) return;
    active.current = true;
    setActivity({ ...original, kind: "check" });
    setMessage("");
    try {
      const receipt: PluginReceipt = await context.api({
        operation: "pluginSubmission",
        mutation: original.mutation,
        projectId: original.projectId,
        requestId: original.requestId,
      });
      if (!context.mounted.current) return;
      if (!receipt.confirmed) {
        setSubmission(original);
        setError({
          message: {
            id:
              receipt.state === "accepted"
                ? "settings.pluginCenter.theOriginalSubmissionIsStillProcessingCheck"
                : "settings.pluginCenter.theOriginalSubmissionResultIsStillUnconfirmed",
          },
          submissionUnknown: true,
          requestId: original.requestId,
          operation: original,
        });
        return;
      }
      setSubmission(null);
      if (receipt.status === "failed" || receipt.error) {
        setError({
          message: receipt.error?.message ?? {
            id: "settings.pluginCenter.theOriginalPluginOperationIsConfirmedFailed",
          },
          code: receipt.error?.code,
          reason: receipt.error?.reason,
          requestId: original.requestId,
          operation: original,
        });
        return;
      }
      setError(null);
      if (!context.onAccepted(receipt.result, original, true)) return;
      setMessage(
        receipt.warning ?? {
          id: "settings.pluginCenter.theOriginalSubmissionIsConfirmedCompleteIt",
        },
      );
    } catch (cause) {
      if (context.mounted.current) {
        setSubmission(original);
        setError({
          ...failure(cause),
          context: "settings.pluginCenter.couldNotCheckTheOriginalSubmissionValue",
          submissionUnknown: true,
          requestId: original.requestId,
          operation: original,
        });
      }
    } finally {
      await settleRead(context);
      active.current = false;
    }
  };
  return {
    error,
    setError,
    message,
    setMessage,
    submission,
    setSubmission,
    activity,
    active,
    mutate,
    recover,
  };
}
