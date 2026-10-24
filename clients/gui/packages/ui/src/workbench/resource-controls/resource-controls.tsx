import { BookOpen, Plug, ChevronDown, Folder, Monitor } from "lucide-react";
import { Button } from "../../components/button/button.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "../../components/dropdown-menu/dropdown-menu.js";
export function ResourceScope({ value, onChange, hasProject, task = false, disabled = false, labels }: {
 value: string; onChange: (value: string) => void; hasProject: boolean; task?: boolean; disabled?: boolean; labels: { scope: string; user: string; project: string; task: string };
}) {
 return <DropdownMenu><DropdownMenuTrigger render={<Button variant="outline" className="resource-scope" aria-label={labels.scope} disabled={disabled}>{value === "user" ? <Monitor size={16} /> : <Folder size={16} />}<span>{value === "user" ? labels.user : value === "task" ? labels.task : labels.project}</span><ChevronDown size={14} /></Button>} />
 <DropdownMenuContent><DropdownMenuRadioGroup value={value} onValueChange={onChange}><DropdownMenuRadioItem value="user">{labels.user}</DropdownMenuRadioItem><DropdownMenuRadioItem value="project" disabled={!hasProject}>{labels.project}</DropdownMenuRadioItem>{task && <DropdownMenuRadioItem value="task">{labels.task}</DropdownMenuRadioItem>}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}
export function CatalogEmpty({ kind, title, description, addLabel, onAdd }: { kind: "mcp" | "skill"; title: string; description: string; addLabel: string; onAdd?: () => void }) {
 return <div className="resource-empty">{kind === "mcp" ? <Plug size={26} aria-hidden="true" /> : <BookOpen size={26} aria-hidden="true" />}<strong>{title}</strong><p>{description}</p>{onAdd && <Button variant="outline" onClick={onAdd}>{addLabel}</Button>}</div>;
}
