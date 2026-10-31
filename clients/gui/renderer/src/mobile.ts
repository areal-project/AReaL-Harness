import { mobileMessages } from "./i18n/messages/mobile.js";

type ProbeConfig = {
  relay: string;
  host: string;
  room: string;
  invite: string;
  mode: "handshake" | "pin-mismatch" | "tls-reject";
};
type ProbeBridge = { postMessage(value: unknown): void };

declare global {
  interface Window {
    __AREAL_MOBILE_PROBE__?: ProbeConfig;
    __AREAL_MOBILE_PRODUCT__?: {
      mode: "pair" | "restore" | "lifecycle" | "revoked" | "clear" | "unpaired";
      link?: string;
    };
    webkit?: { messageHandlers?: { arealProbe?: ProbeBridge; arealProduct?: ProbeBridge } };
  }
}

const capabilities: ProbeCapabilities = {
  secureContext: window.isSecureContext,
  random: typeof globalThis.crypto?.getRandomValues === "function",
  subtle: typeof globalThis.crypto?.subtle === "object",
  abortSignalTimeout: typeof globalThis.AbortSignal?.timeout === "function",
  promiseWithResolvers: typeof Reflect.get(Promise, "withResolvers") === "function",
};
const compatible = Object.values(capabilities).every(Boolean);
if (!compatible) {
  const status = document.getElementById("status");
  if (status)
    status.textContent =
      mobileMessages["mobile.unsupportedWebView"][
        navigator.language.startsWith("zh") ? "zh-CN" : "en"
      ];
}
const config = window.__AREAL_MOBILE_PROBE__;
delete window.__AREAL_MOBILE_PROBE__;
const bridge = window.webkit?.messageHandlers?.arealProbe;
if (config && bridge) {
  void import("./mobile-probe")
    .then(({ runProbe }) => runProbe(config, bridge, capabilities))
    .catch((error: unknown) =>
      bridge.postMessage({
        kind: "result",
        result: {
          status: "failure",
          phase: "module-load",
          origin: location.origin,
          capabilities,
          webSocketOpened: false,
          diagnostic: "Production channel module could not load",
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
      }),
    );
} else if (compatible) {
  void import("./mobile/MobileApp").then(async ({ mountMobileApp }) => {
    mountMobileApp();
    const product = window.__AREAL_MOBILE_PRODUCT__;
    delete window.__AREAL_MOBILE_PRODUCT__;
    const output = window.webkit?.messageHandlers?.arealProduct;
    if (product && output) {
      const { runProduct } = await import("./mobile/product-driver");
      await runProduct(product, output);
    }
  });
}

type ProbePhase =
  | "module-load"
  | "capabilities"
  | "identity"
  | "relay"
  | "noise"
  | "hello"
  | "ready"
  | "project.list";
type ProbeCapabilities = {
  secureContext: boolean;
  random: boolean;
  subtle: boolean;
  abortSignalTimeout: boolean;
  promiseWithResolvers: boolean;
};
type ProbeResult =
  | {
      status: "success";
      phase: "project.list";
      origin: string;
      capabilities: ProbeCapabilities;
      webSocketOpened: boolean;
      verified: { hostPin: boolean; apiVersion: string; ready: boolean; projectIds: string[] };
    }
  | {
      status: "failure";
      phase: ProbePhase;
      origin: string;
      capabilities: ProbeCapabilities;
      webSocketOpened: boolean;
      errorName: string;
      diagnostic: string;
    };

export type { ProbeConfig, ProbeBridge, ProbeCapabilities, ProbePhase, ProbeResult };
