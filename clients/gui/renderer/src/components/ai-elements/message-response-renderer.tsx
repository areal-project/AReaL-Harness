import { normalizeMessageSingleDollarMath } from "@areal/ui/math-text";
import "katex/contrib/mhchem";
import "katex/contrib/copy-tex";
import { MarkdownSurface } from "@areal/ui/experimental";
/*
 * Derived from ZCode 872ad960 components/ai-elements/message.tsx, in turn derived
 * from vercel/ai-elements. Copyright 2023 Vercel, Inc. Apache-2.0.
 * Adaptation: retain the Streamdown rendering kernel and original typography,
 * static/streaming separation and stable CodeViewer. Core supplies link actions;
 * no ZCode services, subscription, citations catalog or platform stores.
 * See ZCODE-LICENSE and ../../../THIRD-PARTY-NOTICES.md.
 */
import { memo, useMemo, useRef, type ComponentProps, type ReactNode } from "react";
import {
  defaultRehypePlugins,
  defaultRemarkPlugins,
  defaultUrlTransform,
  type ExtraProps,
} from "streamdown";
import { GlobeIcon } from "lucide-react";
import remarkBreaks from "remark-breaks";
import { useI18n } from "../../i18n/IntlProvider.js";
import { FileReference } from "../../interfaceIcons.js";
import { cjk } from "@streamdown/cjk";
import { createMathPlugin } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { cn } from "../lib/utils.js";
import { ControlHintTooltip } from "../../ControlHintTooltip.js";
import { decodeFilePathUriEscapes, joinFilePath } from "../../lib/path.js";
import { Button } from "../ui/button.js";
import { MessageCodeBlock } from "./message-code-block.js";
import { useCodePreferences } from "../../settings/preferences.js";
import { MarkdownBlockquote } from "./markdown-blockquote.js";
import { MarkdownListItem, MarkdownOrderedList, MarkdownUnorderedList } from "./markdown-list.js";
import {
  MarkdownTable,
  MarkdownTableBody,
  MarkdownTableCell,
  MarkdownTableHead,
  MarkdownTableHeader,
  MarkdownTableRow,
} from "./markdown-table.js";
import { STREAMDOWN_CONTROLS } from "./streamdown-controls.js";
import { parsePluginStableId } from "../../mentions/mentionMarkdown.js";
// Markdown file resources and agent replies often contain bare relative links and
// images; make their URL kind explicit before Streamdown's URL hardening, which
// otherwise renders them as "[blocked]". Resource readers and replies opt in.
function relativeFileLinks() {
  return (tree: { type?: string; url?: string; children?: any[] }) => {
    const visit = (node: typeof tree) => {
      if (
        (node.type === "link" || node.type === "image") &&
        node.url &&
        !/^(?:[a-z][a-z\d+.-]*:|[/.#])/i.test(node.url)
      )
        node.url = `./${node.url}`;
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
function pluginReferenceLabels() {
  return (tree: { type?: string; url?: string; value?: string; children?: any[] }) => {
    const visit = (node: typeof tree) => {
      if (node.type === "link" && node.url && parsePluginStableId(node.url)) {
        node.type = "text";
        node.value = node.children?.map((child) => child.value ?? "").join("") ?? "";
        delete node.url;
        delete node.children;
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
type WorkspaceLinkTree = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  children?: WorkspaceLinkTree[];
};
// Harden rewrites path-relative URLs to their pathname (`./a/b` becomes `/a/b`).
// Keep the authored path for file links and workspace images.
const workspacePathPattern = /^(?:\.\.?\/|\/(?!\/))/;
function preserveWorkspaceFilePaths() {
  return (tree: WorkspaceLinkTree) => {
    const visit = (node: WorkspaceLinkTree) => {
      const url =
        node.tagName === "a"
          ? node.properties?.href
          : node.tagName === "img"
            ? node.properties?.src
            : undefined;
      if (node.type === "element" && typeof url === "string" && workspacePathPattern.test(url))
        node.data = { ...node.data, workspaceFilePath: url };
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
function isImageContent(node: NonNullable<ExtraProps["node"]>["children"][number]): boolean {
  if (node.type === "text") return !node.value.trim();
  if (node.type !== "element") return false;
  if (node.tagName === "img") return true;
  return (
    ["strong", "em", "span"].includes(node.tagName) &&
    node.children.length > 0 &&
    node.children.every(isImageContent)
  );
}
const plugins = { cjk, math: createMathPlugin({ singleDollarTextMath: true }), mermaid };
export type MessageResponseProps = {
  children: string;
  fileLinks?: boolean;
  // 文档读取器以当前资源地址解析相对链接，再由 Streamdown 规范化路径。
  fileLinkBase?: string;
  fileReferenceRoot?: string;
  preserveLineBreaks?: boolean;
  streaming?: boolean;
  theme?: "light" | "dark";
  onOpenExternalUrl?: (url: string) => void;
  onOpenFileLink?: (path: string) => void;
  onRenderImage?: (uri: string, alt: string) => ReactNode;
  /** A paragraph holding only one file link may become a file card; null keeps the link. */
  onRenderFileCard?: (path: string, label: string) => ReactNode;
  webPreviews?: boolean;
  className?: string;
};
export const MessageResponse = memo(function MessageResponse({
  children,
  streaming = false,
  theme = "light",
  onOpenExternalUrl,
  onOpenFileLink,
  onRenderImage,
  onRenderFileCard,
  webPreviews = false,
  className,
  fileLinks = false,
  fileLinkBase,
  fileReferenceRoot,
  preserveLineBreaks = false,
}: MessageResponseProps) {
  const { fontSizePx } = useCodePreferences();
  // Snapshot refreshes can replace navigation callbacks. Keep Markdown component
  // types stable so a media read does not remount its own attachment on refresh.
  const callbacks = useRef({ onOpenExternalUrl, onOpenFileLink, onRenderImage, onRenderFileCard });
  callbacks.current = { onOpenExternalUrl, onOpenFileLink, onRenderImage, onRenderFileCard };
  // Preserve the host's authorized media references through sanitization.
  // The caller still validates the exact blob URI and reads it through Core.
  const rehypePlugins = useMemo(
    () =>
      onRenderImage || fileLinkBase || fileReferenceRoot
        ? Object.entries(defaultRehypePlugins).flatMap(
            ([name, plugin]): (typeof defaultRehypePlugins)[string][] => {
              const before =
                name === "harden" && (fileReferenceRoot || onRenderImage)
                  ? [preserveWorkspaceFilePaths]
                  : [];
              if (name === "harden" && fileLinkBase && Array.isArray(plugin))
                return [...before, [plugin[0], { ...plugin[1], defaultOrigin: fileLinkBase }]];
              if (name !== "sanitize" || !onRenderImage || !Array.isArray(plugin))
                return [...before, plugin];
              const schema = plugin[1] ?? {};
              return [
                ...before,
                [
                  plugin[0],
                  {
                    ...schema,
                    protocols: {
                      ...schema.protocols,
                      src: [...(schema.protocols?.src ?? []), "areal"],
                    },
                  },
                ],
              ];
            },
          )
        : undefined,
    [Boolean(onRenderImage), fileLinkBase, Boolean(fileReferenceRoot)],
  );
  const remarkPlugins = useMemo(
    () =>
      preserveLineBreaks
        ? [
            ...Object.values(defaultRemarkPlugins),
            pluginReferenceLabels,
            ...(fileLinks ? [relativeFileLinks] : []),
            remarkBreaks,
          ]
        : fileLinks
          ? [...Object.values(defaultRemarkPlugins), relativeFileLinks]
          : undefined,
    [fileLinks, preserveLineBreaks],
  );
  const components = useMemo(
    () => ({
      a: ({
        children,
        href,
        node,
      }: ComponentProps<"a"> & {
        node?: ExtraProps["node"];
      }) => {
        if (node?.children.length && node.children.every(isImageContent))
          return <span title={href}>{children}</span>;
        const data = node?.data;
        const originalPath =
          data && "workspaceFilePath" in data && typeof data.workspaceFilePath === "string"
            ? data.workspaceFilePath
            : undefined;
        const fileReference =
          !!href &&
          !href.startsWith("#") &&
          !/^[\w+.-]+:/.test(href) &&
          (!!callbacks.current.onOpenFileLink || !!fileReferenceRoot);
        const link = (
          <Button
            unstyled
            type="button"
            className={
              fileReference
                ? "markdown-file-reference"
                : "inline text-brand underline underline-offset-2"
            }
            title={fileReference ? undefined : href}
            onClick={() => {
              if (/^https?:\/\//i.test(href ?? "")) callbacks.current.onOpenExternalUrl?.(href!);
              else if (href && !/^[\w+.-]+:/.test(href))
                callbacks.current.onOpenFileLink?.(originalPath ?? href);
            }}
          >
            {fileReference && (
              <span className="markdown-file-reference-icon">
                <FileReference aria-hidden="true" />
              </span>
            )}
            <span>{children}</span>
          </Button>
        );
        if (!fileReference) return link;
        const path = decodeFilePathUriEscapes(
          originalPath ? originalPath.replace(/^\.\//, "") : href!,
        );
        return (
          <ControlHintTooltip
            title={fileReferenceRoot ? joinFilePath(fileReferenceRoot, path) : path}
          >
            {link}
          </ControlHintTooltip>
        );
      },
      img: function MarkdownImage({ src, alt, node }: ComponentProps<"img"> & ExtraProps) {
        const { t } = useI18n();
        const data = node?.data;
        const workspacePath =
          data && "workspaceFilePath" in data && typeof data.workspaceFilePath === "string"
            ? data.workspaceFilePath
            : undefined;
        return (
          callbacks.current.onRenderImage?.(
            workspacePath
              ? decodeFilePathUriEscapes(workspacePath)
              : typeof src === "string"
                ? src
                : "",
            alt ?? "",
          ) ?? (
            <span className="text-foreground-subtle">
              {t("content.imageFallback", { description: alt || t("content.imageInAttachments") })}
            </span>
          )
        );
      },
      p: function MarkdownParagraph({
        node,
        children,
        ...props
      }: ComponentProps<"p"> & ExtraProps) {
        const { t } = useI18n();
        const link =
          node?.children?.length === 1 &&
          node.children[0].type === "element" &&
          node.children[0].tagName === "a"
            ? node.children[0]
            : undefined;
        let localUrl: URL | undefined;
        try {
          const url = new URL(
            typeof link?.properties.href === "string" ? link.properties.href : "",
          );
          if (
            /^https?:$/.test(url.protocol) &&
            ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
          )
            localUrl = url;
        } catch {}
        const linkData = link?.data;
        const linkPath =
          linkData &&
          "workspaceFilePath" in linkData &&
          typeof linkData.workspaceFilePath === "string"
            ? linkData.workspaceFilePath
            : undefined;
        const fileCard =
          linkPath && callbacks.current.onRenderFileCard
            ? callbacks.current.onRenderFileCard(
                decodeFilePathUriEscapes(linkPath),
                link?.children
                  ?.map((child) => (child.type === "text" ? child.value : ""))
                  .join("") ?? "",
              )
            : null;
        if (fileCard) return <div className="my-2">{fileCard}</div>;
        if (webPreviews && localUrl && callbacks.current.onOpenExternalUrl) {
          const url = localUrl.href;
          const title =
            link?.children?.map((child) => (child.type === "text" ? child.value : "")).join("") ||
            t("content.webPreview");
          return (
            <div
              className="conversation-web-preview"
              role="group"
              aria-label={t("content.webPreview")}
            >
              <GlobeIcon size={24} aria-hidden="true" />
              <span className="conversation-web-preview-info">
                <strong>{title}</strong>
                <small>{url}</small>
              </span>
              <Button
                unstyled
                type="button"
                onClick={() => callbacks.current.onOpenExternalUrl?.(url)}
                aria-label={t("content.openWebPage", { title })}
              >
                {t("content.open")}
              </Button>
            </div>
          );
        }
        return node?.children?.some(
          (child) => child.type === "element" && child.tagName === "img",
        ) ? (
          <div className="conversation-inline-media">{children}</div>
        ) : (
          <p {...props}>{children}</p>
        );
      },
      h1: ({ node: _node, className, ...props }: ComponentProps<"h1"> & { node?: unknown }) => (
        <h1 className={cn("mt-6 mb-4 text-ui-xl font-semibold", className)} {...props} />
      ),
      h2: ({ node: _node, className, ...props }: ComponentProps<"h2"> & { node?: unknown }) => (
        <h2 className={cn("mt-6 mb-4 text-ui-lg font-semibold", className)} {...props} />
      ),
      h3: ({ node: _node, className, ...props }: ComponentProps<"h3"> & { node?: unknown }) => (
        <h3 className={cn("mt-6 mb-4 text-ui-base font-semibold", className)} {...props} />
      ),
      h4: ({ node: _node, className, ...props }: ComponentProps<"h4"> & { node?: unknown }) => (
        <h4 className={cn("mt-6 mb-4 text-ui-base font-semibold", className)} {...props} />
      ),
      h5: ({ node: _node, className, ...props }: ComponentProps<"h5"> & { node?: unknown }) => (
        <h5 className={cn("mt-6 mb-4 text-ui-base font-medium", className)} {...props} />
      ),
      h6: ({ node: _node, className, ...props }: ComponentProps<"h6"> & { node?: unknown }) => (
        <h6 className={cn("mt-6 mb-4 text-ui-base font-normal", className)} {...props} />
      ),
      strong: ({
        node: _node,
        className,
        ...props
      }: ComponentProps<"strong"> & {
        node?: unknown;
      }) => <strong className={cn("font-medium", className)} {...props} />,
      code: ({
        children,
        className: codeClassName,
        node: _node,
        ...props
      }: ComponentProps<"code"> & {
        node?: unknown;
      }) => {
        if (!("data-block" in props))
          return (
            <code
              className={cn(
                "rounded-md bg-markdown-inline-code/50 mx-0.5 px-1.5 py-0.5 font-mono text-ui-sm",
                codeClassName,
              )}
              {...props}
            >
              {children}
            </code>
          );
        const codeText = String(children ?? "").replace(/\n+$/, "");
        const language = /language-([^\s]+)/.exec(codeClassName ?? "")?.[1] ?? "text";
        return (
          <MessageCodeBlock
            code={codeText}
            language={language}
            streaming={streaming}
            theme={theme}
            fontSizePx={fontSizePx}
          />
        );
      },
      blockquote: MarkdownBlockquote,
      li: MarkdownListItem,
      ol: MarkdownOrderedList,
      ul: MarkdownUnorderedList,
      table: MarkdownTable,
      tbody: MarkdownTableBody,
      td: MarkdownTableCell,
      th: MarkdownTableHead,
      thead: MarkdownTableHeader,
      tr: MarkdownTableRow,
    }),
    [
      streaming,
      theme,
      Boolean(onOpenExternalUrl),
      Boolean(onOpenFileLink),
      Boolean(onRenderImage),
      Boolean(onRenderFileCard),
      webPreviews,
      fontSizePx,
      fileReferenceRoot,
    ],
  );
  return (
    <MarkdownSurface
      streaming={streaming}
      theme={theme}
      className={className}
      components={components}
      parseIncompleteMarkdown={streaming}
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      plugins={plugins}
      controls={STREAMDOWN_CONTROLS}
      linkSafety={{ enabled: false }}
      urlTransform={(url, key, node) =>
        onRenderImage && key === "src" && /^areal:\/\/blob\/[A-Za-z0-9_-]+$/.test(url)
          ? url
          : defaultUrlTransform(url, key, node)
      }
    >
      {normalizeMessageSingleDollarMath(children)}
    </MarkdownSurface>
  );
});
