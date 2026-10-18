// Copied from ZCode EmbeddedBrowserPaneParts (872ad960), Core state and labels adapted; telemetry and unsupported element picking omitted.
import { useRef, type FormEvent, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import {
  Bug,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  ExternalLink,
  Globe,
  LoaderIcon,
  MonitorSmartphone,
  SquareDashedMousePointer,
  RefreshCw,
  X,
  TriangleAlertIcon,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Input } from "@/components/ui/input.js";
interface BrowserState {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  isReady: boolean;
  currentUrl: string;
}
const isDefaultBrowserOpenableUrl = (url: string) => /^https?:/.test(url);
export function BrowserToolbar({
  addressValue,
  browserState,
  formatMessage,
  onAddressChange,
  onAddressFocus,
  onAddressBlur,
  onAddressEscape,
  onGoBack,
  onGoForward,
  onOpenExternal,
  onOpenDevTools,
  onReload,
  onToggleResponsiveMode,
  onSubmit,
  onToggleDetails,
  isResponsiveMode,
  annotationControl, annotationDisabled, annotating, onAnnotation,
}: {
  addressValue: string;
  browserState: BrowserState;
  formatMessage: (descriptor: { id: string }) => string;
  onAddressChange: (value: string) => void;
  onAddressFocus: () => void;
  onAddressBlur: () => void;
  onAddressEscape: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onOpenExternal: () => void;
  onOpenDevTools: () => void;
  onReload: () => void;
  onToggleResponsiveMode: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onToggleDetails?: () => void;
  isResponsiveMode: boolean;
  annotationControl: Ref<HTMLButtonElement>;
  annotationDisabled: boolean;
  annotating: boolean;
  onAnnotation: () => void;
}) {
  const selectOnPointerUp = useRef(false);
  return (
    <form onSubmit={onSubmit} className="panel-toolbar browser-toolbar">
      <div className="browser-navigation-controls">
        <BrowserIconButton
          icon={<ChevronLeft className="h-4 w-4" />}
          title={formatMessage({ id: "browser.back" })}
          disabled={!browserState.canGoBack}
          dataTestId={"browser-back-button"}
          onClick={onGoBack}
        />
        <BrowserIconButton
          icon={<ChevronRight className="h-4 w-4" />}
          title={formatMessage({ id: "browser.forward" })}
          disabled={!browserState.canGoForward}
          dataTestId={"browser-forward-button"}
          onClick={onGoForward}
        />
        <BrowserIconButton
          icon={browserState.isLoading ? <X className="size-4" /> : <RefreshCw className="size-4" />}
          title={formatMessage({ id: browserState.isLoading ? "browser.stop" : "browser.reload" })}
          disabled={!browserState.isReady}
          dataTestId={"browser-refresh-button"}
          onClick={onReload}
        />
      </div>
      <Button ref={annotationControl} type="button" size="sm" variant="ghost" className="browser-annotation-trigger"
        data-testid="browser-annotation-button" aria-label="批注" aria-pressed={annotating} disabled={annotationDisabled} onClick={onAnnotation}>
        <SquareDashedMousePointer className="size-4" /><span>批注</span>
      </Button>
      <Input
        type="text"
        value={addressValue}
        data-testid={"browser-address-input"}
        size="sm"
        className="browser-address"
        onChange={(event) => onAddressChange(event.target.value)}
        placeholder={formatMessage({ id: "browser.addressPlaceholder" })}
        aria-label="预览地址"
        onMouseDown={(event) => {
          selectOnPointerUp.current = event.currentTarget !== document.activeElement;
        }}
        onFocus={(event) => {
          // 先显示完整地址再选中，避免域名展开时把新输入追加到旧 URL。
          flushSync(onAddressFocus);
          event.currentTarget.select();
        }}
        onMouseUp={(event) => {
          if (!selectOnPointerUp.current) return;
          selectOnPointerUp.current = false;
          event.preventDefault();
          event.currentTarget.select();
        }}
        onBlur={() => { selectOnPointerUp.current = false; onAddressBlur(); }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onAddressEscape();
            event.currentTarget.blur();
          }
        }}
        spellCheck={false}
      />
      <BrowserIconButton
        icon={<MonitorSmartphone className="h-4 w-4" />}
        title={formatMessage({
          id: isResponsiveMode ? "browser.responsive.exit" : "browser.responsive.enter",
        })}
        disabled={false}
        dataTestId={"browser-responsive-button"}
        onClick={onToggleResponsiveMode}
        active={isResponsiveMode}
        pressed={isResponsiveMode}
      />
      <BrowserToolbarMoreMenu
        canOpenExternal={
          browserState.isReady && isDefaultBrowserOpenableUrl(browserState.currentUrl)
        }
        canOpenDevTools={browserState.isReady}
        formatMessage={formatMessage}
        onOpenExternal={onOpenExternal}
        onOpenDevTools={onOpenDevTools}
        onToggleDetails={onToggleDetails}
      />
    </form>
  );
}

