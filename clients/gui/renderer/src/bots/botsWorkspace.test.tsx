import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createIntl, createIntlCache, IntlProvider } from "react-intl";
import { describe, expect, it, vi } from "vite-plus/test";
import { catalogs } from "../i18n/messages.js";
import type { BotRecord } from "../host-bots.js";
import { extractTimelineFromThread } from "./botTimeline.js";
import { BotMessages } from "./BotMessages.js";
import { BotSettingsPane } from "./BotSettingsPane.js";

const testIntl = createIntl({ locale: "zh-CN", messages: catalogs["zh-CN"] }, createIntlCache());

vi.mock("../settings/applicationPreferences.js", () => ({
  useApplicationPreferences: () => ({ locale: "zh-CN", reducedMotion: false }),
}));

vi.mock("../i18n/IntlProvider.js", () => ({
  useI18n: () => ({
    intl: testIntl,
    locale: "zh-CN",
    t: (id: string, values?: Record<string, string | number>) =>
      testIntl.formatMessage({ id }, values),
  }),
}));

function renderZh(node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(IntlProvider, { locale: "zh-CN", messages: catalogs["zh-CN"] }, node),
  );
}

function sampleBot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    id: "bot_weekly",
    name: "周报助手",
    avatar: "📝",
    description: "梳理本周进展与风险",
    workspace: "bot-weekly",
    starterPrompts: ["帮我整理本周工作重点", "生成下周计划"],
    systemPromptMode: "personalAgent",
    preferences: "用中文要点回复",
    preferencesRevision: 2,
    syncedPreferencesRevision: 2,
    preferencesDirty: false,
    providerSyncMode: "auto",
    threadRequestId: "test-request",
    createdAt: 1700000000,
    updatedAt: 1700000100,
    lastActiveAt: 1700000100,
    lastMessagePreview: "本周重点已整理",
    connectionState: { kind: "ready" },
    ...overrides,
  };
}

describe("extractTimelineFromThread", () => {
  it("projects user messages, assistant replies, collapsed tool steps, and pending interactions", () => {
    const timeline = extractTimelineFromThread({
      turns: [
        {
          id: "turn_1",
          status: "completed",
          items: [
            { id: "u1", type: "userMessage", content: [{ type: "text", text: "总结本周进展" }] },
            { id: "r1", type: "reasoning", text: "internal thought" },
            { id: "t1", type: "commandExecution", command: "cat notes.md", status: "completed" },
            {
              id: "a1",
              type: "agentMessage",
              text: "本周完成了三项核心交付。",
              status: "completed",
            },
          ],
        },
      ],
      desktop: {
        pendingInteractions: [
          {
            requestId: "req_1",
            turnId: "turn_1",
            toolName: "write_file",
            summary: "Update AGENTS.md memory",
          },
        ],
      },
    });

    expect(timeline.messages).toHaveLength(2);
    expect(timeline.messages[0]).toMatchObject({ role: "user", text: "总结本周进展" });
    expect(timeline.messages[1]).toMatchObject({
      role: "assistant",
      text: "本周完成了三项核心交付。",
      streaming: false,
      activities: [{ id: "t1", label: "cat notes.md", status: "completed" }],
    });
    expect(timeline.pendingInteractions).toEqual([
      {
        requestId: "req_1",
        turnId: "turn_1",
        title: "write_file",
        detail: "Update AGENTS.md memory",
        argumentsDigest: undefined,
      },
    ]);
  });

  it("attaches failed turn errors and suppresses empty assistant items", () => {
    const timeline = extractTimelineFromThread({
      turns: [
        {
          id: "turn_fail",
          status: "failed",
          error: { message: "model HTTP status 401 Unauthorized" },
          items: [
            { id: "u1", type: "userMessage", content: [{ type: "text", text: "1" }] },
            { id: "a1", type: "agentMessage", text: "", status: "completed" },
          ],
        },
        {
          id: "turn_blank",
          status: "completed",
          items: [
            { id: "u2", type: "userMessage", content: [{ type: "text", text: "2" }] },
            { id: "a2", type: "agentMessage", text: "   ", status: "completed" },
          ],
        },
      ],
    });

    expect(timeline.messages).toHaveLength(3);
    expect(timeline.messages[0]).toMatchObject({ role: "user", text: "1" });
    expect(timeline.messages[1]).toMatchObject({
      role: "assistant",
      text: "",
      error: "model HTTP status 401 Unauthorized",
      streaming: false,
    });
    expect(timeline.messages[2]).toMatchObject({ role: "user", text: "2" });
  });
});

