import { useI18n } from "./i18n/IntlProvider.js";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MessageCircleQuestion, Pencil, X } from "lucide-react";
import { QuestionCard } from "@areal/ui/wip";
import { Feedback } from "./components/ui/feedback.js";
import { useApplicationPreferences } from "./settings/applicationPreferences.js";
import { Button } from "./components/ui/button.js";
import { Textarea } from "./components/ui/textarea.js";
import type { Action, Data } from "./services.js";
import "./AskUserQuestion.css";

type Draft = { mode: "option" | "custom"; option: string; text: string };
const empty: Draft = { mode: "option", option: "", text: "" };
const answer = (draft?: Draft) =>
  draft?.mode === "custom" ? draft.text.trim() : (draft?.option ?? "");

/** Core owns completion. Selection edits the draft; only explicit submit sends it. */
export function AskUserQuestion({
  item,
  projectId,
  action,
}: {
  item: Data;
  projectId: string;
  action: Action;
}) {
  const { t } = useI18n();
  const prefs = useApplicationPreferences();
  const [collapsed, setCollapsed] = useState(false);
  const questions = item.questions as Data[];
  const [index, setIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const inFlight = useRef(false);
  const title = useRef<HTMLHeadingElement>(null);
  const question = questions[index];
  useEffect(() => {
    if (!collapsed) title.current?.focus({ preventScroll: true });
  }, [index, collapsed]);
  if (!question) return null;
  const options: string[] = question.options ?? [];
  const draft = drafts[question.id] ?? {
    ...empty,
    mode: options.length ? "option" : "custom",
  };
  const custom = !options.length || draft.mode === "custom";
  const complete = questions.every((q) => !!answer(drafts[q.id]));
  const answered = questions.filter((q) => !!answer(drafts[q.id])).length;
  const locked = busy || submitted || unknown;
  const single = questions.length === 1;
  const update = (values: Partial<Draft>) => {
    setDrafts((old) => ({ ...old, [question.id]: { ...draft, ...values } }));
    setError("");
  };
  const submit = async (answers = drafts) => {
    if (inFlight.current || submitted || unknown || !questions.every((q) => !!answer(answers[q.id]))) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action("respond", {
        projectId,
        threadId: item.threadId,
        requestId: item.requestId,
        answers: Object.fromEntries(
          questions.map((q) => [q.id, answer(answers[q.id])]),
        ),
      });
      setSubmitted(true);
    } catch (cause) {
      const failure = cause as Error & { submissionUnknown?: boolean };
      if (failure.submissionUnknown) setUnknown(true);
      setError(failure.submissionUnknown ? "回答结果未确认，已填写内容保留。请先核对原问题状态，不会自动重复提交。" : "回答提交失败，请重试。已填写的内容已保留。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      await action("manage", { projectId, threadId: item.threadId, operation: "interactions" });
      setUnknown(false); setError("");
    } catch (cause) { setError(`无法核对问题状态。${(cause as Error).message}`); }
    finally { setBusy(false); }
  };
  // Retain the ZCode elicitation state mechanism with Codex bottom-dock layout.
  // Core receives the original option string or explicit custom text, never a skip.
  return (
    <>
      {collapsed && <Button type="button" className="decision-deferred" variant="outline" aria-label="展开待回答问题" onClick={() => setCollapsed(false)}><MessageCircleQuestion />问题等待回答<span>展开</span></Button>}
    <form hidden={collapsed} className="ask-user-form"
      onKeyDown={(e) => {
        if (locked || e.nativeEvent.isComposing || !/^[1-9]$/.test(e.key) || (e.target as HTMLElement).closest("input, textarea, button")) return;
        const option = options[Number(e.key) - 1];
        if (!option) return;
        e.preventDefault();
        const next = { ...drafts, [question.id]: { ...draft, mode: "option" as const, option } };
        setDrafts(next);
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (locked || !answer(draft)) return;
        if (index < questions.length - 1) setIndex(index + 1);
        else void submit();
      }}
    >
      <QuestionCard title={question.title} options={options} selected={custom ? undefined : draft.option}
        disabled={locked} titleRef={title} onSelect={option => update({ mode: "option", option })}
        busy={busy} feedback={<Feedback error={error} message={submitted ? "回答已提交，等待执行状态更新。" : undefined} />}
        onKeyDown={event => {
          if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing || busy || submitted) return;
          event.preventDefault(); event.stopPropagation(); setCollapsed(true);
        }}
        headerActions={<>
            {questions.length > 1 && <nav className="ask-user-navigation" aria-label="问题导航">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="上一题"
                disabled={locked || index === 0}
                onClick={() => setIndex(index - 1)}
              >
                <ChevronLeft />
              </Button>
              <span aria-live="polite">
                {index + 1} / {questions.length}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="查看下一题"
                disabled={locked || index === questions.length - 1}
                onClick={() => setIndex(index + 1)}
              >
                <ChevronRight />
              </Button>
            </nav>}
          <Button type="button" variant="ghost" size="icon-xs" aria-label="收起问题" disabled={busy || submitted} onClick={() => setCollapsed(true)}><X /></Button>
        </>}
        footer={<>
          {(!options.length || question.allowFreeText) && <div className="ask-user-custom" data-selected={custom}>
            <Pencil size={14} aria-hidden="true" />
            <Textarea aria-label={`自定义回答：${question.title}`} placeholder={options.length ? "或自行撰写回复" : "输入你的回答…"}
              rows={1} disabled={locked} value={draft.text}
              onFocus={() => { if (!locked) update({ mode: "custom" }); }}
              onChange={(e) => update({ mode: "custom", text: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                if (e.key === "Enter" && !e.shiftKey && (prefs.sendShortcut === "enter" || e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }} />
          </div>}
          {!single && <span className="ask-user-progress" role="status">已回答 {answered} / {questions.length}</span>}
          {unknown ? <Button type="button" className="decision-button" variant="outline" disabled={busy} onClick={() => void refresh()}>核对待回答状态</Button> : <>
            <Button type="button" className="decision-button ask-user-defer" variant="outline" disabled={busy || submitted} onClick={() => setCollapsed(true)}>{t("decision.answerLater")}</Button>
            <Button type="submit" className="decision-button decision-primary" disabled={locked || !answer(draft) || (index === questions.length - 1 && !complete)}>
              {busy ? "提交中…" : submitted ? "已提交" : index < questions.length - 1 ? "下一题" : "发送"}
            </Button>
          </>}
        </>}>
      </QuestionCard>
    </form>
    </>
  );
}
