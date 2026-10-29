import { Capacitor, registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import {
  CapacitorBarcodeScanner,
  CapacitorBarcodeScannerTypeHint,
} from "@capacitor/barcode-scanner";

const nativeKeychain = registerPlugin<{
  load(): Promise<{ value: string | null }>;
  save(options: { value: string }): Promise<void>;
  clear(): Promise<void>;
  deviceName(): Promise<{ name: string }>;
}>("ArealKeychain");

// 浏览器替身只在开发服务器中加载，发布包始终使用原生插件。
const browser =
  import.meta.env.DEV && !Capacitor.isNativePlatform()
    ? await import("./platform.browser.js")
    : null;
export const keychain = browser?.keychain ?? nativeKeychain;

export async function scanPairingLink() {
  if (browser) return browser.scanPairingLink();
  try {
    const result = await CapacitorBarcodeScanner.scanBarcode({
      hint: CapacitorBarcodeScannerTypeHint.QR_CODE,
    });
    return result.ScanResult || null;
  } catch (error) {
    if ((error as { code?: string }).code === "OS-PLUG-BARC-0006") return null;
    throw error;
  }
}

export async function observeLifecycle(onState: (active: boolean) => void) {
  if (browser) return browser.observeLifecycle(onState);
  const listener = await App.addListener("appStateChange", ({ isActive }) => onState(isActive));
  const state = await App.getState();
  onState(state.isActive);
  return () => listener.remove();
}
