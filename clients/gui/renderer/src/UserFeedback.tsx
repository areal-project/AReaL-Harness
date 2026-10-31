import { observeResize } from "@areal/ui/observe-resize";
import { useI18n } from "./i18n/IntlProvider.js";
import { Textarea } from "@areal/ui";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ThumbsDown, ThumbsUp, Sparkles, X, Send, Square } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { MessageResponse } from "./components/ai-elements/message.js";
import { ControlHintTooltip } from "./ControlHintTooltip.js";
import { useFeedbackAvailability } from "./user-feedback-status.js";
import type { Action, Data } from "./services.js";
import "./user-feedback.css";
import { SettingsDisclosure } from "./settings/SettingsDisclosure.js";

export function UserFeedback({
  project,
  thread,
  turn,
  item,
  action,
  dark,
}: {
  project: Data;
  thread: Data;
  turn: Data;
  item: Data;
  action: Action;
  dark: boolean;
}) {
  const { t } = useI18n();
  const connected =
    !!project.state?.connected && project.desktopCapabilities?.currentCommands !== false;
  const availability = useFeedbackAvailability(action, connected);
  const supported = connected && availability.supported;
  const anchor = useRef<HTMLSpanElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  const key = `areal-feedback:${JSON.stringify([project.id, thread.id, turn.id, item.id])}`;
  const [draft, setDraft] = useState<Data>();
  const [rating, setRating] = useState<"up" | "down">("up");
  const [reason, setReason] = useState(""),
    [analysis, setAnalysis] = useState(""),
    [followup, setFollowup] = useState("");
  const [open, setOpen] = useState(false),
    [visible, setVisible] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [position, setPosition] = useState({ left: 16, top: 16, maxHeight: 680 });
  const lastAnswer = useRef("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const accept = (value: Data) => {
    lastAnswer.current = value.analysisItemId ?? "";
    setDraft(value);
    setRating(value.rating);
    setReason(value.reason ?? "");
    setAnalysis(value.analysis ?? "");
  };
  useEffect(() => {
    if (!supported) return;
    const id = localStorage.getItem(key);
    if (!id) return;
    let live = true;
    void action("feedback", {
      operation: "read",
      projectId: project.id,
      threadId: thread.id,
      id,
    })
      .then((value) => {
        if (!live) return;
        accept(value);
        setOpen(!value.closed && value.state !== "submitted");
      })
      .catch(() => {
        /* 未连接时保留草稿身份，恢复后可重新打开。 */
      });
    return () => {
      live = false;
    };
  }, [key, action, project.id, thread.id, supported]);
  const side = draft?.sideThreadId ? project.state?.threads?.[draft.sideThreadId] : undefined;
  const active = side?.turns?.find((value: Data) => value.status === "inProgress");
  const answers = (side?.turns ?? []).flatMap((value: Data) =>
    (value.items ?? []).filter(
      (entry: Data) => entry.type === "agentMessage" && entry.phase !== "commentary",
    ),
  );
  const latest = answers.at(-1);
  useEffect(() => {
    if (!active && latest?.text && latest.id !== lastAnswer.current) {
      lastAnswer.current = latest.id;
      setAnalysis(latest.text);
    }
  }, [latest?.id, latest?.text, active]);
  useEffect(() => {
    if (!supported || !draft || draft.state === "submitted" || busy || draft.submissionUnknown)
      return;
    const timer = setTimeout(() => {
      void action("feedback", {
        operation: "draft",
        projectId: project.id,
        threadId: thread.id,
        id: draft.id,
        rating,
        reason,
        analysis,
        analysisItemId: lastAnswer.current,
      }).catch(() => {
        /* 显式提交仍会携带最新草稿；不将后台保存失败误报为已发布。 */
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [
    draft?.id,
    draft?.state,
    busy,
    rating,
    reason,
    analysis,
    action,
    project.id,
    thread.id,
    supported,
  ]);
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const trigger = anchor.current;
    const composer = document
      .querySelector('[data-testid="chat-input"]')
      ?.closest(".composer-dock");
    const place = () => {
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(380, window.innerWidth - 32);
      const composerTop = composer?.getBoundingClientRect().top;
      const bottom =
        composerTop && composerTop > 220
          ? Math.min(window.innerHeight - 16, composerTop - 12)
          : window.innerHeight - 16;
      const maxHeight = Math.min(680, Math.max(180, bottom - 16));
      const height = Math.min(panel.current?.getBoundingClientRect().height ?? 360, maxHeight);
      const left =
        rect.right + 16 + width <= window.innerWidth - 16
          ? rect.right + 16
          : Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
      setPosition({
        left,
        top: Math.max(16, Math.min(rect.top, bottom - height)),
        maxHeight,
      });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries[0].isIntersecting);
        if (entries[0].isIntersecting) place();
      },
      { threshold: 0.1 },
    );
    observer.observe(trigger);
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const stopResize = observeResize(
      [panel.current, composer].filter((element): element is Element => !!element),
      place,
    );
    reasonInput.current?.focus();
    return () => {
      observer.disconnect();
      stopResize();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const choose = async (value: "up" | "down") => {
    if (!supported || busy) return;
    if (draft?.submissionUnknown) {
      setOpen(true);
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (draft && draft.state !== "submitted" && !draft.closed) {
        setRating(value);
        setOpen(true);
        return;
      }
      const valueDraft = await action("feedback", {
        operation: "prepare",
        projectId: project.id,
        threadId: thread.id,
        turnId: turn.id,
        itemId: item.id,
        rating: value,
      });
      localStorage.setItem(key, valueDraft.id);
      if (mounted.current) {
        accept(valueDraft);
        setOpen(true);
      }
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const command = async (operation: "refine" | "submit") => {
    if (!supported || !draft || busy || active) return;
    setBusy(true);
    setError("");
    try {
      const value = await action("feedback", {
        operation,
        projectId: project.id,
        threadId: thread.id,
        id: draft.id,
        rating,
        reason,
        analysis,
        analysisItemId: lastAnswer.current,
        ...(operation === "refine" && draft.sideThreadId ? { text: followup } : {}),
      });
      if (mounted.current) {
        if (operation === "submit") accept(value);
        else setDraft(value);
        setFollowup("");
        if (operation === "submit") setOpen(false);
      }
    } catch (cause) {
      if (mounted.current) {
        setError((cause as Error).message);
        if ((cause as Data).submissionUnknown)
          setDraft((current: Data) => ({ ...current, submissionUnknown: true }));
      }
      if (operation === "refine") {
        try {
          const value = await action("feedback", {
            operation: "read",
            projectId: project.id,
            threadId: thread.id,
            id: draft.id,
          });
          if (mounted.current) setDraft(value);
        } catch {
          /* 保留原始失败，不重复发送润色首问。 */
        }
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const close = () => {
    setOpen(false);
    if (supported && draft)
      void action("feedback", {
        operation: "close",
        projectId: project.id,
        threadId: thread.id,
        id: draft.id,
      }).catch((cause: Error) => setError(cause.message));
    if (supported && !draft?.submissionUnknown) {
      localStorage.removeItem(key);
      setDraft(undefined);
    }
  };
  if (
    !supported ||
    !availability.enabled ||
    !availability.connected ||
    !availability.opted_in ||
    thread.conversation?.kind === "side"
  )
    return null;
  return (
    <span className="user-feedback-anchor" data-open={open} ref={anchor}>
      {(["up", "down"] as const).map((value) => (
        <ControlHintTooltip key={value} title={value === "up" ? "回答得好" : "回答不好"}>
          <Button
            unstyled
            data-slot={undefined}
            type="button"
            className="icon-button"
            aria-label={value === "up" ? "点赞" : "点踩"}
            aria-pressed={!!draft && rating === value}
            disabled={busy}
            onClick={() => void choose(value)}
          >
            {value === "up" ? <ThumbsUp size={14} /> : <ThumbsDown size={14} />}
          </Button>
        </ControlHintTooltip>
      ))}
      {!open && draft?.state === "submitted" && (
        <span className="sr-only" role="status">
          评价已提交
        </span>
      )}
      {!open && error && (
        <span className="feedback-inline-error" role="alert">
          {error}
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={panel}
            className="user-feedback-panel"
            hidden={!visible}
            style={position}
            role="dialog"
            aria-modal="false"
            aria-label={rating === "up" ? "点赞反馈" : "点踩反馈"}
          >
            <header>
              <span>
                {rating === "up" ? <ThumbsUp size={17} /> : <ThumbsDown size={17} />}
                <strong>{rating === "up" ? "哪里做得好？" : "哪里需要改进？"}</strong>
              </span>
              <Button
                unstyled
                data-slot={undefined}
                type="button"
                className="icon-button"
                aria-label="关闭评价"
                onClick={close}
              >
                <X size={16} />
              </Button>
            </header>
            <div className="user-feedback-body">
              <p className="user-feedback-description">{t("common.feedback.contextHelp")}</p>
              <label>
                你的理由
                <Textarea
                  unstyled
                  data-slot={undefined}
                  ref={reasonInput}
                  rows={3}
                  value={reason}
                  disabled={!!draft?.submissionUnknown || busy}
                  maxLength={10000}
                  placeholder={rating === "up" ? "哪些地方对你有帮助？" : "哪里不符合你的预期？"}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              {!draft?.sideThreadId && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !reason.trim() ||
                    busy ||
                    !!draft?.submissionUnknown ||
                    project.core?.features?.sidePreview !== true
                  }
                  onClick={() => void command("refine")}
                >
                  <Sparkles size={14} />
                  {draft?.refinementUnknown ? "恢复润色" : "Agent 润色"}
                </Button>
              )}
              {draft?.sideThreadId && (
                <section className="feedback-refinement" aria-label="评价润色讨论">
                  <div className="feedback-refinement-heading">
                    <Sparkles size={14} />
                    <span>一起完善评价</span>
                    {active && (
                      <Button
                        unstyled
                        data-slot={undefined}
                        type="submit"
                        className="icon-button"
                        aria-label="停止润色"
                        onClick={() =>
                          void action("stop", {
                            projectId: project.id,
                            threadId: draft.sideThreadId,
                            turnId: active.id,
                            requestId: crypto.randomUUID(),
                          }).catch((cause: Error) => setError(cause.message))
                        }
                      >
                        <Square size={12} />
                      </Button>
                    )}
                  </div>
                  {side?.turns?.length > 0 && (
                    <SettingsDisclosure className="feedback-discussion" title="查看润色讨论">
                      {side.turns.flatMap((value: Data, turnIndex: number) =>
                        (value.items ?? [])
                          .filter(
                            (entry: Data) =>
                              (turnIndex > 0 && entry.type === "userMessage") ||
                              (entry.type === "agentMessage" && entry.phase !== "commentary"),
                          )
                          .map((entry: Data) => (
                            <div key={entry.id}>
                              <strong>{entry.type === "userMessage" ? "你的意见" : "Agent"}</strong>
                              <MessageResponse
                                className="conversation-markdown"
                                theme={dark ? "dark" : "light"}
                              >
                                {entry.text ??
                                  entry.content
                                    ?.filter((part: Data) => part.type === "text")
                                    .map((part: Data) => part.text)
                                    .join("\n") ??
                                  ""}
                              </MessageResponse>
                            </div>
                          )),
                      )}
                    </SettingsDisclosure>
                  )}
                  {active && (
                    <div className="feedback-progress" role="status">
                      <span />
                      正在理解你的意见…
                    </div>
                  )}
                  {active && latest?.text && (
                    <MessageResponse
                      className="conversation-markdown"
                      theme={dark ? "dark" : "light"}
                    >
                      {latest.text}
                    </MessageResponse>
                  )}
                  {!active && side?.turns?.at(-1)?.error && (
                    <p role="alert">润色未完成，可修改意见后重试。</p>
                  )}
                  <label>
                    补充意见
                    <Textarea
                      unstyled
                      data-slot={undefined}
                      rows={2}
                      value={followup}
                      maxLength={4096}
                      disabled={active || busy || !!draft?.submissionUnknown}
                      placeholder="例如：强调重复尝试的问题，语气再客观一些"
                      onChange={(event) => setFollowup(event.target.value)}
                    />
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!followup.trim() || active || busy || !!draft?.submissionUnknown}
                    onClick={() => void command("refine")}
                  >
                    <Send size={13} />
                    继续调整
                  </Button>
                </section>
              )}
              {(analysis || draft?.sideThreadId) && (
                <label>
                  提交的分析
                  <Textarea
                    unstyled
                    data-slot={undefined}
                    rows={5}
                    value={analysis}
                    disabled={active || busy || !!draft?.submissionUnknown}
                    placeholder="润色完成后会出现在这里，你可以直接修改。"
                    maxLength={20000}
                    onChange={(event) => setAnalysis(event.target.value)}
                  />
                </label>
              )}
              {error && (
                <p className="text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer>
              <span>润色独立进行，主聊天可继续使用。</span>
              <Button
                size="sm"
                disabled={busy || active || !!draft?.refinementUnknown}
                onClick={() => void command("submit")}
              >
                {busy ? "处理中…" : draft?.submissionUnknown ? "重试原评价" : "提交评价"}
              </Button>
            </footer>
          </div>,
          document.body,
        )}
    </span>
  );
}
