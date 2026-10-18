import { useApplicationPreferences } from "../settings/applicationPreferences.js";
const enter = {
  composerSend: ["Enter"],
  composerInsertNewline: ["Shift+Enter"],
};
const modifier = {
  composerSend: ["CmdOrCtrl+Enter"],
  composerInsertNewline: ["Enter", "Shift+Enter"],
};
export function useEffectiveShortcutBindings() {
  return useApplicationPreferences().sendShortcut === "modifier"
    ? modifier
    : enter;
}
