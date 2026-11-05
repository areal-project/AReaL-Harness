import { useEffect, useState, type ReactNode } from "react";
import type { PlatformServices, QuitProgress, SnapShotServices } from "../services.js";
import { PlatformReadProvider } from "../PlatformReadContext.js";
import { GenUiWorkspace } from "../GenUiWorkspace.js";
import { QuitProgressDialog } from "../QuitProgressDialog.js";
import { UnsavedChangesProvider } from "../settings/UnsavedChanges.js";
import { ComputerControlContext } from "../ComputerControlEntry.js";
import { SnapShotProvider } from "../snapshots/SnapShotCoordinator.js";

export function WorkbenchProviders({
  bridge,
  settings,
  ready,
  openSettings,
  children,
}: {
  bridge?: SnapShotServices;
  settings?: { snapShot?: unknown; computerControlShowEntry?: boolean };
  ready?: boolean;
  openSettings: (tab: "SnapShots" | "电脑控制") => void;
  children: ReactNode;
}) {
  return (
    <SnapShotProvider
      bridge={bridge}
      settings={settings?.snapShot}
      ready={ready}
      openSettings={() => openSettings("SnapShots")}
    >
      <ComputerControlContext.Provider
        value={{
          visible: settings?.computerControlShowEntry === true,
          open: () => openSettings("电脑控制"),
        }}
      >
        {children}
      </ComputerControlContext.Provider>
    </SnapShotProvider>
  );
}

export function AppProviders({
  services,
  children,
}: {
  services: PlatformServices;
  children: ReactNode;
}) {
  const [quitProgress, setQuitProgress] = useState<QuitProgress>({ state: "idle" });
  useEffect(() => services.onQuitProgress?.(setQuitProgress), [services]);
  return (
    <PlatformReadProvider
      reads={services.reads}
      readOnly={services.capabilities?.mutations === false}
    >
      <UnsavedChangesProvider>
        <GenUiWorkspace services={services}>{children}</GenUiWorkspace>
        <QuitProgressDialog progress={quitProgress} />
      </UnsavedChangesProvider>
    </PlatformReadProvider>
  );
}
