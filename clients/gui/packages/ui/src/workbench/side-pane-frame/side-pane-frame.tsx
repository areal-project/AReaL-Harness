import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.js";
function Frame({ className, ...props }: ComponentProps<"section">) { return <section {...props} className={cn("side-panel workspace-side-panel", className)} />; }
function Header({ className, ...props }: ComponentProps<"div">) { return <div {...props} className={cn("panel-header", className)} />; }
function Layout({ className, ...props }: ComponentProps<"div">) { return <div {...props} className={cn("panel-resource-layout", className)} />; }
function Content({ className, fullHeight, ...props }: ComponentProps<"div"> & { fullHeight?: boolean }) { return <div {...props} className={cn("panel-content", fullHeight && "full-height", className)} />; }
function Auxiliary({ className, ...props }: ComponentProps<"aside">) { return <aside {...props} className={cn("panel-resource-tree", className)} />; }
function Retained({ visible, style, ...props }: ComponentProps<"div"> & { visible: boolean }) { return <div {...props} className="side-pane-retained-content" style={{ display: visible ? "flex" : "none", flex: 1, minHeight: 0, height: "100%", flexDirection: "column", ...style }} />; }
export const SidePaneFrame = Object.assign(Frame, { Header, Layout, Content, Auxiliary, Retained });
