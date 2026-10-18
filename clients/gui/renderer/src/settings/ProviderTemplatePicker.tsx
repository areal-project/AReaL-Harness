import templates from "./provider-templates.json";
import type { Data } from "../services.js";
import type { ReactNode } from "react";
import { ArrowLeft, Boxes, ChevronRight as ChevronRightIcon, Plus } from "lucide-react";
import { Button } from "../components/ui/button.js";
export function ProviderTemplatePicker({
  onBack,
  onCreate,
  disabled,
}: {
  onBack: () => void;
  onCreate: (template: Data) => void;
  disabled: boolean;
}) {
  return (
    <section className="space-y-5">
      <div className="resource-title">
        <Button variant="ghost" size="icon" aria-label="返回供应商列表" onClick={onBack}>
          <ArrowLeft />
        </Button>
        <h2>添加供应商</h2>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ProviderTemplateCard label="创建自定义供应商" disabled={disabled} testId="custom-provider" icon={<Plus size={24} />} onClick={() => onCreate({ name: "自定义供应商", baseUrl: "", protocol: "chatCompletions", models: [] })} />
        <ProviderTemplateCard label="ChatGPT API" disabled={disabled} testId="openai-provider" icon={<Boxes size={24} />} onClick={() => onCreate({ subscription: true })} />
        {templates.map(template => <ProviderTemplateCard key={template.name} label={template.name} disabled={disabled} testId={template.name} icon={<img alt="" className="size-8 object-contain" src={new URL(`../assets/provider-icons/${template.icon}`, import.meta.url).href} />} onClick={() => onCreate(template)} />)}
      </div>
    </section>
  );
}
function ProviderTemplateCard({
  label,
  disabled,
  testId: cardTestId,
  icon,
  onClick,
}: {
  label: string;
  disabled: boolean;
  testId: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <>
      <button
        type="button"
        data-testid={cardTestId}
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-16 min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors outline-none hover:border-border-hover hover:bg-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60"
      >
        {icon}
        <span className="min-w-0 flex-1 break-words text-ui-base font-medium">{label}</span>
        <ChevronRightIcon className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      </button>
    </>
  );
}
