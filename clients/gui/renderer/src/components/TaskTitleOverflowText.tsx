import type { ComponentProps } from "react";
import { TaskTitleOverflowText as View } from "@areal/ui/wip";
import { useReducedMotion } from "../settings/applicationPreferences.js";
export function TaskTitleOverflowText(props: ComponentProps<typeof View>) { const reducedMotion = useReducedMotion(); return <View reducedMotion={reducedMotion} {...props} />; }
