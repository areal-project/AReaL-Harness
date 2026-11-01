import { useEffect } from "react";
let activeDraft: string | undefined;
export const currentSnapShotDraft = () => activeDraft;
export function useSnapShotDraft(key: string) {
  useEffect(() => {
    activeDraft = key;
  }, [key]);
}
