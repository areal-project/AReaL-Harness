import { createContext, useContext, type ReactNode } from "react";
import type { PlatformReadServices } from "./services.js";
const ReadOnly = createContext(false);
const LibraryReadOnly = createContext(false);
const TaskReadOnly = createContext(false);
const ConversationSubmitReadOnly = createContext(false);
const ConversationCreateReadOnly = createContext(false);
export function useConversationSubmitReadOnly() {
  return useContext(ConversationSubmitReadOnly);
}
export function useConversationCreateReadOnly() {
  return useContext(ConversationCreateReadOnly);
}
export function useTaskReadOnly() {
  return useContext(TaskReadOnly);
}
export function useLibraryReadOnly() {
  return useContext(LibraryReadOnly);
}
export function useReadOnly() {
  return useContext(ReadOnly);
}
const Reads = createContext<PlatformReadServices | undefined>(undefined);
export function PlatformReadProvider({
  reads,
  readOnly = false,
  libraryReadOnly = readOnly,
  taskReadOnly = readOnly,
  conversationSubmitReadOnly = readOnly,
  conversationCreateReadOnly = readOnly,
  children,
}: {
  reads?: PlatformReadServices;
  readOnly?: boolean;
  libraryReadOnly?: boolean;
  taskReadOnly?: boolean;
  conversationSubmitReadOnly?: boolean;
  conversationCreateReadOnly?: boolean;
  children: ReactNode;
}) {
  return (
    <ReadOnly.Provider value={readOnly}>
      <LibraryReadOnly.Provider value={libraryReadOnly}>
        <TaskReadOnly.Provider value={taskReadOnly}>
          <ConversationSubmitReadOnly.Provider value={conversationSubmitReadOnly}>
            <ConversationCreateReadOnly.Provider value={conversationCreateReadOnly}>
              <Reads.Provider value={reads}>{children}</Reads.Provider>
            </ConversationCreateReadOnly.Provider>
          </ConversationSubmitReadOnly.Provider>
        </TaskReadOnly.Provider>
      </LibraryReadOnly.Provider>
    </ReadOnly.Provider>
  );
}
export function usePlatformReads() {
  return useContext(Reads);
}

export type MediaOwner = Omit<import("@areal/client").MediaSource, "uri"> & { generation?: string };
