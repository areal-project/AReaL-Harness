import { useEffect } from "react";
import { toast } from "./toast.js";
import { formatUiMessage, useI18n, type UiMessage } from "../../i18n/IntlProvider.js";
import "./feedback.css";

export function Feedback({ error, message, id }: { error?: string | UiMessage; message?: string | UiMessage; id?: string }) {
  const { t } = useI18n();
  const errorText = error ? formatUiMessage(t, error) : "";
  useEffect(() => { if (errorText) toast(errorText, "error"); }, [errorText]);
  return errorText ? (id ? <span id={id} className="sr-only">{errorText}</span> : null) : message ? (
    <p id={id} role="status" className="ui-feedback">
      {formatUiMessage(t, message)}
    </p>
  ) : null;
}
