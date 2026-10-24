import { useId, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Folder, LoaderCircle, Trash2 } from "lucide-react";
import { Button } from "../../components/button/button.js";

function Directory({ children }: { children: ReactNode }) { return <div className="worktrees-directory-list">{children}</div>; }
function Group({ title, children }: { title: ReactNode; children: ReactNode }) {
  return <div className="worktrees-directory-project"><div className="worktrees-directory-project-heading"><Folder aria-hidden="true" /><span>{title}</span></div>{children}</div>;
}
function Item({ name, open, onToggle, onDelete, disabled, deleting, error, labels, children }: {
  name: string; open: boolean; onToggle: () => void; onDelete: () => void; disabled?: boolean; deleting?: boolean; error?: string;
  labels: { details: string; delete: string; deleting: string; result: string }; children: ReactNode;
}) {
  const id = useId();
  return <div className="worktrees-directory-item"><div className="worktrees-directory-row">
    <Button variant="ghost" className="worktrees-directory-toggle" aria-label={`${labels.details} ${name}`} aria-expanded={open} aria-controls={id} onClick={onToggle}>{open ? <ChevronDown /> : <ChevronRight />}<span>{name}</span></Button>
    <Button variant="ghost" size="icon" className="worktrees-directory-delete" disabled={disabled || deleting} aria-label={`${labels.delete} ${name}`} title={`${labels.delete} ${name}`} onClick={onDelete}>{deleting ? <LoaderCircle className="animate-spin" /> : <Trash2 />}</Button>
  </div>{deleting && <p role="status" className="worktrees-directory-feedback">{labels.deleting}</p>}
    {open && <dl id={id} className="worktrees-directory-details">{children}{error && <div><dt>{labels.result}</dt><dd className="worktrees-error">{error}</dd></div>}</dl>}
  </div>;
}
export const WorktreeDirectory = Object.assign(Directory, { Group, Item });
