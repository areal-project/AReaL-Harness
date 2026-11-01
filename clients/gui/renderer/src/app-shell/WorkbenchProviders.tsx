import type { ReactNode } from "react";
import type { SnapShotServices } from "@areal/workbench/desktop-contract/snapshots";
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