describe("BotMessages", () => {
  const noop = () => {};

  it("renders empty Personal Agent welcome with starter prompt chips", () => {
    const html = renderZh(
      createElement(BotMessages, {
        bot: sampleBot(),
        messages: [],
        pendingInteractions: [],
        providerHealth: { status: "ready" },
        reconciling: false,
        onStarterPrompt: noop,
        onReconcile: noop,
        onRespondInteraction: noop,
        onOpenProviderSettings: noop,
      }),
    );

    expect(html).toContain("周报助手");
    expect(html).toContain("帮我整理本周工作重点");
    expect(html).toContain("生成下周计划");
  });

  it("renders collapsed tool activity, unconfirmed banner, provider warning, and approval card", () => {
    const html = renderZh(
      createElement(BotMessages, {
        bot: sampleBot({
          connectionState: { kind: "waking" },
          pendingSubmission: {
            requestId: "cmd_pending",
            threadId: "thread",
            digest: "fixture",
            preview: "hello",
            createdAt: 1700000100,
          },
        }),
        messages: [
          { id: "m1", role: "user", text: "整理一下今日安排" },
          {
            id: "m2",
            role: "assistant",
            text: "已为你排好时间块。",
            activities: [{ id: "act_1", label: "read_calendar", status: "completed" }],
          },
        ],
        pendingInteractions: [
          {
            requestId: "req_42",
            turnId: "turn_9",
            title: "发送提醒",
            detail: "将在下午 3 点发送提醒",
          },
        ],
        providerHealth: {
          status: "authFailed",
          message: "API key invalid",
        },
        reconciling: false,
        onStarterPrompt: noop,
        onReconcile: noop,
        onRespondInteraction: noop,
        onOpenProviderSettings: noop,
      }),
    );

    expect(html).toContain("正在唤醒云端沙箱");
    expect(html).toContain("bot-provider-warning");
    expect(html).toContain("API key invalid");
    expect(html).toContain("bot-unknown-banner");
    expect(html).toContain("bot-reconcile-button");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("执行了 1 项内部操作");
    expect(html).toContain("bot-interaction-req_42");
    expect(html).toContain("允许");
    expect(html).toContain("拒绝");
  });

  it("renders failed turn error cards with provider shortcut and filters empty assistant bubbles", () => {
    const html = renderZh(
      createElement(BotMessages, {
        bot: sampleBot(),
        messages: [
          { id: "u1", role: "user", text: "1" },
          { id: "a_empty", role: "assistant", text: "", streaming: false },
          {
            id: "a_err",
            role: "assistant",
            text: "",
            error: "model HTTP status 401 Unauthorized",
            streaming: false,
          },
        ],
        pendingInteractions: [],
        providerHealth: { status: "authFailed" },
        reconciling: false,
        onStarterPrompt: noop,
        onReconcile: noop,
        onRespondInteraction: noop,
        onOpenProviderSettings: noop,
      }),
    );

    expect(html).toContain("bot-turn-error");
    expect(html).toContain("model HTTP status 401 Unauthorized");
    expect(html).toContain("检查模型通道");
    expect(html.match(/data-role="assistant"/g)).toHaveLength(1);
  });
});

describe("BotSettingsPane", () => {
  it("shows synced vs pending preference badge, capability notice, and sandbox controls", () => {
    const syncedHtml = renderZh(
      createElement(BotSettingsPane, {
        bot: sampleBot({
          preferencesRevision: 2,
          syncedPreferencesRevision: 2,
          preferencesDirty: false,
        }),
        models: [{ id: "gpt-5-mini", providerId: "openai", displayName: "GPT-5 Mini" }],
        providerHealth: { status: "ready", supportsCredentialRegistration: true },
        expandProviderForm: false,
        onClose: vi.fn(),
        onUpdate: vi.fn(async () => sampleBot()),
        onConnect: vi.fn(async () => {}),
        onDisconnect: vi.fn(async () => {}),
        onCompact: vi.fn(async () => {}),
        onResetConversation: vi.fn(async () => {}),
        onRemove: vi.fn(async () => true),
        onUpsertProvider: vi.fn(async () => true),
      }),
    );
    expect(syncedHtml).toContain("已实时同步到沙箱");
    expect(syncedHtml).toContain("GPT-5 Mini");
    expect(syncedHtml).toContain("bot-weekly");

    const dirtyHtml = renderZh(
      createElement(BotSettingsPane, {
        bot: sampleBot({
          preferencesRevision: 3,
          syncedPreferencesRevision: 2,
          preferencesDirty: true,
        }),
        models: [],
        harnessModels: [{ providerId: "team", modelId: "model-a", displayName: "Team Model" }],
        onOpenModelServices: vi.fn(),
        providerHealth: { status: "authFailed", supportsCredentialRegistration: false },
        expandProviderForm: true,
        onClose: vi.fn(),
        onUpdate: vi.fn(async () => sampleBot()),
        onConnect: vi.fn(async () => {}),
        onDisconnect: vi.fn(async () => {}),
        onCompact: vi.fn(async () => {}),
        onResetConversation: vi.fn(async () => {}),
        onRemove: vi.fn(async () => true),
        onUpsertProvider: vi.fn(async () => true),
      }),
    );
    expect(dirtyHtml).toContain("待下次唤醒时同步");
    expect(dirtyHtml).toContain("bot-provider-apply");
    expect(dirtyHtml).toContain('value="custom"');
    expect(dirtyHtml).toContain("bot-capability-callout");
    expect(dirtyHtml).toContain("Harness · Team Model（team）");
    expect(dirtyHtml).toContain("打开模型设置");
  });
});
