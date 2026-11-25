import { markRendererStartup } from "./state/startupTiming.js";
markRendererStartup("module_eval");
import { BrowserHostAuthStatus } from "./BrowserHostAuthStatus.js";
import {
  getApplicationPreferences,
  subscribeApplicationPreferences,
} from "./settings/applicationPreferences.js";
import { ApplicationIntlProvider } from "./i18n/IntlProvider.js";
import { createRoot } from "react-dom/client";
// Stylesheets load before the app module so SettingsWorkspace.css (imported through App)
// is emitted after workbench.css and wins over the legacy `.settings-*` rules still there.
import "./styles.css";
import "./workbench.css";
import { TooltipProvider } from "./components/ui/tooltip.js";
import { App } from "./App.js";
import { initializeDesktopServices } from "./desktop-services.js";
import { HostReadStatus } from "./HostReadStatus.js";
import { createHostReadServices } from "./host-services.js";
import { call } from "./services.js";
const desktop = initializeDesktopServices(
  () => getApplicationPreferences().locale,
  subscribeApplicationPreferences,
);
async function start() {
  const services = createHostReadServices(desktop, {
    bootstrap:
      desktop?.getHostTicket ??
      (async () => {
        const { getBrowserHostBootstrap } = await import("./browser-host-bootstrap.js");
        return getBrowserHostBootstrap();
      }),
    origin: desktop ? "areal-ui://app" : location.origin,
    events: window,
  });
  // 读模型与命令探针：让桌面冒烟脚本观测与界面同源的 Host 读模型并复用同一命令路由，不增加额外 WebSocket。
  Object.defineProperty(globalThis, Symbol.for("areal.host.read"), {
    value: Object.freeze({
      snapshot: () => services.snapshot(),
      reads: services.reads,
      call: (name: Parameters<typeof call>[1], params: Parameters<typeof call>[2]) =>
        call(services, name, params),
    }),
    configurable: true,
  });
  createRoot(document.getElementById("root")!).render(
    <ApplicationIntlProvider>
      <TooltipProvider>
        {!desktop && <BrowserHostAuthStatus />}
        {services.reads && <HostReadStatus reads={services.reads} />}
        <App services={services} />
      </TooltipProvider>
    </ApplicationIntlProvider>,
  );
  markRendererStartup("render_root");
}
void start();
