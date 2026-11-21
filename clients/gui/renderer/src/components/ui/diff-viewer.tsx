import { DiffViewer as View, type DiffViewerProps } from "@areal/ui";
import { useCodePreferences } from "../../settings/preferences.js";
import { useApplicationPreferences } from "../../settings/applicationPreferences.js";
export type { DiffViewerProps, DiffViewerSelectedLineRange } from "@areal/ui";
export function DiffViewer(props: DiffViewerProps) {
  const preferences = useCodePreferences();
  const { diffMarkers } = useApplicationPreferences();
  return <View preferences={preferences} diffMarkers={diffMarkers} {...props} />;
}
