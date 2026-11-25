import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import type { HostReadCache } from "@areal/client";
import "./styles.css";
import "./workbench.css";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { App } from "./App.js";
import { HostReadStatus } from "./HostReadStatus.js";
import { createHostReadServices, disposeHostReadServices } from "./host-services.js";
import { ApplicationIntlProvider } from "./i18n/IntlProvider.js";
import type { PlatformServices } from "./services.js";
import { pairedTransport, type PairedConnection } from "./paired-transport.js";

const pairedServices = new WeakMap<
  PairedConnection,
  { hostId: string | undefined; services: PlatformServices }
>();

export function disposeSharedPairedWorkbench(
  client: PairedConnection,
  expectedServices?: PlatformServices,
) {
  const entry = pairedServices.get(client);
  if (!entry || (expectedServices && entry.services !== expectedServices)) return;
  disposeHostReadServices(entry.services);
  pairedServices.delete(client);
}

function resolvePairedServices(
  client: PairedConnection,
  hostId?: string,
  cache?: HostReadCache,
): PlatformServices {
  const existing = pairedServices.get(client);
  if (existing && existing.hostId === hostId) return existing.services;
  if (existing) disposeHostReadServices(existing.services);
  const services = createHostReadServices(undefined, {
    bootstrap: () => Promise.reject(new Error("Mobile uses the paired connection")),
    origin: location.origin,
    transport: pairedTransport(client),
    cache,
    events: window,
  });
  pairedServices.set(client, { hostId, services });
  return services;
}

/**
 * 手机与远程网页上的共享界面：与桌面、浏览器同一个 App，经已配对连接读写 Host。
 * 跨项目领域由 Host 按连接授权开放，未授权的入口按不可用降级。
 */
export function SharedPairedWorkbench({
  client,
  hostId,
  cache,
  viewKey,
}: {
  client: PairedConnection;
  hostId?: string;
  cache?: HostReadCache;
  viewKey?: number;
}) {
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const stableCache: HostReadCache | undefined = cache
    ? {
        loadShell: async () => cacheRef.current?.loadShell?.(),
        saveShell: (shell) => cacheRef.current?.saveShell?.(shell),
        loadSession: async (target) => cacheRef.current?.loadSession?.(target),
        saveSession: (session) => cacheRef.current?.saveSession?.(session),
      }
    : undefined;
  const services = resolvePairedServices(client, hostId, stableCache);
  useEffect(() => {
    return () => {
      // 组件树因解绑/切换设备卸载时销毁旧 HostClient，避免后台重连定时器残留。
      disposeSharedPairedWorkbench(client, services);
    };
  }, [client, hostId, services]);
  return (
    <TooltipProvider>
      {services.reads && <HostReadStatus reads={services.reads} />}
      <App key={viewKey ?? 0} services={services} />
    </TooltipProvider>
  );
}

/** 给非 React 的旧页面（远程网页）挂载共享界面。 */
export function mountSharedPairedWorkbench(element: HTMLElement, client: PairedConnection) {
  createRoot(element).render(
    <ApplicationIntlProvider>
      <SharedPairedWorkbench client={client} />
    </ApplicationIntlProvider>,
  );
}
