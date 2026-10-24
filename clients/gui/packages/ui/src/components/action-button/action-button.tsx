import type { ComponentProps, ComponentType } from "react";
import { LoaderCircle, type LucideProps } from "lucide-react";
import { Button } from "../button/button.js";
import { cn } from "../../lib/utils.js";

type ActionButtonProps = Omit<ComponentProps<typeof Button>, "children"> & {
  icon?: ComponentType<LucideProps>;
  children: string;
  pending?: boolean;
};

/** Compact settings actions; icons are optional and labels stay readable while pending. */
export function ActionButton({ icon: Icon, children, pending = false, disabled, className, variant = "secondary", size = "sm", ...props }: ActionButtonProps) {
  return <Button {...props} variant={variant} size={size} disabled={disabled || pending}
    aria-busy={pending || undefined} className={cn("gap-1.5", className)}>
    {pending ? <LoaderCircle aria-hidden="true" strokeWidth={1.5} className="size-3 animate-spin motion-reduce:animate-none" />
      : Icon ? <Icon aria-hidden="true" strokeWidth={1.5} className="size-3" /> : null}
    {children}
  </Button>;
}
