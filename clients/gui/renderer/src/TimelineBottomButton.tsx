import { ActivityIcon } from "./ActivityIcon.js";
import { Button } from "./components/ui/button.js";

/** Explicit local reading navigation, shared independently of Core execution. */
export function TimelineBottomButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="timeline-bottom-button transition-opacity delay-150 duration-0 starting:opacity-0"
      aria-label="滚动到底部"
      title="滚动到底部"
      onClick={onClick}
    >
      <ActivityIcon kind="down" size={20} className="size-5" />
    </Button>
  );
}
