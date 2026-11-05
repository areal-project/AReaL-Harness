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
import { hostReadsEnabled, hostWritesEnabled, HostReadStatus } from "./HostReadStatus.js";
import { hostDomains } from "./host-workbench.js";
const desktop = initializeDesktopServices(
  () => getApplicationPreferences().locale,
  subscribeApplicationPreferences,
);
async function start() {
  let services = desktop;
  if (!desktop || (hostReadsEnabled() && desktop.getHostTicket)) {
    const { createHostReadServices } = await import("./host-services.js");
    services = createHostReadServices(desktop, {
      bootstrap:
        desktop?.getHostTicket ??
        (async () => {
          const { getBrowserHostBootstrap } = await import("./browser-host-bootstrap.js");
          return getBrowserHostBootstrap();
        }),
      origin: desktop ? "areal-ui://app" : location.origin,
      writes: desktop !== undefined && hostWritesEnabled(),
      domains: desktop ? hostDomains() : new Set(),
      events: window,
    });
  }
  if (!services) throw new Error("Platform services unavailable");
  createRoot(document.getElementById("root")!).render(
    <ApplicationIntlProvider>
      <TooltipProvider>
        {!desktop && <BrowserHostAuthStatus />}
        {services.reads && <HostReadStatus reads={services.reads} />}
        <App services={services} />
      </TooltipProvider>
    </ApplicationIntlProvider>,
  );
}
void start();
