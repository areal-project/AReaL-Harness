import { z } from 'zod';
import { browserCommandSchema, type BrowserCommand } from './upstream/schema/index.js';
export { executeBrowserCommandOnView } from './upstream/browser/browserCommandExecutor.js';
export { recordBrowserVideo } from './upstream/browser/browserVideoRecorder.js';
export { RecordingScenario, waitForDelay, waitForCondition } from './recordingScenario.js';
export { browserCommandSchema };
export { browserCommandResultSchema } from './upstream/schema/result.js';
export type { BrowserCommand };
export type { ControlledView } from './upstream/browser/browserCommandTypes.js';

export const supportedMethods = Object.freeze([
  'navigate', 'back', 'forward', 'reload', 'snapshot', 'click', 'type', 'press',
  'cuaKeypress', 'scroll', 'cuaScroll', 'domCuaScroll', 'hover', 'select', 'check',
  'drag', 'cuaDrag', 'screenshot', 'getState', 'elementInfo', 'evaluate',
  'getDialog', 'handleDialog', 'playwright', 'playwrightWaitForTimeout', 'capabilities',
  'browserVisibilityGet', 'browserVisibilitySet', 'browserViewportSet', 'browserViewportReset',
  'recordingStart', 'recordingStatus', 'recordingCancel', 'activateTab', 'newTab',
  'finalize', 'finalizeTabs', 'listUserTabs', 'claimTab', 'markDeliverable', 'markHandoff',
  'nameSession', 'turnEnded', 'closeSession', 'cancelRequest', 'close', 'list',
] satisfies BrowserCommand['method'][]);
export const unsupportedCapabilities = Object.freeze([
  'fill (use playwright.locator.fill)', 'waitFor (use playwright.locator.waitFor)',
  'playwright.fileChooserSetFiles', 'playwright.waitForEvent.filechooser',
  'playwright.waitForLoadState.networkidle', 'playwright.waitForURL.networkidle',
  'JavaScript prompt dialogs on Electron WebContentsView',
  'CLI headless backend',
]);
export function validateBrowserCommand(value: unknown): BrowserCommand {
  const command = browserCommandSchema.parse(value);
  const timeout = 'timeoutMs' in command ? command.timeoutMs
    : command.method === 'playwright' && 'timeoutMs' in command.action ? command.action.timeoutMs : undefined;
  const limit = command.method === 'playwright'
    && ['waitForEvent', 'downloadPath'].includes(command.action.name) ? 120_000 : 30_000;
  if (timeout !== undefined && timeout > limit) throw new Error(`Browser command timeout exceeds ${limit} ms`);
  return command;
}

export { startBrowserScreenshotTransparentWindowBootstrap, TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS } from './upstream/browser/browserTransparentWindowBootstrap.js';

export function describeBrowserCommands() {
  return { supportedMethods, unsupportedCapabilities, commandSchema: z.toJSONSchema(browserCommandSchema),
    example: { operation: 'command', parameters: { pageId: '<controlled page id>', command: { method: 'playwright', action: { name: 'locator', selector: 'internal:role=button[name=\"Continue\"s]', operation: 'click' } } } } };
}
