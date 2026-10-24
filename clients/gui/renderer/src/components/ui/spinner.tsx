import type { ComponentProps } from "react";
import { Spinner as View } from "@areal/ui/wip";
import { useZCodeIntl } from "../../i18n/IntlProvider.js";
export function Spinner(props: ComponentProps<typeof View>) { const { intl } = useZCodeIntl(); return <View label={intl.formatMessage({ id: "common.loading" })} {...props} />; }
