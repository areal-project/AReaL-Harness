export type ProviderApiType = "chatCompletions" | "responses";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select.js";
import { useZCodeIntl } from "../../i18n/IntlProvider.js";
const TID_MODEL_PROVIDER_API_FORMAT_TRIGGER = "provider-api-format";
const TID_MODEL_PROVIDER_API_FORMAT_ITEM = "provider-api-format-item";
const testId = (...parts: string[]) => parts.join(":");

const PROVIDER_CONNECTION_API_FORMATS: readonly ProviderApiType[] = [
  "chatCompletions",
  "responses",
];

const PROVIDER_CONNECTION_API_FORMAT_PATHS: Record<ProviderApiType, string> = {
  "chatCompletions": "/chat/completions",
  "responses": "/responses",
};

const PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS: Record<ProviderApiType, string> = {
  "chatCompletions": "settings.modelProvider.apiFormat.title.chatCompletions",
  "responses": "settings.modelProvider.apiFormat.title.responses",
};

export function resolveProviderConnectionApiFormatOptions(): ProviderApiType[] {
  return [...PROVIDER_CONNECTION_API_FORMATS];
}

export function resolveProviderConnectionApiFormatDisplayLabel(
  intl: { formatMessage: (descriptor: { id: string }) => string },
  format: ProviderApiType,
): string {
  const title = intl.formatMessage({
    id: PROVIDER_CONNECTION_API_FORMAT_TITLE_IDS[format],
  });
  return `${title} (${PROVIDER_CONNECTION_API_FORMAT_PATHS[format]})`;
}

export function ProviderApiFormatSelect({
  apiFormatOptions = PROVIDER_CONNECTION_API_FORMATS,
  triggerId,
  value,
  onChange,
}: {
  apiFormatOptions?: readonly ProviderApiType[];
  triggerId?: string;
  value: ProviderApiType;
  onChange: (value: ProviderApiType) => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <Select<ProviderApiType> value={value}
      items={apiFormatOptions.map(format => ({ value: format, label: resolveProviderConnectionApiFormatDisplayLabel(intl, format) }))}
      onValueChange={nextValue => { if (nextValue !== null) onChange(nextValue); }}>
      <SelectTrigger
        id={triggerId} aria-label="API 格式"
        data-testid={TID_MODEL_PROVIDER_API_FORMAT_TRIGGER}
        size="lg"
        className="w-full justify-between"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start">
        {apiFormatOptions.map((format) => (
          <SelectItem
            key={format}
            value={format}
            data-testid={testId(TID_MODEL_PROVIDER_API_FORMAT_ITEM, format)}
          >
            {resolveProviderConnectionApiFormatDisplayLabel(intl, format)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