function BrowserToolbarMoreMenu({
  canOpenDevTools,
  canOpenExternal,
  formatMessage,
  onOpenDevTools,
  onOpenExternal,
  onToggleDetails,
}: {
  canOpenDevTools: boolean;
  canOpenExternal: boolean;
  formatMessage: (descriptor: { id: string }) => string;
  onOpenDevTools: () => void;
  onOpenExternal: () => void;
  onToggleDetails?: () => void;
}) {
  const moreLabel = formatMessage({ id: "browser.more" });
  return (
    <DropdownMenu>
      <ControlHintTooltip title={moreLabel}>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon-md"
              variant="ghost"
              aria-label={moreLabel}
              data-testid={"browser-more-button"}
            >
              <Ellipsis className="size-4" />
            </Button>
          }
        />
      </ControlHintTooltip>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem
          data-testid={"browser-open-external-item"}
          disabled={!canOpenExternal}
          onClick={onOpenExternal}
        >
          <ExternalLink className="size-4" />
          <span>{formatMessage({ id: "browser.openExternal" })}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid={"browser-devtools-button"}
          disabled={!canOpenDevTools}
          onClick={onOpenDevTools}
        >
          <Bug className="size-4" />
          <span>{formatMessage({ id: "browser.devtools" })}</span>
        </DropdownMenuItem>
        {onToggleDetails && <DropdownMenuItem onClick={onToggleDetails}>
          <Globe className="size-4" />
          <span>{formatMessage({ id: "browser.details" })}</span>
        </DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BrowserEmptyState({
  browserState,
  formatMessage,
  isGuestStarting = !browserState.isReady,
}: {
  browserState: BrowserState;
  formatMessage: (descriptor: { id: string }) => string;
  isGuestStarting?: boolean;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6">
      <div className="flex max-w-sm flex-col pb-10 items-center text-center">
        {isGuestStarting ? (
          <LoaderIcon className="mb-6 size-16 animate-spin text-foreground opacity-30" />
        ) : (
          <Globe className="mb-6 size-16 text-foreground opacity-30" />
        )}
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({ id: "browser.title" })}
        </h3>
        <p className="mt-2 text-ui-base text-foreground-subtle">
          {formatMessage({ id: "browser.empty" })}
        </p>
      </div>
    </div>
  );
}

/**
 * 页面加载失败时的可读错误态。
 *
 * Electron 的 `<webview>` 不带 Chrome 的安全插页，被拒的导航只落到一张空的
 * chrome-error 页；过去 errorMessage 只写进 state 没有渲染消费者，空置态又同时被关掉，
 * 用户最终只看到纯黑。证书类失败额外给出放行指引，避免用户无从下手。
 */
export function BrowserLoadErrorState({
  errorMessage,
  formatMessage,
  isCertificateError,
  onRetry,
}: {
  errorMessage: string;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isCertificateError: boolean;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid={"browser-load-error"}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background px-6"
    >
      <div className="flex max-w-sm flex-col items-center pb-10 text-center">
        <TriangleAlertIcon className="mb-6 size-16 text-warning opacity-60" />
        <h3 className="text-ui-base font-medium text-foreground">
          {formatMessage({
            id: isCertificateError ? "browser.loadError.certTitle" : "browser.loadError.title",
          })}
        </h3>
        <p className="mt-2 font-mono text-ui-sm break-all text-foreground-subtlest">
          {errorMessage}
        </p>
        {isCertificateError ? (
          <p
            data-testid={"browser-load-error-cert-hint"}
            className="mt-3 text-ui-base text-foreground-subtle"
          >
            {formatMessage({ id: "browser.loadError.certHint" })}
          </p>
        ) : null}
        <Button type="button" variant="outline" className="mt-6" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {formatMessage({ id: "browser.loadError.retry" })}
        </Button>
      </div>
    </div>
  );
}

function BrowserIconButton({
  dataTestId,
  disabled,
  icon,
  onClick,
  title,
  active = false,
  pressed,
}: {
  dataTestId: string;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  pressed?: boolean;
}) {
  return (
    <ControlHintTooltip title={title}>
      <Button
        type="button"
        size="icon-md"
        variant={active ? "secondary" : "ghost"}
        aria-label={title}
        aria-pressed={pressed}
        data-testid={dataTestId}
        disabled={disabled}
        onClick={onClick}
      >
        {icon}
      </Button>
    </ControlHintTooltip>
  );
}
