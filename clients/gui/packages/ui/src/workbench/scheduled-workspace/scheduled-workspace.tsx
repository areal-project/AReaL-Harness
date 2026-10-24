import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.js";
function Root({ className, ...props }: ComponentProps<"div">) { return <div {...props} className={cn("scheduled-workspace", className)} />; }
function Group({ label, children }: { label: string; children: ReactNode }) { return <section role="group" aria-label={label} className="scheduled-group"><h2>{label}</h2>{children}</section>; }
function Item({ title, description, className, ...props }: Omit<ComponentProps<"button">, "title"> & { title: string; description: string }) { return <button type="button" {...props} className={cn("scheduled-item", className)} title={`${title} · ${description}`}><span>{title}</span><small>{description}</small></button>; }
function Welcome({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) { return <main className="scheduled-welcome"><div className="scheduled-intro"><span>{icon}</span><h2>{title}</h2><p>{description}</p></div><div className="scheduled-templates">{children}</div></main>; }
function Template({ icon, title, description, ...props }: Omit<ComponentProps<"button">, "title"> & { icon: ReactNode; title: string; description: string }) { return <button type="button" {...props} className="scheduled-template"><span>{icon}</span><span><strong>{title}</strong><small>{description}</small></span></button>; }
export const ScheduledWorkspace = Object.assign(Root, { Group, Item, Welcome, Template });
