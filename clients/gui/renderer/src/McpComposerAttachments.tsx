import { Popover, PopoverContent, PopoverTrigger } from "@areal/ui";
import { AttachmentCard } from "@areal/ui/experimental";
import { useEffect, useState } from "react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import { FileText } from "lucide-react";
import { CloseIcon } from "./interfaceIcons.js";
import { readMcpDraft, removeMcpDraft } from "./mcp-app-draft.js";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";
export type McpDraftEntry = { id: string; block: ContentBlock };
export function useMcpDraft(key: string) {
  const [entries, setEntries] = useState<McpDraftEntry[]>(() => readMcpDraft(key));
  useEffect(() => {
    const refresh = (event?: Event) => {
      if (!event || (event as CustomEvent<string>).detail === key) setEntries(readMcpDraft(key));
    };
    refresh();
    window.addEventListener("areal-draft-change", refresh);
    return () => window.removeEventListener("areal-draft-change", refresh);
  }, [key]);
  return entries;
}
export function McpContentLabel({ block }: { block: ContentBlock }) {
  const title = block._meta?.["openai/title"];
  if (block.type === "image")
    return (
      <>
        <img
          alt={typeof title === "string" ? title : "应用图片"}
          src={`data:${block.mimeType};base64,${block.data}`}
          style={{ maxWidth: 96, maxHeight: 72 }}
        />
        <span>{typeof title === "string" ? title : "应用图片"}</span>
      </>
    );
  if (block.type === "text")
    return (
      <SettingsDisclosure title={typeof title === "string" ? title : "应用文本"}>
        <p style={{ whiteSpace: "pre-wrap" }}>{block.text}</p>
      </SettingsDisclosure>
    );
  if (block.type === "resource_link") return <span>{block.title ?? block.name}</span>;
  if (block.type === "resource")
    return <span>{typeof title === "string" ? title : block.resource.uri}</span>;
  return null;
}
export function McpComposerAttachments({
  draftKey,
  entries,
  disabled,
}: {
  draftKey: string;
  entries: McpDraftEntry[];
  disabled?: boolean;
}) {
  return entries.length ? (
    <div className="composer-attachments" aria-label="应用附件">
      {entries.map((entry) => {
        const { block } = entry;
        const title = block._meta?.["openai/title"];
        const name =
          typeof title === "string"
            ? title
            : block.type === "resource_link"
              ? (block.title ?? block.name)
              : block.type === "resource"
                ? block.resource.uri
                : block.type === "text"
                  ? block.text
                      .split(/\r?\n/)
                      .find((line) => line.trim())
                      ?.trim() || "应用文本"
                  : block.type === "image"
                    ? "应用图片"
                    : "MCP 应用附件";
        return (
          <AttachmentCard
            image={block.type === "image"}
            className="composer-mcp-card"
            key={entry.id}
          >
            <Popover>
              {block.type === "image" ? (
                <PopoverTrigger
                  render={<AttachmentCard.Open />}
                  disabled={disabled}
                  aria-label={`预览图片 ${name}`}
                >
                  <img alt={name} src={`data:${block.mimeType};base64,${block.data}`} />
                </PopoverTrigger>
              ) : (
                <>
                  <AttachmentCard.Icon>
                    <FileText size={22} />
                  </AttachmentCard.Icon>
                  <AttachmentCard.Text>
                    <span title={name}>{name}</span>
                    <PopoverTrigger disabled={disabled} aria-label={`查看应用附件 ${name}`}>
                      查看附件 ›
                    </PopoverTrigger>
                  </AttachmentCard.Text>
                </>
              )}
              <PopoverContent side="top" aria-label={`应用附件 ${name}`}>
                {block.type === "image" ? (
                  <img
                    alt={name}
                    src={`data:${block.mimeType};base64,${block.data}`}
                    className="w-full object-contain"
                  />
                ) : (
                  <McpContentLabel block={block} />
                )}
              </PopoverContent>
            </Popover>
            <AttachmentCard.Remove
              disabled={disabled}
              aria-label={`移除应用附件 ${name}`}
              onClick={() => removeMcpDraft(draftKey, entry.id)}
            >
              <CloseIcon size={12} />
            </AttachmentCard.Remove>
          </AttachmentCard>
        );
      })}
    </div>
  ) : null;
}
