import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const credential = vi.hoisted(() => ({ state: "unavailable", selected: false }));

vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (initial === null && !credential.selected) {
        credential.selected = true;
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
        credentialStates: { provider: credential.state },
        credentialErrors: { provider: "storageLocked" },
      },
      loading: false,
      refresh: vi.fn(),
      accept: vi.fn(),
    }),
  };
});
import { ModelSettings } from "./ModelSettings.js";

beforeEach(() => {
  credential.selected = false;
});

describe("locked provider credential", () => {
  it("shows the recovery status in the provider and API key area", () => {
    const markup = renderToStaticMarkup(createElement(ModelSettings, { action: vi.fn() }));
    expect(markup.match(/settings\.modelSettings\.keychainLocked/g)).toHaveLength(2);
    expect(markup).not.toContain("settings.modelSettings.missingCredentials");
  });
});

describe("unchecked provider credential", () => {
  it("keeps configuration usable while showing checking instead of an old lock error", () => {
    credential.state = "checking";
    try {
      const markup = renderToStaticMarkup(createElement(ModelSettings, { action: vi.fn() }));
      expect(markup).toContain("settings.modelSettings.checkingCredentials");
      expect(markup).not.toContain("settings.modelSettings.keychainLocked");
      expect(markup).toContain("settings.modelSettings.addProvider");
    } finally {
      credential.state = "unavailable";
    }
  });
});
