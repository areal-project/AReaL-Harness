import { cn } from "../../lib/utils.js";
import { LoaderIcon } from "lucide-react";
import { observeVisibleAnimation } from "../../lib/visible-animation.js";

function Spinner({
  className,
  label = "Loading",
  ...props
}: React.ComponentProps<"svg"> & { label?: string }) {
  return (
    <LoaderIcon
      ref={observeVisibleAnimation}
      role="status"
      aria-label={label}
      className={cn("size-4 areal-visible-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
