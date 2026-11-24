import { forwardRef, type ComponentProps } from "react";

import { cn } from "../../lib/utils.js";

const Textarea = forwardRef<
  HTMLTextAreaElement,
  ComponentProps<"textarea"> & { unstyled?: boolean; variant?: "default" | "bare"; mono?: boolean }
>(function Textarea(
  { className, unstyled = false, variant = "default", mono = false, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      data-variant={unstyled ? undefined : variant}
      className={
        unstyled
          ? className
          : cn(
              variant === "bare"
                ? "flex field-sizing-content min-h-[1.625em] max-h-[200px] w-full resize-none border-0 rounded-none bg-transparent p-0 text-ui-base leading-[1.625] shadow-none outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 forced-colors:focus-visible:outline forced-colors:focus-visible:outline-1"
                : "flex field-sizing-content min-h-16 w-full resize-none rounded-control border border-input-border bg-input px-2 py-2 text-ui-base text-foreground transition-colors outline-none placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 md:text-ui-base/relaxed",
              mono && "font-mono",
              className,
            )
      }
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
