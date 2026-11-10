import { createContext, useContext, type ReactNode } from "react";
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { useI18n } from "../i18n/IntlProvider.js";
import type { useSidebarNavigation } from "../state/useSidebarNavigation.js";

const SidebarContext = createContext<ReturnType<typeof useSidebarNavigation> | null>(null);
export const ArchiveConfirmContext = createContext<() => Promise<boolean>>(async () => false);
export function useSidebarContext() {
  const context = useContext(SidebarContext);
  if (!context) throw new Error("Sidebar context is missing");
  return context;
}

function SidebarRename() {
  const { t } = useI18n();
  const { action, rename, setRename, renameText, setRenameText } = useSidebarContext();
  return (
    <Dialog open={!!rename} onOpenChange={(open) => !open && setRename(null)}>
      <DialogContent className="max-w-[min(calc(var(--reading-width)/2),calc(100%-var(--spacing-field)*2))]">
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            if (!rename || !renameText.trim()) return;
            void action("library", { ...rename, title: renameText.trim() })
              .then(() => setRename(null))
              .catch(() => {});
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("common.navigation.rename")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            aria-label={t("common.navigation.name")}
            maxLength={200}
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
          />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>
              {t("common.navigation.cancel")}
            </DialogClose>
            <Button type="submit" disabled={!renameText.trim()}>
              {t("common.navigation.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 侧栏状态与归档确认的提供者，重命名对话框随作用域挂载。 */
export function SidebarScope(props: {
  model: ReturnType<typeof useSidebarNavigation>;
  confirmArchive: () => Promise<boolean>;
  children: ReactNode;
}) {
  return (
    <SidebarContext.Provider value={props.model}>
      <ArchiveConfirmContext.Provider value={props.confirmArchive}>
        {props.children}
        <SidebarRename />
      </ArchiveConfirmContext.Provider>
    </SidebarContext.Provider>
  );
}
