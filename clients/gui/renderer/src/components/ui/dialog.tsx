import type { ComponentProps } from "react";
import { useI18n } from "../../i18n/IntlProvider.js";
import { DialogContent as Content, DialogFooter as Footer } from "@areal/ui/wip";
export { Dialog, DialogClose, DialogDescription, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger } from "@areal/ui/wip";
export function DialogContent(props: ComponentProps<typeof Content>) { const { t } = useI18n(); return <Content closeLabel={t("common.closeDialog")} {...props} />; }
export function DialogFooter(props: ComponentProps<typeof Footer>) { const { t } = useI18n(); return <Footer closeLabel={t("common.close")} {...props} />; }
