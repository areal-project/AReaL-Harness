import { createRoot } from "react-dom/client";
import "./styles.css";
import "./workbench.css";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { App } from "./App.js";
import { HostReadStatus } from "./HostReadStatus.js";
import { createHostReadServices } from "./host-services.js";
import { ApplicationIntlProvider } from "./i18n/IntlProvider.js";
import type { PlatformServices } from "./services.js";
import { pairedTransport, type PairedConnection } from "./paired-transport.js";

let services: PlatformServices | undefined;

/**
 * 手机与远程网页上的共享界面：与桌面、浏览器同一个 App，经已配对连接读写 Host。
 * 跨项目领域暂只开放给本机连接，远程设备上这些入口按不可用降级。
 */
export function SharedPairedWorkbench({ client }: { client: PairedConnection }) {
  services ??= createHostReadServices(undefined, {
    bootstrap: () => Promise.reject(new Error("Mobile uses the paired connection")),
    origin: location.origin,
    transport: pairedTransport(client),
    writes: true,
    domains: new Set(),
    events: window,
  });
  return (
    <TooltipProvider>
      {services.reads && <HostReadStatus reads={services.reads} />}
      <App services={services} />
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
