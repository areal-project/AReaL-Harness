import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  let selected = false;
  return {
    ...react,
    useState: (initial: unknown) => {
      if (initial === null && !selected) {
        selected = true;
        return react.useState("provider");
      }
      return react.useState(initial);
    },
  };
});
vi.mock("../i18n/IntlProvider.js", () => ({
  useI18n: () => ({ t: (id: string) => id, locale: "zh-CN" }),
  useZCodeIntl: () => ({
    t: (id: string) => id,
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
  UiMessageError: Error,
}));
vi.mock("./model-provider-section/ProviderApiFormatSelect.js", () => ({
  ProviderApiFormatSelect: () => null,
}));
vi.mock("./UnsavedChanges.js", () => ({
  useGuardedNavigation: () => vi.fn(),
  useDraftBlocker: vi.fn(),
}));
vi.mock("./common.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./common.js")>();
  return {
    ...original,
    useResource: () => ({
      value: {
        revision: 1,
        data: [
          {
            id: "provider",
            name: "Provider",
            enabled: true,
            apiKeyEnv: "API_KEY",
            models: [],
            parameters: {},
            protocol: "responses",
            baseUrl: "https://example.com",
          },
        ],
        credentialStates: { provider: "unavailable" },
        credentialErrors: { provider: "storageLocked" },
      },
      loading: false,
      refresh: vi.fn(),
      accept: vi.fn(),
    }),
  };
});
import { ModelSettings } from "./ModelSettings.js";

describe("locked provider credential", () => {
  it("shows the recovery status in the provider and API key area", () => {
    const markup = renderToStaticMarkup(createElement(ModelSettings, { action: vi.fn() }));
    expect(markup.match(/settings\.modelSettings\.keychainLocked/g)).toHaveLength(2);
    expect(markup).not.toContain("settings.modelSettings.missingCredentials");
  });
});
