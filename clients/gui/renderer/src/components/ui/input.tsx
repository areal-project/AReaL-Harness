import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.js";

const inputVariants = cva(
  "w-full min-w-0 border border-input-border bg-input text-foreground ui-control transition-colors outline-none file:inline-flex file:border-0 file:bg-transparent file:font-medium file:text-foreground placeholder:text-foreground-subtlest hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
  {
    variants: {
      size: {
        xs: "h-control-xs rounded-sm px-2 py-0.5 text-ui-base file:h-4 file:text-ui-base",
        sm: "h-control-sm rounded-control px-2 py-0.5 text-ui-base/relaxed file:h-control-xs file:text-ui-base/relaxed",
        default:
          "h-control rounded-control px-2 py-0.5 text-ui-base md:text-ui-base/relaxed file:h-control-sm file:text-ui-base/relaxed",
        lg: "h-control-lg rounded-overlay px-3 py-1.5 text-ui-base file:h-control-sm file:text-ui-base",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

type InputVariantProps = VariantProps<typeof inputVariants>;

interface InputProps extends Omit<React.ComponentProps<"input">, "size">, InputVariantProps {
  htmlSize?: number;
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, htmlSize, size = "default", type, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      type={type}
      size={htmlSize}
      data-slot="input"
      className={cn(inputVariants({ size }), className)}
      {...props}
    />
  );
});

export { Input, inputVariants, type InputProps };
