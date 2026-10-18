/* oxlint-disable eslint(max-lines) -- 输入壳同时收口 Lexical 同步、拖拽和工具栏插槽，暂不拆组件。 */
// 输入展示壳：纯 props 组件、无 store/协议依赖；mention 面板通过 enableMentionPanel 透传。
import type {
  KeyboardEventHandler,
  DragEventHandler,
  FormEventHandler,
  MutableRefObject,
  ReactNode,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ComposerSurface, ComposerToolbar } from "./ComposerSurface.js";
const TID_CHAT_SEND_BUTTON = "chat-send-button";
import { AskPermissionIcon as Hand } from "../permissionIcons.js";
import { DismissIcon as XIcon } from "../interfaceIcons.js";
import { SendMessageIcon } from "@/interfaceIcons.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import {
  LexicalChatInput,
  type ChatComposerPasteEvent,
  type LexicalChatInputHandle,
} from "@/LexicalChatInput.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { AppSlashCommand } from "@/slashCommandHelpers.js";
import {
  hasWorkspaceFileDragPayload,
  readWorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { appendWorkspaceFileMentionToComposer } from "@/lib/workspaceFileComposer.js";
import { usePromptEditorDragState } from "@/prompt-editor/usePromptEditorDragState.js";
import { ChatPromptActionMenu } from "@/prompt-editor/ChatPromptActionMenu.js";
import { ComposerCatalogTrigger } from "./ComposerCatalogTrigger.js";
import type { ComposerCatalogData } from "./ComposerCatalog.js";
import { useComposerToolbarFit } from "@/prompt-editor/useComposerToolbarFit.js";

function runAfterFrame(callback: () => void) {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(callback);
    return;
  }
  callback();
}

