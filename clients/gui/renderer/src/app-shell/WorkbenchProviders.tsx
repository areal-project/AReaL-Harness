import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { PlatformServices, QuitProgress, SnapShotServices } from "../services.js";
import { PlatformReadProvider } from "../PlatformReadContext.js";
import { GenUiWorkspace } from "../GenUiWorkspace.js";
import { QuitProgressDialog } from "../QuitProgressDialog.js";
import { UnsavedChangesProvider } from "../settings/UnsavedChanges.js";
import { ComputerControlContext } from "../ComputerControlEntry.js";
import { OpenSettingsContext } from "../settings/openSettingsContext.js";
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
  openSettings: (tab: string) => void;
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
        <OpenSettingsContext.Provider value={openSettings}>{children}</OpenSettingsContext.Provider>
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
  // Host 的授权和资料库来源在连接后才到达，父级 Provider 也必须观察能力变化。
  const flags = useSyncExternalStore(
    (notify) => services.onState(() => notify()),
    () => {
      const capabilities = services.capabilities;
      const readOnly = capabilities?.mutations === false;
      const libraryReadOnly =
        capabilities?.library === false || (capabilities?.library === undefined && readOnly);
      const taskReadOnly =
        capabilities?.taskManage === false || (capabilities?.taskManage === undefined && readOnly);
      const conversationSubmitReadOnly =
        capabilities?.conversationSubmit === false ||
        (capabilities?.conversationSubmit === undefined && readOnly);
      const conversationCreateReadOnly =
        capabilities?.conversationCreate === false ||
        (capabilities?.conversationCreate === undefined && readOnly);
      return (
        Number(readOnly) |
        (Number(libraryReadOnly) << 1) |
        (Number(taskReadOnly) << 2) |
        (Number(conversationSubmitReadOnly) << 3) |
        (Number(conversationCreateReadOnly) << 4)
      );
    },
  );
  return (
    <PlatformReadProvider
      reads={services.reads}
      readOnly={(flags & 1) !== 0}
      libraryReadOnly={(flags & 2) !== 0}
      taskReadOnly={(flags & 4) !== 0}
      conversationSubmitReadOnly={(flags & 8) !== 0}
      conversationCreateReadOnly={(flags & 16) !== 0}
    >
      <UnsavedChangesProvider>
        <GenUiWorkspace services={services}>{children}</GenUiWorkspace>
        <QuitProgressDialog progress={quitProgress} />
      </UnsavedChangesProvider>
    </PlatformReadProvider>
  );
}
