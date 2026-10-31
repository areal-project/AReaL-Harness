import { Textarea } from "@areal/ui";
import { MessageSquare, Trash2 } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./components/ui/popover.js";
import { DraftAttachment } from "./MessageAttachment.js";
import { SentAttachment } from "./MessageAttachment.js";
import { isComposerFile, type ComposerDraftAttachment } from "./ComposerAttachments.js";
import {
  attachBrowserAnnotation,
  browserAnnotation,
  type SentBrowserAnnotation,
} from "./browserAnnotations.js";
import type { Action, Data } from "./services.js";
import "./BrowserRegionAnnotation.css";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";

export function BrowserAnnotationAttachments({
  files,
  disabled,
  onChange,
}: {
  files: ComposerDraftAttachment[];
  disabled: boolean;
  onChange: (files: ComposerDraftAttachment[]) => void;
}) {
  const selected = files.filter(isComposerFile).filter((file) => browserAnnotation(file));
  if (!selected.length) return null;
  return (
    <div className="browser-annotation-attachments" data-testid="browser-annotation-attachments">
      <Popover>
        <PopoverTrigger
          render={<Button variant="ghost" size="sm" aria-label={`${selected.length} 条标注`} />}
        >
          <MessageSquare className="size-3.5" />
          <span>{selected.length} 条标注</span>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-96">
          <PopoverTitle>待发送的标注</PopoverTitle>
          {selected.map((file, index) => {
            const note = browserAnnotation(file)!;
            return (
              <section key={note.id} className="browser-annotation-attachment-card">
                <DraftAttachment
                  file={file}
                  onRemove={() => onChange(files.filter((item) => item !== file))}
                />
                <div className="browser-annotation-attachment-copy">
                  <strong>
                    {index + 1}. {note.label}
                  </strong>
                  <Textarea
                    unstyled
                    data-slot={undefined}
                    aria-label={`标注 ${index + 1} 内容`}
                    value={note.comment}
                    disabled={disabled}
                    maxLength={4000}
                    onChange={(event) => {
                      attachBrowserAnnotation(file, {
                        ...note,
                        comment: event.target.value,
                      });
                      onChange([...files]);
                    }}
                  />
                  <small title={note.url}>{note.url}</small>
                </div>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`删除标注 ${index + 1}`}
                  disabled={disabled}
                  onClick={() => onChange(files.filter((item) => item !== file))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </section>
            );
          })}
        </PopoverContent>
      </Popover>
      <span>截图和内容</span>
    </div>
  );
}

export function SentBrowserAnnotations({
  notes,
  attachments,
  projectId,
  threadId,
  action,
}: {
  notes: SentBrowserAnnotation[];
  attachments: Data[];
  projectId: string;
  threadId: string;
  action: Action;
}) {
  if (!notes.length) return null;
  return (
    <div className="sent-browser-annotations" data-testid="sent-browser-annotations">
      <Popover>
        <PopoverTrigger
          render={<Button variant="ghost" size="sm" aria-label={`已发送 ${notes.length} 条标注`} />}
        >
          <MessageSquare className="size-3.5" />
          <span>{notes.length} 条标注</span>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-96">
          <PopoverTitle>已发送的标注</PopoverTitle>
          {notes.map((note, index) => (
            <section key={`${note.id}:${index}`} className="browser-annotation-attachment-card">
              <SentAttachment
                part={{
                  ...attachments.find((part) => (part.url ?? part.uri) === note.imageUri),
                  name: `标注 ${index + 1} 截图`,
                }}
                projectId={projectId}
                threadId={threadId}
                action={action}
              />
              <div className="browser-annotation-attachment-copy">
                <strong>
                  {index + 1}. {note.label}
                </strong>
                <p>{note.comment}</p>
                <small title={note.url}>{note.url}</small>
                <SettingsDisclosure title="截图来源">
                  <p>{note.capturedAt}</p>
                  <pre>{note.evidence}</pre>
                </SettingsDisclosure>
              </div>
            </section>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}
