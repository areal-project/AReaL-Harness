import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vite-plus/test";
import { ScheduledTaskRow } from "./ScheduledTasks.js";

const editorImport = vi.hoisted(() => vi.fn());
vi.mock("./ScheduledTaskEditDialog.js", () => {
  editorImport();
  return { ScheduledTaskEditDialog: () => null };
});
vi.mock("./i18n/IntlProvider.js", () => ({
  useI18n: () => ({ t: (id: string) => id }),
}));

test("reading a scheduled task does not import its editor or execute task actions", () => {
  const action = vi.fn();
  const markup = renderToStaticMarkup(
    createElement(ScheduledTaskRow, {
      task: {
        id: "task",
        objective: "Review CI",
        mode: "scheduled",
        runs: [],
        schedule: { kind: "once", at: 2000000000 },
        nextRunAt: 2000000000,
      },
      project: { id: "project", state: { connected: true }, pending: [] },
      action,
      variant: "card",
    }),
  );
  expect(markup).toContain('data-scheduled-task-menu="task"');
  expect(markup).toContain("Review CI");
  expect(editorImport).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});
