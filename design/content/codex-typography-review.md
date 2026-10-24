# Codex字体核对

日期：2026-10-24。对照用户截图并只读核对本机`/Applications/ChatGPT.app/Contents/Resources/app.asar`中的`webview/assets/app-shared-fadc3c6ec518.css`；不提取/分发字体文件，也不把缩放截图像素当成CSS字号。

桌面默认`--font-sans-default`为`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`，`--font-sans`经`--font-ui-family`覆盖；OpenAI Sans的400/500/600资源存在，但存在资源不等于对话正文使用它。browser分支有另一套`-apple-system-body`起始的回退，不应套给桌面。UI基础值14px、正文角色另有14/16px及20/24px行高；具体消息还可以通过聊天偏好覆盖。

我们当前字体源为`packages/ui/tokens.json`，macOS起始同为`-apple-system`，保留明确CJK与跨平台回退；常规400、界面14px。Markdown继续使用已有内容字号偏好与1.75行高，不能仅凭这张缩放截图证明其精确行高与用户当前Codex偏好相同。审批/问题和新内容沿同一Token，无新字体依赖或局部替代字体。本轮没有发现需要替换默认字体家族的证据，因此保留当前系统字体；不宣称不同机器、截图缩放或所有用户偏好下逐像素一致。

官方[品牌页面](https://openai.com/brand/)描述OpenAI Sans及其字重，并不证明桌面对话的实际CSS选择。最终精确对照应在相同机器、字号、内容宽度和相同文字下核对渲染，而不是直接复制品牌字体。iframe字体不继承父页，完整Token桥仍是独立后续范围。
