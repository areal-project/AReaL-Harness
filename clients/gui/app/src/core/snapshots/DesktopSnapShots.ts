import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Electron from "electron";
import {
  DEFAULT_SNAP_SHOT_SETTINGS,
  isModifierPairShortcut,
  readSnapShotSettings,
  snapShotModifierPairLabel,
  snapShotShortcutModifierPair,
  type SnapShotSettings,
  type SnapShotShortcut,
  type DesktopSnapShotState,
  type DesktopSnapShotEvent,
  type DesktopSnapShotSetupAction,
  type DesktopSnapShotShortcutAvailability,
  type DesktopSnapShotAnimationDestination,
  type SnapShotSource,
} from "@areal/workbench/desktop-contract/snapshots";
import { activeWindow } from "./ActiveWindow.js";
import { captureMacWindowSnapshot } from "./MacSnapShot.js";
import { startMacModifierPairShortcutProcess } from "./MacModifierPairShortcutProcess.js";
import { makeSnapShotAccessibilityProcessPool } from "./SnapShotAccessibilityProcess.js";
import { SnapShotTransition } from "./SnapShotTransition.js";
import { PendingSnapShots } from "./PendingSnapShots.js";
import { toElectronAccelerator, snapShotShortcutSystemConflict } from "./snapShot.js";

type Options = {
  directory: string;
  workerPath: string;
  window: () => Electron.BrowserWindow | null;
  revealWindow: () => void;
  emit: (event: DesktopSnapShotEvent) => void;
};

export class DesktopSnapShots {
  private settings: SnapShotSettings = { ...DEFAULT_SNAP_SHOT_SETTINGS };
  private configuration = Promise.resolve();
  private applied = "";
  private registration: { stop: () => void; accelerator?: string } | undefined;
  private registrationPending = false;
  private shortcutMessage: string | null = null;
  private message: string | null = null;
  private suppressed = false;
  private capture: Promise<void> | undefined;
  private lastCapture = 0;
  private closed = false;
  private verified = false;
  private flightId: string | undefined;
  private readonly accessibility;
  private readonly transition = new SnapShotTransition();
  readonly pending: PendingSnapShots;

  constructor(private readonly options: Options) {
    this.pending = new PendingSnapShots(options.directory);
    this.accessibility = makeSnapShotAccessibilityProcessPool(options.workerPath);
  }

  configure(raw: unknown, force = false): Promise<void> {
    const settings = readSnapShotSettings(raw);
    const serialized = JSON.stringify(settings);
    if (!force && this.applied === serialized) return this.configuration;
    this.applied = serialized;
    this.configuration = this.configuration.then(async () => {
      if (this.closed) return;
      const registrationChanged =
        force ||
        settings.snapShotEnabled !== this.settings.snapShotEnabled ||
        JSON.stringify(settings.snapShotShortcut) !==
          JSON.stringify(this.settings.snapShotShortcut);
      this.settings = settings;
      if (
        settings.snapShotEnabled &&
        settings.snapShotIncludeAccessibility &&
        process.platform === "darwin"
      )
        this.accessibility.warm();
      else this.accessibility.cool();
      if (!settings.snapShotEnabled || !settings.snapShotAnimations) this.transition.dispose();
      if (!registrationChanged) return;
      this.registration?.stop();
      this.registration = undefined;
      this.shortcutMessage = null;
      this.verified = false;
      if (!settings.snapShotEnabled || this.suppressed || process.platform !== "darwin") {
        this.changed();
        return;
      }
      this.registrationPending = true;
      this.changed();
      try {
        const shortcut = settings.snapShotShortcut;
        if (isModifierPairShortcut(shortcut)) {
          const stop = await startMacModifierPairShortcutProcess(
            snapShotShortcutModifierPair(shortcut),
            () => this.trigger(),
            (error) => {
              this.registration = undefined;
              this.shortcutMessage = error.message;
              this.changed();
            },
          );
          if (this.closed) stop();
          else this.registration = { stop };
        } else {
          const conflict = snapShotShortcutSystemConflict(shortcut);
          if (conflict) throw new Error(conflict);
          const accelerator = toElectronAccelerator(shortcut);
          if (!Electron.globalShortcut.register(accelerator, () => this.trigger()))
            throw new Error("This shortcut is already used by the system or another app.");
          this.registration = {
            accelerator,
            stop: () => Electron.globalShortcut.unregister(accelerator),
          };
        }
      } catch (error) {
        this.shortcutMessage = error instanceof Error ? error.message : String(error);
      } finally {
        this.registrationPending = false;
        this.changed();
      }
    });
    return this.configuration;
  }

