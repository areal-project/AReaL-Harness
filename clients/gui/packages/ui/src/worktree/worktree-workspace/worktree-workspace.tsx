import type { ReactNode } from "react";
export function WorktreeWorkspace({ heading, directory, actions, busy, busyLabel, error, output, outputLabel }: {
  heading: string; directory: string; actions?: ReactNode; busy?: boolean; busyLabel: string; error?: string; output?: string; outputLabel: string;
}) {
  return <div className="worktree-workspace-details"><p className="text-ui-sm font-medium">{heading}</p><code className="break-all text-ui-caption text-foreground-subtle">{directory}</code>
    {actions}{busy && <p role="status" className="text-ui-caption">{busyLabel}</p>}{error && <p className="text-ui-caption text-destructive break-words">{error}</p>}
    {output && <pre aria-label={outputLabel} className="worktree-workspace-log">{output}</pre>}
  </div>;
}
