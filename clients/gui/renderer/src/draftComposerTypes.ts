import type { MutableRefObject, ReactNode } from "react";
import type { Action, Data } from "./services.js";
import type { ConversationReference } from "./ConversationReferences.js";
import type { ImageAnnotationTarget } from "./imageAnnotations.js";
import type { WorktreeSelection } from "./WorktreeStarter.js";
import type { ComposerCatalogEntry } from "./prompt-editor/ComposerCatalog.js";

export type DraftComposerProps = {
  surfaceLayout?: "default" | "compact";
  project: Data;
  backendReady?: boolean;
  action: Action;
  readAction: Action;
  onOpen: (pid: string, tid: string) => Promise<void>;
  onPanel: (panel: string) => void;
  appEntries?: readonly ComposerCatalogEntry[];
  conversationReferences?: readonly ConversationReference[];
  draftKey?: string;
  prepareProject?: () => Promise<Data>;
  preparationStatus?: ReactNode;
  modelCatalogReady?: boolean;
  onAnnotate?: (target: ImageAnnotationTarget) => void;
  worktree?: WorktreeSelection;
  onWorktreeCreated?: () => void;
  prepareBrowserDraft?: MutableRefObject<(() => Promise<string | undefined>) | null>;
};
