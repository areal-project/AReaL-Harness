import { useEffect, useId, useRef, type ComponentProps } from "react";
import { FeedbackNotice as View } from "@areal/ui/experimental";
import { useI18n } from "./i18n/IntlProvider.js";
import { Button, Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@areal/ui";
import { dismissToast, toast } from "./components/ui/toast.js";

export function FeedbackNotice({
  transient = false,
  ...props
}: ComponentProps<typeof View> & { transient?: boolean }) {
  const { t } = useI18n();
  const instance = useId();
  const key = props.requestId
    ? `request:${props.requestId}:${props.tone}`
    : `${props.id ?? instance}:${props.tone}:${props.message}`;
  const dismiss = useRef(props.onDismiss);
  dismiss.current = props.onDismiss;
  useEffect(() => {
    if (!transient || !props.message) return;
    toast(props.message, props.tone, {
      key,
      requestId: props.requestId,
      actions: props.detail ? (
        <>
          {props.actions}
          <Popover>
            <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" />}>
              {t("recovery.details")}
            </PopoverTrigger>
            <PopoverContent align="end">
              <PopoverTitle>{t("recovery.details")}</PopoverTitle>
              <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                {props.detail}
              </div>
            </PopoverContent>
          </Popover>
        </>
      ) : (
        props.actions
      ),
      onDismiss: () => dismiss.current?.(),
    });
  }, [transient, key, props.message, props.tone, props.actions, props.detail, t]);
  useEffect(
    () => () => {
      if (transient) dismissToast(key);
    },
    [transient, key],
  );
  if (transient) return null;
  return (
    <View
      dismissLabel={t("recovery.dismiss")}
      detailsLabel={t("recovery.details")}
      expandLabel={t("settings.settingsDisclosure.expand")}
      collapseLabel={t("settings.settingsDisclosure.collapse")}
      {...props}
    />
  );
}
