import "./feedback.css";

export function Feedback({ error, message, id }: { error?: string; message?: string; id?: string }) {
  return error ? (
    <p id={id} role="alert" className="ui-feedback" data-tone="error">
      {error}
    </p>
  ) : message ? (
    <p id={id} role="status" className="ui-feedback">
      {message}
    </p>
  ) : null;
}