export function ChatPromptEditor({
  workspacePath,
  workspaceIdentity,
  taskId,
  skillCatalogSessionId,
  initialValue,
  syncInitialValueOnMount = true,
  placeholder,
  disabled = false,
  disabledReason,
  submitting = false,
  submitDisabled = false,
  allowSubmitWhenEmpty = false,
  enterSubmits = true,
  submitLabel,
  cancelLabel,
  showMentionButton = false,
  showSlashButton = false,
  enableWorkspaceFileDrop = false,
  enableExternalFileDrop = false,
  isDraggingOver = false,
  dragAttachmentHint,
  topContent,
  leadingActions,
  attachmentAction,
  menuActions,
  composerCatalog,
  betweenCancelAndSubmitAction,
  submitControl,
  inputTestId,
  submitTestId,
  cancelTestId,
  inputApiRef,
  onModeSwitchContainerChange,
  triggerPanelContainer,
  promptHistory,
  className,
  shellClassName,
  compactPlaceholder = false,
  onChange,
  onSubmit,
  onModifiedSubmit,
  onCancel,
  onFocus,
  onWhiteboardMentionSelected,
  onPaste,
  onDragOver,
  onDragLeave,
  onDrop,
  excludedSlashCommandNames,
  appSlashCommands,
  enableMentionPanel,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  /** 仅供 Composer Skill catalog；可为草稿的 prewarm Session。 */
  skillCatalogSessionId?: string | null;
  initialValue?: string;
  syncInitialValueOnMount?: boolean;
  placeholder?: string;
  disabled?: boolean;
  disabledReason?: string;
  submitting?: boolean;
  submitDisabled?: boolean;
  allowSubmitWhenEmpty?: boolean;
  enterSubmits?: boolean;
  submitLabel: string;
  cancelLabel?: string;
  showMentionButton?: boolean;
  showSlashButton?: boolean;
  enableWorkspaceFileDrop?: boolean;
  enableExternalFileDrop?: boolean;
  isDraggingOver?: boolean;
  dragAttachmentHint?: string;
  topContent?: ReactNode;
  leadingActions?: ReactNode;
  attachmentAction?: {
    label: string;
    onSelect: () => void;
    testId?: string;
    menuItemTestId?: string;
  };
  composerCatalog?: ComposerCatalogData;
  menuActions?: readonly import("./ChatPromptActionMenu.js").ComposerMenuAction[];
  /** 行内编辑专用：固定插在取消与主提交之间的第二动作。 */
  betweenCancelAndSubmitAction?: ReactNode;
  submitControl?: ReactNode;
  inputTestId?: string;
  submitTestId?: string;
  cancelTestId?: string;
  inputApiRef?: MutableRefObject<LexicalChatInputHandle | null>;
  onModeSwitchContainerChange?: (container: HTMLSpanElement | null) => void;
  triggerPanelContainer?: HTMLElement | null;
  promptHistory?: readonly string[];
  className?: string;
  shellClassName?: string;
  compactPlaceholder?: boolean;
  onChange?: (value: string) => void;
  // 适配：返回 false 表示业务层拒绝/延迟本次提交，Lexical 不自行 reset（草稿保留）。
  onSubmit: (value: string) => boolean | void;
  onModifiedSubmit?: (value: string) => boolean | void;
  onCancel?: () => void;
  onFocus?: () => void;
  onWhiteboardMentionSelected?: (boardId: string) => void | Promise<void>;
  onPaste?: (event: ChatComposerPasteEvent) => void;
  onDragOver?: DragEventHandler<HTMLDivElement>;
  onDragLeave?: DragEventHandler<HTMLDivElement>;
  onDrop?: DragEventHandler<HTMLDivElement>;
  excludedSlashCommandNames?: readonly string[];
  /** App 层本地斜杠命令（透传 LexicalChatInput）。 */
  appSlashCommands?: readonly AppSlashCommand[];
  /** mention 面板开关（透传 LexicalChatInput）。 */
  enableMentionPanel?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const toolbarRef = useComposerToolbarFit();
  const internalInputApiRef = useRef<LexicalChatInputHandle | null>(null);
  const resolvedInputApiRef = inputApiRef ?? internalInputApiRef;
  const [internalTriggerPanelContainer, setInternalTriggerPanelContainer] =
    useState<HTMLDivElement | null>(null);
  const resolvedTriggerPanelContainer = triggerPanelContainer ?? internalTriggerPanelContainer;
  const latestTextRef = useRef(initialValue ?? "");
  const hasSyncedInitialValueRef = useRef(false);
  const userEditedSinceMount = useRef(false);
  const {
    externalFileDragging,
    internalDragging,
    setExternalFileDragging,
    setInternalDragging,
    setWorkspaceFileDragging,
    workspaceFileDragging,
  } = usePromptEditorDragState({
    enableExternalFileDrop,
    enableWorkspaceFileDrop,
  });
  const actionMenuTitle = intl.formatMessage({
    id: "chat.composer.actionMenu",
  });
  const workspaceFileDragHint = intl.formatMessage({
    id: "chat.composer.workspaceFileDragHint",
  });
  const hasActionMenu = Boolean(attachmentAction) || !!menuActions?.length || showMentionButton || showSlashButton;

  useEffect(() => {
    if (!syncInitialValueOnMount) {
      return;
    }
    if (initialValue === undefined) {
      return;
    }
    if (hasSyncedInitialValueRef.current) {
      return;
    }
    hasSyncedInitialValueRef.current = true;

    latestTextRef.current = initialValue;
    let disposed = false;
    runAfterFrame(() => {
      if (disposed || userEditedSinceMount.current) return;
      // task 草稿恢复时外层 input state 已经更新，但 Lexical 内部文本不会自动跟随 props。
      // 同时普通打字也会更新 input prop，必须先比较当前编辑器文本，避免每个字符都程序化重写编辑器。
      if (resolvedInputApiRef.current?.getMarkdown() === initialValue) {
        return;
      }
      resolvedInputApiRef.current?.setText(initialValue);
    });
    return () => {
      disposed = true;
    };
  }, [initialValue, resolvedInputApiRef, syncInitialValueOnMount]);

  const handleTextChange = useCallback(
    (value: string) => {
      latestTextRef.current = value;
      onChange?.(value);
    },
    [onChange],
  );

  const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      event.preventDefault();
      onSubmit(resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current);
    },
    [onSubmit, resolvedInputApiRef],
  );

  const handleKeyDown: KeyboardEventHandler<HTMLFormElement> = useCallback(
    (event) => {
      if (event.key !== "Escape" || !onCancel || submitting) {
        return;
      }

      // Portal 弹层初始焦点尚未转移时，Esc 仍可能发给编辑器。
      // 本 form 的已展开触发器优先关闭弹层，不能再取消编辑或停止任务。
      if (
        event.defaultPrevented ||
        event.currentTarget.querySelector('[aria-haspopup][aria-expanded="true"]') ||
        (event.target instanceof Element && event.target.closest('[role="dialog"]'))
      ) {
        return;
      }

      // 交互说明：用户消息 edit 是临时编辑态，Esc 应等价于点击取消，方便键盘流快速退出。
      event.preventDefault();
      onCancel();
    },
    [onCancel, submitting],
  );

  const handleEditorSubmit = useCallback(
    // 适配：透传业务层返回值（false = 不 reset 编辑器，草稿保留），
    // 吞掉返回值会让 Enter 路径总是清空。
    (value: string) => onSubmit(value),
    [onSubmit],
  );

  const handleDragOver: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const hasWorkspaceFilePayload =
        enableWorkspaceFileDrop && hasWorkspaceFileDragPayload(event.dataTransfer);
      if (hasWorkspaceFilePayload) {
        // 浏览器在 dragover 阶段通常只暴露 dataTransfer.types，不保证能读到 getData 内容。
        // 之前用完整 payload 判断，导致编辑输入框 drop 可用但 hover 状态不亮。
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setWorkspaceFileDragging(true);
        setInternalDragging(true);
        return;
      }
      if (enableExternalFileDrop && Array.from(event.dataTransfer.types).includes("Files")) {
        setExternalFileDragging(true);
      }

      onDragOver?.(event);
    },
    [enableExternalFileDrop, enableWorkspaceFileDrop, onDragOver],
  );

  const handleDragLeave: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
        return;
      }

      setInternalDragging(false);
      onDragLeave?.(event);
    },
    [onDragLeave],
  );

  const handleDrop: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      const workspaceFilePayload = enableWorkspaceFileDrop
        ? readWorkspaceFileDragPayload(event.dataTransfer)
        : null;
      if (workspaceFilePayload) {
        // file tree 拖拽不是系统文件，不能走附件分支；
        // 这里统一转换成和 @ 文件一致的 mention，避免 contenteditable 插入纯文本。
        event.preventDefault();
        // 用户消息编辑器嵌套在 ChatView drop target 内；消费后必须停止冒泡，
        // 否则同一条 mention 还会被底部主输入框再次接收。
        event.stopPropagation();
        setInternalDragging(false);
        setWorkspaceFileDragging(false);
        const currentMarkdown = resolvedInputApiRef.current?.getMarkdown() ?? latestTextRef.current;
        appendWorkspaceFileMentionToComposer({
          inputApiRef: resolvedInputApiRef,
          currentMarkdown,
          payload: workspaceFilePayload,
          workspacePath,
          workspaceIdentity,
          onTextChange: handleTextChange,
        });
        return;
      }

      setInternalDragging(false);
      setWorkspaceFileDragging(false);
      setExternalFileDragging(false);
      onDrop?.(event);
    },
    [
      enableWorkspaceFileDrop,
      handleTextChange,
      onDrop,
      resolvedInputApiRef,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // file tree 拖进编辑框时走的是 mention 插入，不是附件上传。
  // 这里单独使用 workspace file 文案，并从拖拽开始事件就点亮可投放状态，避免必须 over 到输入框才有反馈。
  const isWorkspaceFileDropActive = workspaceFileDragging || internalDragging;
  const isExternalFileDropActive = externalFileDragging || isDraggingOver;
  const draggingOverlayHint = isWorkspaceFileDropActive
    ? workspaceFileDragHint
    : isExternalFileDropActive
      ? dragAttachmentHint
      : undefined;

  return (
    <form
      onInputCapture={() => {
        userEditedSinceMount.current = true;
      }}
      onSubmit={handleSubmit}
      onKeyDown={handleKeyDown}
      className={cn("relative", className)}
    >
      {triggerPanelContainer ? null : (
        <div
          ref={setInternalTriggerPanelContainer}
          className="absolute inset-x-0 bottom-full z-20"
        />
      )}
      <ComposerSurface
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={shellClassName}
        dragging={isWorkspaceFileDropActive || isExternalFileDropActive}
        overlay={draggingOverlayHint ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-accent/55 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-full border border-border bg-accent px-4 py-2 text-ui-base text-foreground shadow-sm">
              <Hand className="size-4 text-foreground" />
              <span>{draggingOverlayHint}</span>
            </div>
          </div>
        ) : null}

        context={topContent}
        editor={<LexicalChatInput
          placeholder={placeholder}
          disabled={disabled}
          submitDisabled={submitDisabled}
          allowSubmitWhenEmpty={allowSubmitWhenEmpty}
          enterSubmits={enterSubmits}
          onSubmit={handleEditorSubmit}
          onModifiedSubmit={onModifiedSubmit}
          onChange={handleTextChange}
          onFocus={onFocus}
          triggerPanelContainer={resolvedTriggerPanelContainer}
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          taskId={taskId}
          skillCatalogSessionId={skillCatalogSessionId}
          inputTestId={inputTestId}
          editorApiRef={resolvedInputApiRef}
          promptHistory={promptHistory}
          compactPlaceholder={compactPlaceholder}
          onWhiteboardMentionSelected={onWhiteboardMentionSelected}
          onPaste={onPaste}
          excludedSlashCommandNames={excludedSlashCommandNames}
          appSlashCommands={appSlashCommands}
          composerCatalog={composerCatalog}
          enableMentionPanel={enableMentionPanel}
        />}
        toolbar={<ComposerToolbar ref={toolbarRef}
          leading={<>
              {composerCatalog ? <ComposerCatalogTrigger catalog={composerCatalog} anchor={resolvedTriggerPanelContainer} disabled={disabled} onClose={() => resolvedInputApiRef.current?.focus()} /> : hasActionMenu ? (
                <ChatPromptActionMenu
                  actionMenuTitle={actionMenuTitle}
                  excludedSlashCommandNames={excludedSlashCommandNames}
                  attachmentAction={attachmentAction}
                  actions={menuActions}
                  disabled={disabled}
                  disabledReason={disabledReason}
                  inputApiRef={resolvedInputApiRef}
                  workspacePath={workspacePath}
                  workspaceIdentity={workspaceIdentity}
                  sessionId={taskId}
                  container={resolvedTriggerPanelContainer}
                  showPlugins={enableMentionPanel !== false}
                />
              ) : null}
              {/* 权限/模式选择曾作为 leadingActions 先于动作菜单渲染，导致常驻顺序与产品规范相反。*/}
              {leadingActions}
              {onModeSwitchContainerChange ? (
                <span ref={onModeSwitchContainerChange} className="flex shrink-0 items-center" />
              ) : null}
          </>}
          trailing={<>
            {onCancel && cancelLabel ? (
              <ControlHintTooltip title={cancelLabel} shortcut="Esc">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-lg"
                  onClick={onCancel}
                  disabled={submitting}
                  data-testid={cancelTestId}
                  aria-label={cancelLabel}
                >
                  <XIcon className="size-4" />
                  <span className="sr-only">{cancelLabel}</span>
                </Button>
              </ControlHintTooltip>
            ) : null}
            {betweenCancelAndSubmitAction}
            {submitControl ?? (
              <ControlHintTooltip title={submitLabel} shortcut={enterSubmits ? "Enter" : "⌘/Ctrl+Enter"}>
                <Button
                  type="submit"
                  size="icon-md"
                  disabled={submitDisabled}
                  data-testid={submitTestId ?? TID_CHAT_SEND_BUTTON}
                  aria-label={submitLabel}
                  className="gap-1 bg-foreground text-ui-base text-background hover:bg-foreground/90 disabled:bg-secondary disabled:text-foreground-subtlest disabled:opacity-100"
                >
                  {submitting ? <Spinner className="size-4" /> : <SendMessageIcon className="size-5" />}
                  <span className="sr-only">{submitLabel}</span>
                </Button>
              </ControlHintTooltip>
            )}
          </>}
        />}
      />
    </form>
  );
}
