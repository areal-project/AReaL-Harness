import { useId, type ReactNode, type Ref } from "react";
import { Check, MessageCircleQuestion } from "lucide-react";
import { DecisionCard } from "../decision-card/decision-card.js";

export function QuestionCard({ title, options, selected, disabled, titleRef, onSelect, headerActions, footer, feedback, busy, onKeyDown }: {
  title: string; options: readonly string[]; selected?: string; disabled?: boolean;
  titleRef?: Ref<HTMLHeadingElement>; onSelect: (value: string) => void;
  headerActions?: ReactNode; footer: ReactNode; feedback?: ReactNode; busy?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
}) {
  const id = useId();
  return <DecisionCard kind="question" label="问题" regionLabel="需要你的回答" icon={<MessageCircleQuestion />} className="ask-user-card" busy={busy} onKeyDown={onKeyDown} headerActions={headerActions} footer={footer} feedback={feedback}>
    <h3 className="decision-card-title" ref={titleRef} tabIndex={-1} id={`${id}-title`}>{title}</h3>
    <fieldset disabled={disabled} aria-labelledby={`${id}-title`} className="ask-user-options">
      {options.map((option, index) => <label key={index} className="ask-user-option" data-selected={selected === option}>
        <input type="radio" name={id} value={option} checked={selected === option} onChange={() => onSelect(option)} />
        <span className="ask-user-number" aria-hidden="true">{index + 1}</span>
        <span>{option}</span>
        {selected === option && <Check size={16} className="ask-user-check" aria-hidden="true" />}
      </label>)}
    </fieldset>
  </DecisionCard>;
}
