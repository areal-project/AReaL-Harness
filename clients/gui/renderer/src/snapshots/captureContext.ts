import { createContext, useContext } from "react";
import type { SnapShotServices } from "@areal/workbench/desktop-contract/snapshots";
export const SnapShotCaptureContext = createContext<SnapShotServices | undefined>(undefined);
export const useSnapShotCapture = () => useContext(SnapShotCaptureContext);
