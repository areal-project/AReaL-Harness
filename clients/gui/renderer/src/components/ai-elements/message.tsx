/*
 * Derived from ZCode 872ad960 components/ai-elements/message.tsx, in turn derived
 * from vercel/ai-elements. Copyright 2023 Vercel, Inc. Apache-2.0.
 * Adaptation: retain the Streamdown rendering kernel and original typography,
 * static/streaming separation and stable CodeViewer. Core supplies link actions;
 * no ZCode services, subscription, citations catalog or platform stores.
 * See ZCODE-LICENSE and ../../../THIRD-PARTY-NOTICES.md.
 */
import { Component, memo, useMemo, type ComponentProps, type ReactNode } from 'react';
import { Streamdown, defaultRemarkPlugins } from 'streamdown';
import remarkBreaks from 'remark-breaks';
import { FileReference } from '../../interfaceIcons.js';
import { cjk } from '@streamdown/cjk';
import { createMathPlugin } from '@streamdown/math';
import { mermaid } from '@streamdown/mermaid';
import { cn } from '../lib/utils.js';
import { MessageCodeBlock } from './message-code-block.js';
import { useCodePreferences } from '../../settings/preferences.js';
import { MarkdownBlockquote } from './markdown-blockquote.js';
import { MarkdownListItem, MarkdownOrderedList, MarkdownUnorderedList } from './markdown-list.js';
import { MarkdownTable, MarkdownTableBody, MarkdownTableCell, MarkdownTableHead, MarkdownTableHeader, MarkdownTableRow } from './markdown-table.js';
import { STREAMDOWN_CONTROLS } from './streamdown-controls.js';
// Markdown file resources often contain bare relative links; make their URL kind explicit
// before Streamdown's URL hardening. Only resource readers opt in.
function relativeFileLinks() {
    return (tree: { type?: string; url?: string; children?: any[] }) => {
        const visit = (node: typeof tree) => {
            if (node.type === 'link' && node.url && !/^(?:[a-z][a-z\d+.-]*:|[/.#])/i.test(node.url)) node.url = `./${node.url}`;
            node.children?.forEach(visit);
        };
        visit(tree);
    };
}
const plugins = { cjk, math: createMathPlugin(), mermaid };
class MarkdownBoundary extends Component<{
    children: ReactNode;
    text: string;
}, {
    failed: boolean;
}> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? <div className="whitespace-pre-wrap break-words">{this.props.text}</div> : this.props.children; }
}
export const MessageResponse = memo(function MessageResponse({ children, streaming = false, theme = 'light', onOpenExternalUrl, onOpenFileLink, className, fileLinks = false, preserveLineBreaks = false }: {
    children: string;
    fileLinks?: boolean;
    preserveLineBreaks?: boolean;
    streaming?: boolean;
    theme?: 'light' | 'dark';
    onOpenExternalUrl?: (url: string) => void;
    onOpenFileLink?: (path: string) => void;
    className?: string;
}) {
    const { fontSizePx } = useCodePreferences();
    const remarkPlugins = useMemo(() => preserveLineBreaks
        ? [...Object.values(defaultRemarkPlugins), ...(fileLinks ? [relativeFileLinks] : []), remarkBreaks]
        : fileLinks ? [relativeFileLinks] : undefined, [fileLinks, preserveLineBreaks]);
    const components = useMemo(() => ({
        a: ({ children, href, node: _node, ...props }: ComponentProps<'a'> & {
            node?: unknown;
        }) => <button type="button" className={href && !/^[\w+.-]+:/.test(href) && onOpenFileLink ? "markdown-file-reference" : "inline text-brand underline underline-offset-2"} title={href} onClick={() => { if (/^https?:\/\//i.test(href ?? ''))
            onOpenExternalUrl?.(href!);
        else if (href && !/^[\w+.-]+:/.test(href))
            onOpenFileLink?.(href); }}>{href && !/^[\w+.-]+:/.test(href) && onOpenFileLink && <span className="markdown-file-reference-icon"><FileReference aria-hidden="true" /></span>}<span>{children}</span></button>,
        img: ({ alt }: ComponentProps<'img'>) => <span className="text-foreground-subtle">[图片：{alt || '请在附件中查看'}]</span>,
        // Keep ZCode's compact heading scale instead of Streamdown's browser-sized headings.
        h1: ({ node: _node, className, ...props }: ComponentProps<'h1'> & { node?: unknown }) => <h1 className={cn('mt-6 mb-4 text-ui-xl font-semibold', className)} {...props} />,
        h2: ({ node: _node, className, ...props }: ComponentProps<'h2'> & { node?: unknown }) => <h2 className={cn('mt-6 mb-4 text-ui-lg font-semibold', className)} {...props} />,
        h3: ({ node: _node, className, ...props }: ComponentProps<'h3'> & { node?: unknown }) => <h3 className={cn('mt-6 mb-4 text-ui-base font-semibold', className)} {...props} />,
        h4: ({ node: _node, className, ...props }: ComponentProps<'h4'> & { node?: unknown }) => <h4 className={cn('mt-6 mb-4 text-ui-base font-semibold', className)} {...props} />,
        h5: ({ node: _node, className, ...props }: ComponentProps<'h5'> & { node?: unknown }) => <h5 className={cn('mt-6 mb-4 text-ui-base font-medium', className)} {...props} />,
        h6: ({ node: _node, className, ...props }: ComponentProps<'h6'> & { node?: unknown }) => <h6 className={cn('mt-6 mb-4 text-ui-base font-normal', className)} {...props} />,
        strong: ({ node: _node, className, ...props }: ComponentProps<'strong'> & {
            node?: unknown;
        }) => <strong className={cn('font-medium', className)} {...props}/>,
        code: ({ children, className: codeClassName, node: _node, ...props }: ComponentProps<'code'> & {
            node?: unknown;
        }) => {
            if (!('data-block' in props))
                return <code className={cn('rounded-md bg-markdown-inline-code/50 mx-0.5 px-1.5 py-0.5 font-mono text-ui-sm', codeClassName)} {...props}>{children}</code>;
            const codeText = String(children ?? '').replace(/\n+$/, '');
            const language = /language-([^\s]+)/.exec(codeClassName ?? '')?.[1] ?? 'text';
            return <MessageCodeBlock code={codeText} language={language} streaming={streaming} fontSizePx={fontSizePx} />;
        },
        blockquote: MarkdownBlockquote, li: MarkdownListItem, ol: MarkdownOrderedList, ul: MarkdownUnorderedList,
        table: MarkdownTable, tbody: MarkdownTableBody, td: MarkdownTableCell, th: MarkdownTableHead, thead: MarkdownTableHeader, tr: MarkdownTableRow,
    }), [streaming, theme, onOpenExternalUrl, onOpenFileLink, fontSizePx]);
    return <MarkdownBoundary key={streaming ? 'streaming' : `static:${children.length}`} text={children}><Streamdown key={theme} className={cn('size-full text-ui-base leading-[1.75] tracking-wide [&>*:first-child]:mt-0 [&>*:last-child]:mb-0', className)} mode={streaming ? 'streaming' : 'static'} components={components} parseIncompleteMarkdown={streaming} remarkPlugins={remarkPlugins} plugins={plugins} controls={STREAMDOWN_CONTROLS} linkSafety={{ enabled: false }} animated={false} isAnimating={false}>{children}</Streamdown></MarkdownBoundary>;
});
