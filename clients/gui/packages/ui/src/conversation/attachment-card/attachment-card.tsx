import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
function Card({ image, className, ...props }: ComponentProps<"div"> & { image: boolean }) { return <div {...props} className={cn(image ? "composer-image-card" : "composer-text-card", className)} />; }
function Open({ className, ...props }: ComponentProps<"button">) { return <button type="button" {...props} className={cn("composer-image-open", className)} />; }
function Remove({ className, ...props }: ComponentProps<"button">) { return <button type="button" {...props} className={cn("composer-remove-attachment", className)} />; }
function Icon({ className, ...props }: ComponentProps<"span">) { return <span {...props} className={cn("composer-text-icon", className)} />; }
function Text({ className, ...props }: ComponentProps<"div">) { return <div {...props} className={cn("composer-text-copy", className)} />; }
function Error({ className, ...props }: ComponentProps<"p">) { return <p role="alert" {...props} className={cn("composer-attachment-error", className)} />; }
function WithNote({ className, ...props }: ComponentProps<"div">) { return <div {...props} className={cn("composer-image-attachment", className)} />; }
function Note({ className, ...props }: ComponentProps<"button">) { return <button type="button" {...props} className={cn("composer-image-note-count", className)} />; }
export const AttachmentCard = Object.assign(Card, { Open, Remove, Icon, Text, Error, WithNote, Note });
