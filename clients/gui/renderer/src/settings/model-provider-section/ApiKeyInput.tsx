import { EyeIcon, EyeOffIcon } from "lucide-react";
const TID_MODEL_PROVIDER_API_KEY_INPUT = "provider-api-key";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { useZCodeIntl } from "../../i18n/IntlProvider.js";
import { TECHNICAL_INPUT_ATTRIBUTES } from "../../lib/technicalInputAttributes.js";

export function ApiKeyInput({
  value,
  configured,
  loading,
  visible,
  readOnly,
  onChange,
  onBlur,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onToggleVisibility,
}: {
  value: string;
  configured?: boolean;
  loading?: boolean;
  visible: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
  onBlur: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  onToggleVisibility: () => void;
}) {
  const { t, intl } = useZCodeIntl();

  return (
    <div className="relative">
      <Input
        {...TECHNICAL_INPUT_ATTRIBUTES}
        type={visible && !readOnly ? "text" : "password"}
        size="lg"
        aria-label="API Key"
        data-testid={TID_MODEL_PROVIDER_API_KEY_INPUT}
        endAction
        className="h-9"
        placeholder={
          configured
            ? "••••••••"
            : intl.formatMessage({
                id: "settings.modelProvider.apiKeyPlaceholder",
              })
        }
        value={value}
        readOnly={readOnly}
        disabled={readOnly}
        onChange={(event) => {
          if (!readOnly) {
            onChange(event.target.value);
          }
        }}
        onBlur={readOnly ? undefined : onBlur}
        onKeyDown={readOnly ? undefined : onKeyDown}
        onCompositionStart={readOnly ? undefined : onCompositionStart}
        onCompositionEnd={readOnly ? undefined : onCompositionEnd}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={readOnly || loading || (!value && !configured)}
        className="absolute top-1/2 right-1.5 -translate-y-1/2"
        aria-busy={loading}
        aria-label={
          visible ? t("settings.apiKeyInput.hideAPIKey") : t("settings.apiKeyInput.showAPIKey")
        }
        onClick={onToggleVisibility}
      >
        {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
      </Button>
    </div>
  );
}
