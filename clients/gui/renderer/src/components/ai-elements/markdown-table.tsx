import { useMemo } from "react";
import type { ExtraProps } from "streamdown";
import { MarkdownTable as View, type MarkdownTableProps } from "@areal/ui/experimental";
import { useZCodeIntl } from "../../i18n/IntlProvider.js";
import { toast } from "../ui/toast.js";
export {
  buildMarkdownTableText,
  buildCsvTableText,
  resolveMarkdownTableStickyScrollbarMode,
  resolveMarkdownTableStickyScrollbarOffset,
  resolveMarkdownTableFrameDistances,
  resolveMarkdownTableVirtualScrollbarMetrics,
  resolveMarkdownTableVirtualScrollMax,
  MarkdownTableHeader,
  MarkdownTableBody,
  MarkdownTableRow,
  MarkdownTableHead,
  MarkdownTableCell,
} from "@areal/ui/experimental";
export type {
  MarkdownTableRows,
  MarkdownTableLabels,
  MarkdownTableProps,
  MarkdownTableHeaderProps,
  MarkdownTableBodyProps,
  MarkdownTableRowProps,
  MarkdownTableHeadProps,
  MarkdownTableCellProps,
} from "@areal/ui/experimental";
export function MarkdownTable({ node, ...props }: MarkdownTableProps) {
  const { intl } = useZCodeIntl();
  const labels = useMemo(
    () => ({
      copyFailed: (error: string) =>
        intl.formatMessage({ id: "markdownTable.copyFailed" }, { error }),
      copySucceeded: intl.formatMessage({ id: "markdownTable.copySucceeded" }),
      downloadFailed: intl.formatMessage({ id: "markdownTable.downloadFailed" }),
      copyMarkdown: intl.formatMessage({ id: "markdownTable.copyMarkdown" }),
      downloadCsv: intl.formatMessage({ id: "markdownTable.downloadCsv" }),
      openPreview: intl.formatMessage({ id: "markdownTable.openPreview" }),
      collapseScrollMode: intl.formatMessage({ id: "markdownTable.collapseScrollMode" }),
      expandScrollMode: intl.formatMessage({ id: "markdownTable.expandScrollMode" }),
      previewTitle: intl.formatMessage({ id: "markdownTable.previewTitle" }),
      previewDescription: intl.formatMessage({ id: "markdownTable.previewDescription" }),
      closeDialog: intl.formatMessage({ id: "common.closeDialog" }),
      scrollHint: intl.formatMessage({ id: "markdownTable.scrollHint" }),
    }),
    [intl],
  );
  const data = (node as ExtraProps["node"])?.data;
  const source = data && "tableMarkdown" in data ? data.tableMarkdown : undefined;
  return (
    <View
      labels={labels}
      onNotify={toast}
      sourceMarkdown={typeof source === "string" ? source : undefined}
      {...props}
    />
  );
}
