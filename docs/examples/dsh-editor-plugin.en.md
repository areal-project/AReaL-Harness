[中文](dsh-editor-plugin.md) | **English**

# DSH editor plugin

This example runs the pinned DSH str-replace-editor inside a trusted Node Host. Core owns the tool loop; Runtime executes file operations. See [editor.mjs](../../core/sdk-typescript/examples/editor.mjs), [configuration](../../core/sdk-typescript/examples/config.toml) and [permissions](../../core/sdk-typescript/examples/tools.json).

Configure model and credentials through the [quickstart](../guides/quickstart.en.md), then run on macOS:

```sh
make setup
make build
make sdk-build
mkdir -p /tmp/areal-editor-example/src
printf 'export const greeting = "Hello";\n' > /tmp/areal-editor-example/src/greeting.ts
python3 -I -S scripts/launch.py \
  --config core/sdk-typescript/examples/config.toml \
  --workspace /tmp/areal-editor-example --allow-write \
  --model-endpoint "$AREAL_HARNESS_MODEL_ENDPOINT" --model "$AREAL_HARNESS_MODEL" \
  --tui --prompt 'Use str_replace_editor to view /repo/src/greeting.ts and replace Hello with Welcome.'
```

Host cwd is the tool JSON directory. `/repo/src` maps to workspace src, the only authorized subtree in this configuration. trusted=true means actual trust in Node code, not OS sandboxing.

view records the digest observed by this Thread. str_replace requires a unique old-text match and conditionally writes against that digest. Missing reads, changed files or reads only by another Thread cannot authorize editing. Read again after Host restart.

The example exposes view/str_replace only, not create/insert. Regular UTF-8 files are limited to 32 KiB and results to 16 KiB. Escaping paths fail. A Host crash after writing preserves nested success and marks the outer call UNKNOWN without replay.

For complete validation without a real model, run `node scripts/plugin-smoke.mjs`. See [plugin design](../design/plugins.en.md) and [SDK](../api/typescript-sdk.en.md) for supported scope.
