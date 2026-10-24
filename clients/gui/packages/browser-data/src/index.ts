import { importChromeBrowserData as importChromeBrowserDataFromProfile } from './browserDataManager.js';
import type { ChromeBrowserDataImportResult } from './types.js';

export type { ChromeBrowserDataImportError, ChromeBrowserDataImportResult } from './types.js';

export interface ChromeBrowserDataImportOptions {
  targetSession: Electron.Session;
  registerWebContents: (contents: Electron.WebContents) => () => void;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}

export async function importChromeBrowserData(options: ChromeBrowserDataImportOptions): Promise<ChromeBrowserDataImportResult> {
  if (process.type !== 'browser') throw new Error('browser_data_main_process_only');
  if (process.platform !== 'darwin') {
    return {
      success: false,
      cookies: { imported: 0, skipped: 0, failed: 0 },
      localStorage: { originsImported: 0, entriesImported: 0, originsSkipped: 0, originsFailed: 0 },
      error: 'chrome_import_not_supported',
    };
  }
  return importChromeBrowserDataFromProfile({
    targetSession: options.targetSession,
    registerWebContents: options.registerWebContents,
    logger: options.logger,
  });
}
