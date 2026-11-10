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