  private changed(): void {
    if (!this.closed) this.options.emit({ type: "shortcut-changed" });
  }

  getSnapShotState(): DesktopSnapShotState {
    const shortcut = this.settings.snapShotShortcut;
    return {
      mode: process.platform === "darwin" ? "direct" : "unavailable",
      settings: this.settings,
      shortcut,
      shortcutRegistered: !!this.registration,
      shortcutPending: this.registrationPending,
      shortcutCanRetry:
        this.settings.snapShotEnabled && !this.registration && !this.registrationPending,
      shortcutLabel: isModifierPairShortcut(shortcut)
        ? snapShotModifierPairLabel(
            snapShotShortcutModifierPair(shortcut),
            process.platform === "darwin",
          )
        : toElectronAccelerator(shortcut),
      shortcutMessage: this.shortcutMessage,
      ...(process.platform === "darwin"
        ? {
            macPermissions: {
              screenRecording:
                Electron.systemPreferences.getMediaAccessStatus("screen") === "granted",
              accessibility: Electron.systemPreferences.isTrustedAccessibilityClient(false),
            },
          }
        : {}),
      shortcutVerified: this.verified,
      message:
        process.platform === "darwin"
          ? this.message
          : "SnapShots is not available on this platform.",
    };
  }

  async checkSnapShotShortcut(
    shortcut: SnapShotShortcut,
  ): Promise<DesktopSnapShotShortcutAvailability> {
    await this.configuration;
    if (process.platform !== "darwin")
      return { available: false, message: "SnapShots is not available on this platform." };
    if (isModifierPairShortcut(shortcut)) return { available: true, message: null };
    const conflict = snapShotShortcutSystemConflict(shortcut);
    if (conflict) return { available: false, message: conflict };
    const accelerator = toElectronAccelerator(shortcut);
    if (this.registration?.accelerator === accelerator) return { available: true, message: null };
    try {
      const available = Electron.globalShortcut.register(accelerator, () => {});
      if (available) Electron.globalShortcut.unregister(accelerator);
      return {
        available,
        message: available ? null : "This shortcut is already used by the system or another app.",
      };
    } catch (error) {
      return { available: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  setSnapShotShortcutSuppressed(suppressed: boolean): Promise<void> {
    const changed = this.suppressed !== suppressed;
    this.suppressed = suppressed;
    const window = this.options.window();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
      window.webContents.setIgnoreMenuShortcuts(suppressed);
    if (!changed || this.closed) return Promise.resolve();
    if (suppressed) {
      this.registration?.stop();
      this.registration = undefined;
      return this.configuration.then(() => {
        this.registration?.stop();
        this.registration = undefined;
        this.changed();
      });
    }
    return this.configure(this.settings, true);
  }

  private trigger(): void {
    if (
      this.suppressed ||
      this.closed ||
      !this.settings.snapShotEnabled ||
      this.capture ||
      Date.now() - this.lastCapture < 200
    )
      return;
    this.verified = true;
    void this.captureSnapShot().catch(() => {});
  }

  captureSnapShot(): Promise<void> {
    if (this.closed || !this.settings.snapShotEnabled)
      return Promise.reject(new Error("SnapShots is disabled."));
    if (process.platform !== "darwin")
      return Promise.reject(new Error("SnapShots is not available on this platform."));
    if (this.capture) return this.capture;
    this.lastCapture = Date.now();
    const id = randomUUID();
    const settings = this.settings;
    this.options.emit({ type: "requested", id });
    this.capture = this.performCapture(id, settings)
      .catch((error) => {
        this.transition.dismiss(id);
        this.message = error instanceof Error ? error.message : String(error);
        if (!this.closed) this.options.emit({ type: "failed", id, message: this.message });
        throw error;
      })
      .finally(() => {
        this.capture = undefined;
      });
    return this.capture;
  }

  private async performCapture(id: string, settings: SnapShotSettings): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "areal-snapshot-"));
    try {
      const active = await activeWindow();
      if (!active) throw new Error("No foreground window is available to capture.");
      this.options.emit({ type: "started", id });
      const { png } = await captureMacWindowSnapshot(active, join(directory, "capture.png"), {
        width: 2560,
        height: 1600,
      });
      if (png.length > 16 * 1024 * 1024)
        throw new Error("The screenshot exceeds the attachment limit.");
      if (this.closed) return;
      const imageSize = Electron.nativeImage.createFromBuffer(png).getSize();
      const ax = settings.snapShotIncludeAccessibility
        ? this.accessibility.read({
            active,
            platform: process.platform,
            sourceTitle: active.title,
            imageSize,
          }).result
        : Promise.resolve(undefined);
      const reducedMotion = Electron.systemPreferences.getAnimationSettings().prefersReducedMotion;
      const animate = settings.snapShotAnimations && !reducedMotion;
      this.flightId = animate ? id : undefined;
      if (animate || settings.snapShotFlash) {
        await this.transition
          .begin(
            id,
            active.bounds,
            "data:image/png;base64," + png.toString("base64"),
            settings.snapShotFlash,
            this.options.window()?.getBounds(),
          )
          .catch(() => {});
        if (!animate) setTimeout(() => this.transition.dismiss(id), 300).unref();
      }
      const icon = active.owner.path
        ? await Electron.app
            .getFileIcon(active.owner.path, { size: "normal" })
            .then((value) => value.resize({ width: 32, height: 32 }).toDataURL())
            .catch(() => undefined)
        : undefined;
      const context = await ax;
      const source: SnapShotSource = {
        kind: "snap-shot",
        capturedAt: new Date().toISOString(),
        appName: active.owner.name.trim().slice(0, 255) || "Window",
        windowTitle: active.title.trim().slice(0, 1000),
        ...context,
        ...(active.owner.bundleId ? { appIdentifier: active.owner.bundleId.slice(0, 255) } : {}),
        ...(icon && icon.length <= 100000 ? { appIconDataUrl: icon } : {}),
      };
      await this.pending.add(
        {
          id,
          name: (source.windowTitle || source.appName).slice(0, 120) + ".png",
          mimeType: "image/png",
          sizeBytes: png.length,
          source,
        },
        png,
      );
      this.message = null;
      if (this.closed) return;
      this.options.revealWindow();
      this.options.emit({ type: "ready", id });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async requestSnapShotPermissions(includeAccessibility: boolean): Promise<void> {
    if (process.platform !== "darwin")
      throw new Error("SnapShots is not available on this platform.");
    if (Electron.systemPreferences.getMediaAccessStatus("screen") !== "granted") {
      await Electron.desktopCapturer
        .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
        .catch(() => undefined);
      if (Electron.systemPreferences.getMediaAccessStatus("screen") !== "granted")
        await Electron.shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
        );
    }
    if (includeAccessibility && !Electron.systemPreferences.isTrustedAccessibilityClient(true))
      await Electron.shell.openExternal(
        "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
      );
    this.changed();
  }

  async setupSnapShot(action: DesktopSnapShotSetupAction): Promise<void> {
    if (process.platform !== "darwin")
      throw new Error("SnapShots is not available on this platform.");
    if (action === "retry-shortcut") {
      await this.configure(this.settings, true);
      return;
    }
    if (action === "allow-accessibility") {
      if (!Electron.systemPreferences.isTrustedAccessibilityClient(true))
        await Electron.shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        );
      this.changed();
      return;
    }
    if (action === "allow-screen-recording") {
      await this.requestSnapShotPermissions(false);
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "areal-snapshot-test-"));
    try {
      const active = await activeWindow();
      if (!active) throw new Error("No foreground window is available to capture.");
      await captureMacWindowSnapshot(active, join(directory, "test.png"), {
        width: 2560,
        height: 1600,
      });
      this.message = null;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async setSnapShotAnimationDestination(
    destination: DesktopSnapShotAnimationDestination,
  ): Promise<void> {
    if (this.flightId !== destination.id) return;
    const window = this.options.window();
    if (!window || window.isDestroyed()) return;
    const content = window.getContentBounds();
    const zoom = window.webContents.getZoomFactor();
    const { x, y, width, height } = destination.viewportFrame;
    this.transition.animateTo(destination.id, {
      ...destination,
      frame: {
        x: content.x + x * zoom,
        y: content.y + y * zoom,
        width: width * zoom,
        height: height * zoom,
      },
      relativeFrame: {
        x: (x * zoom) / content.width,
        y: (y * zoom) / content.height,
        width: (width * zoom) / content.width,
        height: (height * zoom) / content.height,
      },
      scaleFactor: zoom,
      borderWidth: destination.borderWidth * zoom,
      cornerRadius: destination.cornerRadius * zoom,
    });
    await this.transition.waitForLanding(destination.id);
  }

  dismissSnapShotAnimation(id: string): void {
    if (this.flightId === id) this.flightId = undefined;
    this.transition.dismiss(id);
  }

  async acknowledgeSnapShot(id: string): Promise<void> {
    await this.pending.acknowledge(id);
    await this.transition.complete(id);
    if (this.flightId === id) this.flightId = undefined;
  }

  close(): void {
    this.closed = true;
    void this.setSnapShotShortcutSuppressed(false);
    this.registration?.stop();
    this.registration = undefined;
    this.accessibility.close();
    this.transition.dispose();
  }
}
