**中文** | [English](dsh-editor-plugin.en.md)

# DSH 编辑器插件

示例在可信 Node Host 中运行固定 DSH str-replace-editor，Core 管理工具循环，Runtime 执行文件操作。见 [editor.mjs](../../core/sdk-typescript/examples/editor.mjs)、[配置](../../core/sdk-typescript/examples/config.toml)与[权限](../../core/sdk-typescript/examples/tools.json)。

按[快速开始](../guides/quickstart.md)配置模型和凭据，在 macOS 执行：

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

Host cwd 为工具 JSON 所在目录；`/repo/src` 映射到工作区 src，配置只授权此范围。trusted=true 表示真实信任 Node 代码，不代表 OS 沙箱。

view 记录本 Thread 实际观察的摘要；str_replace 要求旧文本唯一匹配并用该摘要条件替换。未读取、文件已变化或其他 Thread 才读取过均不能直接编辑。Host 重启后重新 view。

示例只开放 view/str_replace，不开放 create/insert。普通 UTF-8 文件最多 32 KiB，结果最多 16 KiB。越界路径拒绝；写入后 Host 崩溃保留嵌套成功事实并将外层标 UNKNOWN，不自动重放。

无需真实模型的完整验证：`node scripts/plugin-smoke.mjs`。支持范围见[插件设计](../design/plugins.md)与 [SDK](../api/typescript-sdk.md)。
