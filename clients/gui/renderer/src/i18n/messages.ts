import { bugReportMessages } from "./messages/bugReport.js";
import { snapshotMessages } from "./messages/snapshots.js";
import { browserHostMessages } from "./messages/browserHost.js";
import { browserMessages } from "./messages/browser.js";
import { composerPriorityMessages } from "./messages/composerPriority.js";
import { resourceMessages } from "./messages/resources.js";
import { timelineMessages } from "./messages/timeline.js";
import { trajectoryMessages } from "./messages/trajectory.js";
import { mobileMessages } from "./messages/mobile.js";
import { automationMessages } from "./messages/automation.js";
import { desktopSettingsMessages } from "./messages/desktopSettings.js";
import { operationMessages } from "./messages/operations.js";
import { appMessages } from "./messages/apps.js";
import { commonMessages } from "./messages/common.js";
import { conversationMessages } from "./messages/conversation.js";
import { generalMessages } from "./messages/general.js";
import { pluginMessages } from "./messages/plugins.js";
import { remoteMessages } from "./messages/remote.js";
import { worktreeMessages } from "./messages/worktrees.js";

export type AppLocale = "zh-CN" | "en";
export type MessagePair = Record<AppLocale, string>;
export const messages = {
  ...bugReportMessages,
  ...snapshotMessages,
  ...browserMessages,
  ...browserHostMessages,
  ...composerPriorityMessages,
  ...resourceMessages,
  ...timelineMessages,
  ...trajectoryMessages,
  ...mobileMessages,
  ...desktopSettingsMessages,
  ...automationMessages,
  ...operationMessages,
  ...commonMessages,
  ...conversationMessages,
  ...appMessages,
  ...generalMessages,
  ...pluginMessages,
  ...remoteMessages,
  ...worktreeMessages,
} as const satisfies Record<string, MessagePair>;
export type MessageId = keyof typeof messages;
export const catalogs = Object.fromEntries(
  (["zh-CN", "en"] as const).map((locale) => [
    locale,
    Object.fromEntries(Object.entries(messages).map(([id, pair]) => [id, pair[locale]])),
  ]),
) as Record<AppLocale, Record<MessageId, string>>;
