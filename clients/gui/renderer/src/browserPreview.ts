export type PreviewFailure = {
  kind: "permission" | "unknown" | "operation";
  message: string;
};

export function previewFailure(error: unknown): PreviewFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return {
    kind:
      code === "BROWSER_PERMISSION_DENIED"
        ? "permission"
        : message === "outcome_unknown"
          ? "unknown"
          : "operation",
    message,
  };
}
