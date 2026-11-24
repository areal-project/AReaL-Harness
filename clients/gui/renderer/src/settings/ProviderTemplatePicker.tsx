import { useI18n } from "../i18n/IntlProvider.js";
import definitions from "@areal/provider-config/definitions.json";
const templates = definitions.filter((item) => item.kind === "api");
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
  const { t } = useI18n();
  const create = (definition: Data) => {
    // 服务定义身份不属于用户连接，不能把它作为 Core 的已有 provider ID 保存。
    const { id: definitionId, ...template } = definition;
    onCreate({
      ...template,
      ...(definitionId === "custom-compatible"
        ? { name: t("settings.providerTemplatePicker.customProvider") }
        : {}),
      definitionId,
    });
  };
  return (
    <section
      className="provider-picker"
      aria-label={t("settings.providerTemplatePicker.chooseProvider")}
    >
      <div className="provider-picker-heading">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("settings.providerTemplatePicker.backToProviderList")}
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <h2>{t("settings.providerTemplatePicker.addProvider")}</h2>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <ProviderTemplateCard
          label={t("settings.providerTemplatePicker.createCustomProvider")}
          disabled={disabled}
          testId="custom-provider"
          icon={<Plus size={24} />}
          onClick={() => create(definitions.find((item) => item.id === "custom-compatible")!)}
        />
        <ProviderTemplateCard
          label="ChatGPT"
          disabled={disabled}
          testId="openai-provider"
          icon={<Boxes size={24} />}
          onClick={() =>
            create({
              ...definitions.find((item) => item.id === "chatgpt-siwc"),
              subscription: true,
            })
          }
        />
        {templates.map((template) => (
          <ProviderTemplateCard
            key={template.name}
            label={template.name}
            disabled={disabled}
            testId={template.name}
            icon={
              <img
                alt=""
                className="size-8 object-contain"
                src={new URL(`../assets/provider-icons/${template.icon}`, import.meta.url).href}
              />
            }
            onClick={() => create(template)}
          />
        ))}
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
      <Button
        type="button"
        variant="surface"
        size="auto"
        align="start"
        wrap
        data-testid={cardTestId}
        disabled={disabled}
        onClick={onClick}
        className="min-h-16 w-full min-w-0"
      >
        <span className="flex min-w-0 flex-1 items-center gap-3 px-2 py-1.5">
          {icon}
          <span className="min-w-0 flex-1 break-words text-ui-base font-medium">{label}</span>
          <ChevronRightIcon
            className="size-4 shrink-0 text-foreground-subtlest"
            aria-hidden="true"
          />
        </span>
      </Button>
    </>
  );
}
