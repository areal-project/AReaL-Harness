import { lazy, Suspense, type RefObject } from "react";
import { Dialog } from "./components/ui/dialog.js";
import type { DiagramSelection } from "./components/ai-elements/diagram-reader.js";
const DiagramReader = lazy(() =>
  import("./components/ai-elements/diagram-reader.js").then(({ DiagramReader }) => ({
    default: DiagramReader,
  })),
);
export function ConversationDiagramDialog({
  diagram,
  dark,
  container,
  onClose,
}: {
  diagram: DiagramSelection | null;
  dark: boolean;
  container: RefObject<HTMLDivElement | null>;
  onClose(): void;
}) {
  return (
    <Dialog
      open={!!diagram}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {!!diagram && (
        <Suspense fallback={null}>
          <DiagramReader
            code={diagram.code}
            theme={dark ? "dark" : "light"}
            returnFocus={() =>
              diagram.trigger.isConnected
                ? diagram.trigger
                : (container.current?.querySelectorAll<HTMLButtonElement>(
                    `[data-diagram-reader="${CSS.escape(diagram.scope)}"]`,
                  )[diagram.index] ??
                  container.current ??
                  false)
            }
          />
        </Suspense>
      )}
    </Dialog>
  );
}
