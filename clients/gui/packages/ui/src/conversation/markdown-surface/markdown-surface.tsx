import { Component, type ComponentProps, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { cn } from "../../lib/utils.js";
class MarkdownBoundary extends Component<{ children: ReactNode; text: string }, { failed: boolean }> {
 state = { failed: false };
 static getDerivedStateFromError() { return { failed: true }; }
 render() { return this.state.failed ? <div className="whitespace-pre-wrap break-words">{this.props.text}</div> : this.props.children; }
}
export function MarkdownSurface({ children, streaming = false, theme = "light", className, ...props }: Omit<ComponentProps<typeof Streamdown>, "children"> & { children: string; streaming?: boolean; theme?: "light" | "dark" }) {
 return <MarkdownBoundary key={streaming ? "streaming" : `static:${children.length}`} text={children}><Streamdown {...props} key={theme} className={cn("size-full text-ui-base leading-[1.75] tracking-wide [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)} mode={streaming ? "streaming" : "static"} parseIncompleteMarkdown={streaming} animated={false} isAnimating={streaming}>{children}</Streamdown></MarkdownBoundary>;
}
