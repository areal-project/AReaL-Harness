import { expect, it, vi } from "vite-plus/test";
import { createDesktopServices, type DesktopBridge } from "./desktop-services.js";

it("uses the newer native state when the initial snapshot arrives late", async () => {
  const page = new EventTarget();
  vi.stubGlobal("window", page);
  try {
    let resolveBaseline: (value: unknown) => void = () => {};
    const baseline = new Promise<unknown>((resolve) => {
      resolveBaseline = resolve;
    });
    const unsubscribe = vi.fn();
    let deliver: (value: unknown) => void = () => {
      throw new Error("Native state listener was not installed");
    };
    const bridge = {
      nativeState: () => baseline,
      onNativeState(listener: (value: unknown) => void) {
        deliver = listener;
        return unsubscribe;
      },
    } satisfies Pick<DesktopBridge, "nativeState" | "onNativeState">;
    const services = createDesktopServices(bridge as unknown as DesktopBridge);
    const observe = vi.fn();
    services.onState(observe);
    const reading = services.snapshot();
    const fresh = { projects: [], serviceSummary: { state: "running", busy: false } };
    deliver(fresh);
    resolveBaseline({ projects: [], serviceSummary: { state: "stopped", busy: false } });
    await expect(reading).resolves.toEqual(fresh);
    expect(observe).toHaveBeenCalledExactlyOnceWith(fresh);
    page.dispatchEvent(new Event("pagehide"));
    expect(unsubscribe).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
