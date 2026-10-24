import { BrowserWindow } from 'electron';
import type { WebContentsView } from 'electron';
import { startBrowserScreenshotTransparentWindowBootstrap, TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS } from './upstream/browser/browserTransparentWindowBootstrap.js';
import { waitForDelay } from './recordingScenario.js';

export async function acquireBackgroundSurface(input: {
  owner: BrowserWindow;
  view: WebContentsView;
  viewport: { width: number; height: number };
  signal: AbortSignal;
  restoreVisible(): boolean;
}): Promise<{ release(): void }> {
  const bounds = input.view.getBounds();
  const window = new BrowserWindow({ show: false, frame: false, focusable: false,
    skipTaskbar: true, width: input.viewport.width, height: input.viewport.height,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false } });
  window.setIgnoreMouseEvents(true);
  input.owner.contentView.removeChildView(input.view);
  window.contentView.addChildView(input.view);
  input.view.setBounds({ x: 0, y: 0, ...input.viewport });
  input.view.setVisible(true);
  let released = false;
  const bootstrap = startBrowserScreenshotTransparentWindowBootstrap({
    win: window, enabled: true, windowId: window.id,
    webContentsId: input.view.webContents.id, requestId: 'areal-command-capture',
  });
  const release = () => {
    if (released) return;
    released = true;
    input.signal.removeEventListener('abort', release);
    if (!window.isDestroyed()) window.contentView.removeChildView(input.view);
    if (!input.view.webContents.isDestroyed() && !input.owner.isDestroyed()) {
      input.owner.contentView.addChildView(input.view);
      input.view.setBounds(bounds);
      input.view.setVisible(input.restoreVisible());
    }
    if (bootstrap) bootstrap.release();
    if (!window.isDestroyed()) window.destroy();
  };
  input.signal.addEventListener('abort', release, { once: true });
  if (!bootstrap || !await waitForDelay(TRANSPARENT_WINDOW_PRESENTATION_GRACE_MS, input.signal)) {
    release();
    throw new Error('Browser capture surface unavailable');
  }
  return { release };
}
