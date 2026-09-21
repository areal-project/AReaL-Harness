import * as editor from "@deepseek-ai/dsh-tool-str-replace-editor";
import { servePlugin } from "../dist/index.js";

await servePlugin({
  plugin: editor,
  config: {
    maxOutputChars: 1000,
    description:
      "View and edit regular UTF-8 files up to 32 KiB under /repo. Read with view before editing. str_replace requires a unique literal old_str and optionally new_str (omit to delete). Only view and str_replace are supported. Concurrent changes require a fresh view.",
  },
  commands: { str_replace_editor: ["view", "str_replace"] },
});
