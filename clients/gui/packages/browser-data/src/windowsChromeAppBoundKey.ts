// Adapted from ZCode. See UPSTREAM.json and NOTICE for the unsupported helper boundary.
import type { ChromeBrowserDataImportError } from './types.js';

export class WindowsChromeAppBoundImportError extends Error {
  constructor(readonly code: ChromeBrowserDataImportError) {
    super(code);
    this.name = 'WindowsChromeAppBoundImportError';
  }
}

export type WindowsChromeAppBoundKeyReader = (options: {
  chromeExecutablePath: string;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  userDataDir: string;
}) => Promise<Buffer>;

export const readWindowsChromeAppBoundKey: WindowsChromeAppBoundKeyReader = async () => {
  throw new WindowsChromeAppBoundImportError('chrome_import_not_supported');
};
