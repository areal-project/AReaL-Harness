import { createRoot } from 'react-dom/client';
// Stylesheets load before the app module so SettingsWorkspace.css (imported through App)
// is emitted after workbench.css and wins over the legacy `.settings-*` rules still there.
import './styles.css';
import './workbench.css';
import { TooltipProvider } from './components/ui/tooltip.js';
import { App } from './App.js';
import type { PlatformServices } from './services.js';
// This is the only module allowed to access the desktop preload object.
const services = (window as unknown as {
    arealDesktop: PlatformServices;
}).arealDesktop;
if (!services)
    document.getElementById('root')!.textContent = '请通过 AReaL Harness 桌面入口打开此界面。';
else
    createRoot(document.getElementById('root')!).render(<TooltipProvider><App services={services}/></TooltipProvider>);
