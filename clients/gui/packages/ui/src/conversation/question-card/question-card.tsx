import { useId, type ReactNode, type Ref } from "react";
import { Check, MessageCircleQuestion } from "lucide-react";
import { Disclosure } from "../../components/disclosure/disclosure.js";
import { DecisionCard } from "../decision-card/decision-card.js";

export function QuestionCard({
  title,
  options,
  selected,
  disabled,
  titleRef,
  onSelect,
  headerActions,
  footer,
  feedback,
  busy,
  onKeyDown,
  label = "问题",
  regionLabel = "需要你的回答",
}: {
  title: string;
  options: readonly string[];
  selected?: string;
  disabled?: boolean;
  titleRef?: Ref<HTMLHeadingElement>;
  onSelect: (value: string) => void;
  headerActions?: ReactNode;
  footer: ReactNode;
  feedback?: ReactNode;
  busy?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
  label?: string;
  regionLabel?: string;
}) {
  const id = useId();
  return (
    <DecisionCard
      kind="question"
      label={label}
      regionLabel={regionLabel}
      icon={<MessageCircleQuestion />}
      className="ask-user-card"
      busy={busy}
      onKeyDown={onKeyDown}
      headerActions={headerActions}
      footer={footer}
      feedback={feedback}
    >
      <h3 className="decision-card-title" ref={titleRef} tabIndex={-1} id={`${id}-title`}>
        {title}
      </h3>
      <fieldset disabled={disabled} aria-labelledby={`${id}-title`} className="ask-user-options">
        {options.map((option, index) => (
          <label key={index} className="ask-user-option" data-selected={selected === option}>
            <input
              type="radio"
              name={id}
              value={option}
              checked={selected === option}
              onChange={() => onSelect(option)}
            />
            <span className="ask-user-number" aria-hidden="true">
              {index + 1}
            </span>
            <span>{option}</span>
            {selected === option && (
              <Check size={16} className="ask-user-check" aria-hidden="true" />
            )}
          </label>
        ))}
      </fieldset>
    </DecisionCard>
  );
}

/** 问答提交后在对话流中沉淀的单行可折叠摘要，点击展开查看完整问答对。 */
export function QuestionSummary({
  summary,
  items,
  emptyAnswerLabel = "未提供回答",
  icon,
  open,
  onOpenChange,
}: {
  summary: string;
  items: readonly { question: string; answer?: string }[];
  emptyAnswerLabel?: string;
  icon?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <div className="ask-user-summary" data-slot="question-summary">
      <Disclosure
        label={summary}
        icon={icon ?? <MessageCircleQuestion size={16} />}
        open={open}
        onOpenChange={onOpenChange}
        textRole="content"
      >
        <dl className="ask-user-summary-list">
          {items.map((entry, index) => (
            <div key={index} className="ask-user-summary-row">
              <dt className="ask-user-summary-question">{entry.question}</dt>
              <dd
                className="ask-user-summary-answer"
                data-empty={!entry.answer?.trim() || undefined}
              >
                {entry.answer?.trim() || emptyAnswerLabel}
              </dd>
            </div>
          ))}
        </dl>
      </Disclosure>
    </div>
  );
}
