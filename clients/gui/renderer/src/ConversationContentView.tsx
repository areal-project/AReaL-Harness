import { useI18n } from "./i18n/IntlProvider.js";
import type { ReactNode } from "react";
import { NativeContent } from "@areal/ui/wip";
import type { ConversationContentBlock } from "./conversationContent.js";

export function ConversationContentView({ blocks, markdown, interactive }: {
  blocks: readonly ConversationContentBlock[];
  markdown: (text: string, offset: number) => ReactNode;
  interactive: (block: Extract<ConversationContentBlock, { kind: "interactive" }>) => ReactNode;
}) {
  const { t } = useI18n();
  return <>{blocks.map(block => <div key={`${block.kind}:${block.offset}`} className="conversation-content-block" data-content-kind={block.kind}>
    {block.kind === "markdown" ? markdown(block.raw, block.offset)
      : block.kind === "native" ? <NativeContent value={block.data} copyLabel={t("content.copy")} copiedLabel={t("content.copied")} failedLabel={t("content.copyFailed")} dataLabel={t("content.data")} />
      : block.kind === "interactive" ? interactive(block)
      : block.kind === "pending" ? <p role="status" className="conversation-content-pending">{t("content.preparing")}</p>
      : <details className="conversation-content-fallback"><summary>{t("content.fallback")}</summary><pre>{block.raw}</pre></details>}
  </div>)}</>;
}
