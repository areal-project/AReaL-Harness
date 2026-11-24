import { Terminal } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useI18n } from "./i18n/IntlProvider.js";

// The welcome view is text only and does not imply a Core task was created.
export function ConversationDraftEmptyState({
  projectName,
  className,
}: {
  projectName?: string;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <div className={cn("draft-task-prompt", className)} data-testid="draft-task-prompt">
      <div className="draft-task-mark" aria-hidden="true">
        <Terminal size={24} strokeWidth={1.6} />
      </div>
      <p>
        {projectName ? (
          <>
            {t("chat.draft.promptPrefix")} <span className="draft-task-project">{projectName}</span>{" "}
            {t("chat.draft.promptSuffix")}
          </>
        ) : (
          t("chat.draft.promptGeneric")
        )}
      </p>
    </div>
  );
}
