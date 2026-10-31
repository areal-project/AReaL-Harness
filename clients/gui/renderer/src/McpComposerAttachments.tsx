import { Button } from "@areal/ui";
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
      {entries.map((entry) => (
        <div className="composer-text-card composer-mcp-card" key={entry.id}>
          <span className="composer-text-icon">
            <FileText size={22} />
          </span>
          <div className="composer-text-copy">
            <McpContentLabel block={entry.block} />
            <small>MCP 应用附件</small>
          </div>
          <Button
            unstyled
            data-slot={undefined}
            type="button"
            className="composer-remove-attachment"
            disabled={disabled}
            aria-label="移除应用附件"
            onClick={() => removeMcpDraft(draftKey, entry.id)}
          >
            <CloseIcon size={12} />
          </Button>
        </div>
      ))}
    </div>
  ) : null;
}
