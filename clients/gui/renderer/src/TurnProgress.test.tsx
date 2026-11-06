import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { TurnProgress } from "./TurnProgress.js";

vi.mock("./i18n/IntlProvider.js", () => ({
  useI18n: () => ({
    t: (id: string, values?: Record<string, unknown>) =>
      id === "chat.progress.duration"
        ? `${values?.minutes}m ${values?.seconds}s`
        : id === "chat.progress.working"
          ? `Working for ${values?.duration}`
          : id === "chat.progress.worked"
            ? `Worked for ${values?.duration}`
            : id === "chat.activity.part.failures"
              ? `${values?.count} failed`
              : ((values?.label as string | undefined) ?? id),
  }),
}));

describe("TurnProgress heading", () => {
  it.each(["completed", "failed", "inProgress"])(
    "keeps only the duration and disclosure for %s",
    (status) => {
      const facts = { failures: 2, unfinished: true };
      const markup = renderToStaticMarkup(
        createElement(TurnProgress, {
          ...facts,
          settled: status === "completed",
          summaryAvailable: true,
          connected: true,
          turn: {
            id: "turn",
            status,
            durationMs: 929000,
            startedAt: Math.floor(Date.now() / 1000) - 929,
          },
          children: "Activity content",
        }),
      );
      expect(markup).toContain(
        status === "inProgress" ? "Working for 15m 29s" : "Worked for 15m 29s",
      );
      expect(markup).toContain("aria-expanded=");
      expect(markup).toContain("aria-controls=");
      expect(markup).not.toContain("turn-failure-indicator");
      expect(markup).not.toContain("circle-alert");
      expect(markup).not.toContain("chat.progress.unconfirmed");
    },
  );

  it("stops the clock while the turn waits for approval", () => {
    const markup = renderToStaticMarkup(
      createElement(TurnProgress, {
        settled: false,
        summaryAvailable: true,
        connected: true,
        awaiting: true,
        turn: { id: "turn", status: "inProgress", startedAt: Math.floor(Date.now() / 1000) - 74 },
        children: "Activity content",
      }),
    );
    expect(markup).toContain("chat.progress.awaiting");
    expect(markup).not.toContain("Working for");
  });

  it("counts failed tool steps in the finished heading", () => {
    const markup = renderToStaticMarkup(
      createElement(TurnProgress, {
        settled: true,
        summaryAvailable: true,
        connected: true,
        turn: {
          id: "turn",
          status: "completed",
          durationMs: 44000,
          items: [
            {
              id: "c",
              type: "dynamicToolCall",
              tool: "run_command",
              status: "failed",
              success: false,
              arguments: { argv: ["npm", "view", "vitest", "version"] },
            },
          ],
        },
        children: "Activity content",
      }),
    );
    expect(markup).toContain("Worked for 0m 44s · 1 failed");
  });

  it("omits task status from continuation headings too", () => {
    const facts = { failures: 1, unfinished: true };
    const markup = renderToStaticMarkup(
      createElement(TurnProgress, {
        ...facts,
        settled: false,
        summaryAvailable: true,
        label: "Working",
        children: "Activity content",
      }),
    );
    expect(markup).toContain("Working");
    expect(markup).not.toContain("chat.progress.unconfirmed");
    expect(markup).not.toContain("turn-failure-indicator");
  });
});
