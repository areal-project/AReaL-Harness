import { CodeViewer as View, type CodeViewerProps } from "@areal/ui";
import { useCodePreferences } from "../../settings/preferences.js";
export {
  CodeCommentAnnotation,
  resolveCodeViewerColorScheme,
  isCodeCommentSubmitShortcut,
  isCodeCommentCancelShortcut,
  formatCodeCommentSubmitShortcutLabel,
  formatCodeCommentCancelShortcutLabel,
} from "@areal/ui";
export type { CodeViewerProps, CodeCommentLabels } from "@areal/ui";
export function CodeViewer(props: CodeViewerProps) {
  const prefs = useCodePreferences();
  const mode = document.documentElement.classList.contains("dark") ? "dark" : "light";
  return <View {...prefs} theme={prefs[`${mode}Theme`]} {...props} />;
}
