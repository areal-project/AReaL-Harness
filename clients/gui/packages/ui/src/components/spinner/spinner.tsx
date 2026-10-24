import { cn } from "../../lib/utils.js";
import { LoaderIcon } from "lucide-react";

function Spinner({ className, label = "Loading", ...props }: React.ComponentProps<"svg"> & { label?: string }) {
  return (
    <LoaderIcon
      role="status"
      aria-label={label}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
