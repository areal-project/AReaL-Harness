import { cn } from "@/components/lib/utils.js";

// The welcome view is text only and does not imply a Core task was created.
export function ConversationDraftEmptyState({ projectName, className }: { projectName?: string; className?: string }) {
  return <div className={cn("draft-task-prompt", className)} data-testid="draft-task-prompt">
    <p>{projectName ? `你想让我们在 ${projectName} 中构建什么？` : "你想构建什么？"}</p>
  </div>;
}
