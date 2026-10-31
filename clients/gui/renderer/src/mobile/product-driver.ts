import { App } from "@capacitor/app";
import type { ProbeBridge } from "../mobile.js";
import { keychain } from "./platform.js";

const wait = async <T>(
  read: () => T | null | undefined | false,
  label = "ProductConditionTimeout",
): Promise<T> => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(label);
};
const state = (value: string) => document.querySelector(`[data-state="${value}"]`);
const click = async (action: string) => {
  const button = await wait(() =>
    document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`),
  );
  await wait(() => !button.disabled);
  button.click();
};

export async function runProduct(
  config: { mode: string; link?: string; projectId?: string; threadId?: string },
  bridge: ProbeBridge,
) {
  try {
    const observations: {
      projects?: number;
      history?: boolean;
      historyAutoload?: boolean;
      live?: boolean;
      threadId?: string;
      queued?: boolean;
      queueItemId?: string;
      inputFontSize?: string;
      permissionSelection?: boolean;
      viewport?: { width: number; height: number; scale: number };
      touchTargets?: { name: string; width: number; height: number }[];
    } = {};
    if (config.mode === "pair") {
      await wait(() => state("unpaired"));
      await click("paste");
      const input = await wait(() =>
        document.querySelector<HTMLInputElement>('[data-field="pairing-link"]'),
      );
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        config.link,
      );
      delete config.link;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(
        () => !document.querySelector<HTMLButtonElement>('[data-action="pair"]')?.disabled,
      );
      await click("pair");
      await wait(() => state("pairing"));
      bridge.postMessage({
        kind: "pairing",
        peer: document.querySelector('[data-field="fingerprint"]')?.textContent,
      });
    }
    if (!["unpaired", "clear"].includes(config.mode)) await wait(() => state("connected"));
    if (["projects", "sessions", "baseline", "history", "live", "release"].includes(config.mode)) {
      await wait(
        () =>
          document.querySelectorAll("[data-project-id]").length === 2 &&
          !document.querySelector('[data-project-id][aria-busy="true"]'),
      );
      observations.projects = document.querySelectorAll("[data-project-id]").length;
      if (config.mode !== "projects") {
        document
          .querySelector<HTMLButtonElement>(`[data-project-id="${config.projectId}"]`)!
          .click();
        const thread = await wait(() =>
          document.querySelector<HTMLButtonElement>(`[data-thread-id="${config.threadId}"]`),
        );
        if (config.mode !== "sessions") {
          thread.click();
          await wait(() =>
            document.querySelector(".messages")?.textContent?.includes("MOBILE_HISTORY_052"),
          );
          if (document.querySelector(".messages")?.textContent?.includes("MOBILE_HISTORY_001"))
            throw new Error("HistoryFixtureTooSmall");
          const messages = document.querySelector<HTMLElement>(".messages")!;
          if (["history", "live"].includes(config.mode)) {
            const older = await wait(() =>
              [
                ...document.querySelectorAll<HTMLButtonElement>(".message-history-controls button"),
              ].find((button) => !button.disabled),
            );
            if (config.mode === "history") {
              messages.scrollTop = messages.scrollHeight;
              messages.dispatchEvent(new Event("scroll"));
              const bounds = messages.getBoundingClientRect();
              messages.dispatchEvent(
                new PointerEvent("pointerdown", {
                  bubbles: true,
                  pointerType: "touch",
                  clientX: bounds.left + bounds.width / 2,
                }),
              );
              messages.scrollTop = 0;
              messages.dispatchEvent(new Event("scroll"));
            } else older.click();
            await wait(() =>
              document.querySelector(".messages")?.textContent?.includes("MOBILE_HISTORY_001"),
            );
            observations.history = true;
            if (config.mode === "history") observations.historyAutoload = true;
            messages.scrollTop = 0;
            messages.dispatchEvent(new Event("scroll"));
          }
          if (config.mode === "live") {
            bridge.postMessage({ kind: "ready" });
            await wait(() =>
              document.querySelector(".messages")?.textContent?.includes("MOBILE_LIVE_UPDATE"),
            );
            if (!document.querySelector(".messages")?.textContent?.includes("MOBILE_HISTORY_003"))
              throw new Error("HistoryBoundaryLost");
            observations.live = true;
            messages.scrollTop = messages.scrollHeight;
            messages.dispatchEvent(new Event("scroll"));
          }
          if (config.mode === "release") {
            await click("workspace-back");
            await wait(() => document.querySelector('[data-page="work"]'));
          }
        }
      }
    }
    if (
      ["new", "models", "send", "permissions", "queue", "stop", "unknown", "recover"].includes(
        config.mode,
      )
    ) {
      const project = await wait(() =>
        document.querySelector<HTMLButtonElement>(`[data-project-id="${config.projectId}"]`),
      );
      project.click();
      if (["new", "models", "send"].includes(config.mode)) {
        await click("new-session");
        await wait(() => document.querySelector('[data-action="model-sheet"]:not(:disabled)'));
        if (config.mode !== "new") {
          await click("model-sheet");
          await click("model-advanced");
          await click("model-list");
          const alternative = await wait(() =>
            document.querySelector<HTMLElement>('[data-model-id="fixture-alt"]'),
          );
          if (config.mode === "send") {
            alternative.click();
            await click("effort-list");
            const effort = await wait(() =>
              [...document.querySelectorAll<HTMLElement>('.mobile-efforts [role="radio"]')].find(
                (button) => button.textContent === "High" || button.textContent === "高",
              ),
            );
            effort.click();
            await click("model-done");
            await wait(() => !document.querySelector('[role="dialog"]'), "ModelConfigureFailed");
          }
        }
      } else {
        const thread = await wait(() =>
          document.querySelector<HTMLButtonElement>(`[data-thread-id="${config.threadId}"]`),
        );
        thread.click();
        await wait(() => document.querySelector('[data-field="composer"][data-config-revision]'));
      }
      const type = async (text: string) => {
        const input = await wait(() =>
          document.querySelector<HTMLElement>('[data-testid="mobile-chat-input"]'),
        );
        input.focus();
        document.execCommand("selectAll", false);
        if (!document.execCommand("insertText", false, text))
          throw new Error("NativeInputRejected");
        await wait(
          () =>
            document.querySelector<HTMLButtonElement>('[data-action="send"]')?.disabled === false,
          "ComposerInputNotReady",
        );
      };
      const idle = () => document.querySelector('[data-field="composer"][data-active-turn=""]');
      if (config.mode === "send") {
        await type("MOBILE_FIRST_NON_DEFAULT");
        await click("send");
        await wait(
          () =>
            document
              .querySelector(".messages")
              ?.textContent?.includes("MOBILE_FIRST_NON_DEFAULT") && idle(),
        );
      }
      if (config.mode === "permissions") {
        await click("permission-sheet");
        const full = await wait(() =>
          document.querySelector<HTMLElement>(
            '[data-permission-preset="fullAccess"]:not([data-disabled])',
          ),
        );
        full.click();
        await wait(
          () => full.getAttribute("aria-checked") === "true",
          "PermissionSelectionMismatch",
        );
        const ask = document.querySelector<HTMLElement>('[data-permission-preset="ask"]')!;
        ask.click();
        await wait(
          () =>
            ask.getAttribute("aria-checked") === "true" &&
            full.getAttribute("aria-checked") === "false",
          "PermissionSelectionMismatch",
        );
        observations.permissionSelection = true;
        await click("model-done");
        await wait(() => !document.querySelector('[role="dialog"]'), "PermissionConfigureFailed");
      }
      if (config.mode === "queue" || config.mode === "stop") {
        await type(`MOBILE_HOLD_${config.mode.toUpperCase()}`);
        await click("send");
        await wait(() => document.querySelector('[data-action="stop"]'));
        if (config.mode === "queue") {
          await type("MOBILE_QUEUED_AFTER_CURRENT");
          await click("send");
          await wait(
            () => document.querySelector(".composer-queue")?.textContent?.includes("MOBILE_QUEUED"),
            "QueuedRowMissing",
          );
          observations.queued = true;
          observations.queueItemId =
            document.querySelector("[data-queue-id]")?.getAttribute("data-queue-id") ?? undefined;
          bridge.postMessage({ kind: "ready", queueItemId: observations.queueItemId });
          await wait(
            () =>
              document
                .querySelector(".messages")
                ?.textContent?.includes("MOBILE_QUEUED_AFTER_CURRENT") && idle(),
            "QueueExecutionIncomplete",
          );
        } else {
          await click("stop");
          await wait(idle);
        }
      }
      if (config.mode === "unknown") {
        await type("MOBILE_UNKNOWN_ONCE");
        await click("send");
        await wait(() => document.querySelector('[data-command-state="unknown"]'));
      }
      if (config.mode === "recover") {
        await wait(
          () =>
            document.querySelector(".messages")?.textContent?.includes("MOBILE_UNKNOWN_ONCE") &&
            !document.querySelector("[data-command-state]"),
        );
      }
      document.querySelector<HTMLElement>('[data-testid="mobile-chat-input"]')?.blur();
      await Promise.all(
        document.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      const editor = document.querySelector<HTMLElement>('[data-testid="mobile-chat-input"]');
      if (editor) observations.inputFontSize = getComputedStyle(editor).fontSize;
      observations.viewport = {
        width: visualViewport?.width ?? innerWidth,
        height: visualViewport?.height ?? innerHeight,
        scale: visualViewport?.scale ?? 1,
      };
      observations.threadId =
        document.querySelector("[data-current-thread]")?.getAttribute("data-current-thread") ??
        undefined;
      observations.touchTargets = [...document.querySelectorAll("button")].flatMap((button) => {
        const rect = button.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) return [];
        return [
          {
            name:
              button.getAttribute("data-action") ??
              button.getAttribute("aria-label") ??
              button.getAttribute("data-testid") ??
              "button",
            width: Math.round(rect.width * 10) / 10,
            height: Math.round(rect.height * 10) / 10,
          },
        ];
      });
    }
    if (config.mode === "lifecycle") {
      let background = false;
      let foreground = false;
      const listener = await App.addListener("appStateChange", ({ isActive }) => {
        if (!isActive) {
          background = true;
          bridge.postMessage({ kind: "background" });
        } else if (background) foreground = true;
      });
      bridge.postMessage({ kind: "ready" });
      await wait(() => foreground && state("connected"));
      await listener.remove();
    }
    if (config.mode === "revoked") {
      bridge.postMessage({ kind: "ready" });
      await wait(() => state("revoked"));
    }
    if (config.mode === "clear") {
      await wait(() => state("connected") || state("revoked"));
      await click("settings");
      await click("clear");
      await click("confirm-clear");
    }
    if (["clear", "unpaired"].includes(config.mode)) await wait(() => state("unpaired"));
    const saved = await keychain.load();
    const record = saved.value ? JSON.parse(saved.value) : null;
    bridge.postMessage({
      kind: "result",
      result: {
        status: "success",
        ...observations,
        mode: config.mode,
        origin: location.origin,
        state: document.querySelector("[data-state]")?.getAttribute("data-state"),
        remembered: document.querySelector("[data-state]")?.getAttribute("data-remembered"),
        keychainPresent: record !== null,
        locators: record?.client?.locators?.length ?? 0,
        identityPresent: typeof record?.client?.credential?.identity === "string",
        grantRevision: record?.grantRevision ?? null,
        peer: record?.client?.credential?.peerId ?? null,
      },
    });
  } catch (error) {
    let keychainDiagnostic: Record<string, string | number | boolean | null>;
    try {
      const result = await keychain.load();
      keychainDiagnostic = { valueIsNull: result.value === null, valueType: typeof result.value };
    } catch (failure) {
      const native = failure as { code?: string; status?: number; data?: { status?: number } };
      const status = native.status ?? native.data?.status;
      keychainDiagnostic = {
        code:
          typeof native.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(native.code)
            ? native.code
            : "UNKNOWN",
        status: Number.isSafeInteger(status) ? status! : null,
      };
    }
    bridge.postMessage({
      kind: "result",
      result: {
        status: "failure",
        origin: location.origin,
        keychainDiagnostic,
        mode: config.mode,
        state: document.querySelector("[data-state]")?.getAttribute("data-state"),
        error:
          error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,64}$/.test(error.message)
            ? error.message
            : "UnknownError",
      },
    });
  }
}
