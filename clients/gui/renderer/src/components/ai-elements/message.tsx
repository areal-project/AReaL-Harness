import { Component, lazy, memo, Suspense, type ReactNode } from "react";
import { useI18n } from "../../i18n/IntlProvider.js";
import { cn } from "../lib/utils.js";
import type { MessageResponseProps } from "./message-response-renderer.js";

const MarkdownResponse = lazy(async () => {
  const { MessageResponse } = await import("./message-response-renderer.js");
  return { default: MessageResponse };
});

class MessageResponseBoundary extends Component<
  {
    children: ReactNode;
    text: string;
    className?: string;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? (
      <div className={cn("whitespace-pre-wrap break-words", this.props.className)}>
        {this.props.text}
      </div>
    ) : (
      this.props.children
    );
  }
}

export const MessageResponse = memo(function MessageResponse(props: MessageResponseProps) {
  const { t } = useI18n();
  return (
    <MessageResponseBoundary text={props.children} className={props.className}>
      <Suspense
        fallback={
          props.preserveLineBreaks ? (
            // 用户已提交的正文不等待 Markdown 代码块加载；沿用正文行高，避免占位额外撑高气泡。
            <div data-reading-pending className={props.className}>
              <p className="m-0 whitespace-pre-wrap break-words">{props.children}</p>
            </div>
          ) : (
            <p
              role="status"
              data-reading-pending
              className="p-3 text-ui-base text-foreground-subtle"
            >
              {t("common.loading")}
            </p>
          )
        }
      >
        <MarkdownResponse {...props} />
      </Suspense>
    </MessageResponseBoundary>
  );
});
