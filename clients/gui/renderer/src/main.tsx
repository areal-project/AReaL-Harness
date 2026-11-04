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
import { hostReadsEnabled, HostReadStatus } from "./HostReadStatus.js";
const services = initializeDesktopServices(
  () => getApplicationPreferences().locale,
  subscribeApplicationPreferences,
);
if (!services)
  document.getElementById("root")!.textContent = "请通过 AReaL Harness 桌面入口打开此界面。";
else {
  createRoot(document.getElementById("root")!).render(
    <ApplicationIntlProvider>
      <TooltipProvider>
        {hostReadsEnabled() && services.getHostTicket && (
          <HostReadStatus bootstrap={services.getHostTicket} />
        )}
        <App services={services} />
      </TooltipProvider>
    </ApplicationIntlProvider>,
  );
}
