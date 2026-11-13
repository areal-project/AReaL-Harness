import type { PermissionPreset } from "./permissions.js";
import { useEffect, useState, useRef, type RefObject } from "react";
import { composerDraftStorage, flushComposerDrafts } from "./composerDraftStorage.js";
import { sending, attachmentDrafts } from "./Composer.js";
import type { LexicalChatInputHandle } from "./LexicalChatInput.js";
import type { ComposerDraftAttachment } from "./ComposerAttachments.js";

export function useDraftComposerState(
  key: string,
  api: RefObject<LexicalChatInputHandle | null>,
  defaultPermission: PermissionPreset,
) {
  const [profileSelection, setProfileSelection] = useState(
    () => localStorage.getItem(`${key}:profile`) ?? "",
  );
  useEffect(() => flushComposerDrafts, [key]);
  const [text, setText] = useState(() => composerDraftStorage.getItem(key) ?? "");
  const [draftError, setDraftError] = useState("");
  useEffect(() => {
    const refreshDraft = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== key || sending.has(key)) return;
      const draft = composerDraftStorage.getItem(key) ?? "";
      setProfileSelection(localStorage.getItem(`${key}:profile`) ?? "");
      api.current?.setText(draft);
      setText(draft);
      setFiles(attachmentDrafts.get(key) ?? []);
      api.current?.focus();
    };
    window.addEventListener("areal-draft-change", refreshDraft);
    return () => window.removeEventListener("areal-draft-change", refreshDraft);
  }, [key]);
  const [files, setFiles] = useState<ComposerDraftAttachment[]>(
    () => attachmentDrafts.get(key) ?? [],
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [efforts, setEfforts] = useState<Record<string, string>>(() =>
    localStorage.getItem(`${key}:model`) !== null
      ? JSON.parse(localStorage.getItem(`${key}:efforts`) ?? "{}")
      : {},
  );
  const [requestedServiceTier, setRequestedServiceTier] = useState<"fast" | "default" | undefined>(
    () => {
      const saved = localStorage.getItem(`${key}:service-tier`);
      return saved === "fast" || saved === "default" ? saved : undefined;
    },
  );
  const [permission, setPermission] = useState<PermissionPreset>(() => {
    const saved = localStorage.getItem(`${key}:permission`);
    return saved === "ask" || saved === "autoReview" || saved === "fullAccess"
      ? saved
      : defaultPermission;
  });
  const [plan, setPlan] = useState(() => localStorage.getItem(`${key}:plan`) === "true");
  const [goalMode, setGoalMode] = useState(() => localStorage.getItem(`${key}:goal`) === "true");
  const changeGoalMode = (enabled: boolean) => {
    setGoalMode(enabled);
    localStorage.setItem(`${key}:goal`, String(enabled));
    api.current?.focus();
  };
  return {
    text,
    setText,
    draftError,
    setDraftError,
    files,
    setFiles,
    profileSelection,
    setProfileSelection,
    efforts,
    setEfforts,
    requestedServiceTier,
    setRequestedServiceTier,
    mounted,
    permission,
    setPermission,
    plan,
    setPlan,
    goalMode,
    changeGoalMode,
  };
}
