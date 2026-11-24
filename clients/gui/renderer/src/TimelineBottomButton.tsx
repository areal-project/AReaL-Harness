import { ActivityIcon } from "./ActivityIcon.js";
import { Button } from "./components/ui/button.js";

/** Explicit local reading navigation, shared independently of Core execution. */
export function TimelineBottomButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="inline-flex transition-opacity delay-150 duration-0 starting:opacity-0">
      <Button
        type="button"
        variant="floating"
        size="icon-lg"
        shape="pill"
        aria-label="滚动到底部"
        title="滚动到底部"
        onClick={onClick}
      >
        <ActivityIcon kind="down" size={20} className="size-5" />
      </Button>
    </div>
  );
}
