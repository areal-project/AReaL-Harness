import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { Translate } from "./i18n/IntlProvider.js";
import { TaskCatalogNotice } from "./TaskCatalogNotice.js";

vi.mock("./i18n/IntlProvider.js", async () => {
  const { createIntl } = await import("react-intl");
  const { catalogs } = await import("./i18n/messages.js");
  const intl = createIntl({ locale: "en", messages: catalogs.en });
  const t: Translate = (id, values) => intl.formatMessage({ id }, values);
  return { useI18n: () => ({ t }) };
});

const render = (props: Partial<ComponentProps<typeof TaskCatalogNotice>> = {}) =>
  renderToStaticMarkup(
    createElement(TaskCatalogNotice, {
      projectName: "Owning project",
      disabled: false,
      onUpdate: () => {
        throw new Error("Rendering must not open a project");
      },
      ...props,
    }),
  );

describe("TaskCenter catalog diagnosis", () => {
  it("leaves published snapshots to the row marker instead of a list banner", () => {
    // 缓存行在各自的行尾标“上次记录”，列表顶部不随读取状态出现或消失。
    expect(render()).toBe("");
  });

  it("does not hint about snapshots for projects with no tasks", () => {
    expect(render()).toBe("");
  });

  it("keeps real errors visible even when the owning project has no tasks", () => {
    const failed = render({ error: "Catalog read failed: denied" });
    expect(failed).toContain("Owning project");
    expect(failed).toContain("Catalog read failed: denied");
    expect(failed).toContain("task-catalog-error");
    expect(render({ projectName: "Other project" })).toBe("");
  });

  it("keeps update disabled during reads or disconnection", () => {
    expect(render({ disabled: true, error: "Catalog read failed: denied" })).toContain(
      'disabled=""',
    );
  });
});
