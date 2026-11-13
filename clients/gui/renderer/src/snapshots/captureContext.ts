import { createContext, useContext } from "react";
import type { SnapShotServices } from "../services.js";
export const SnapShotCaptureContext = createContext<SnapShotServices | undefined>(undefined);
export const useSnapShotCapture = () => useContext(SnapShotCaptureContext);
