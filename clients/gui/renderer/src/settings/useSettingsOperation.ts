import { UiMessageError, type UiMessage } from "../i18n/IntlProvider.js";
import { currentErrorText } from "../errors/currentErrorText.js";
import { useRef, useState } from "react";

/** UI admission only. The caller owns drafts and the backend owns save success. */
export function useSettingsOperation() {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | UiMessage>("");
  const [message, setMessage] = useState<string | UiMessage>("");
  const execute = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active.current)
      throw new UiMessageError({
        id: "settings.useSettingsOperation.anOperationIsInProgressPleaseWait",
      });
    active.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      return await task();
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  // Event handlers report locally; navigation saves use execute so failure blocks leaving.
  const run = async (task: () => Promise<unknown>) => {
    if (active.current) return;
    try {
      await execute(task);
    } catch (cause) {
      setError(
        cause instanceof UiMessageError
          ? cause.descriptor
          : cause instanceof Error
            ? currentErrorText(cause)
            : { id: "settings.useSettingsOperation.operationFailedTryAgain" },
      );
    }
  };
  return { busy, error, message, setError, setMessage, execute, run };
}
