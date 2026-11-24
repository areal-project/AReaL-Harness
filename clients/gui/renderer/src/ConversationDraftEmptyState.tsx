import { Terminal } from "lucide-react";
import { cn } from "@/components/lib/utils.js";

// The welcome view is text only and does not imply a Core task was created.
export function ConversationDraftEmptyState({
  projectName,
  className,
}: {
  projectName?: string;
  className?: string;
}) {
  return (
    <div className={cn("draft-task-prompt", className)} data-testid="draft-task-prompt">
      <div className="draft-task-mark" aria-hidden="true">
        <Terminal size={24} strokeWidth={1.6} />
      </div>
      <p>
        {projectName ? (
          <>
            你想让我们在 <span className="draft-task-project">{projectName}</span> 中构建什么？
          </>
        ) : (
          "你想构建什么？"
        )}
      </p>
    </div>
  );
}
