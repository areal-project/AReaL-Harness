import { createContext, useContext, type ReactNode } from "react";
import type { PlatformReadServices } from "./services.js";
const ReadOnly = createContext(false);
export function useReadOnly() {
  return useContext(ReadOnly);
}
const Reads = createContext<PlatformReadServices | undefined>(undefined);
export function PlatformReadProvider({
  reads,
  readOnly = false,
  children,
}: {
  reads?: PlatformReadServices;
  readOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <ReadOnly.Provider value={readOnly}>
      <Reads.Provider value={reads}>{children}</Reads.Provider>
    </ReadOnly.Provider>
  );
}
export function usePlatformReads() {
  return useContext(Reads);
}

export type MediaOwner = Omit<import("@areal/client").MediaSource, "uri"> & { generation?: string };
