# Third-party notices

The GUI is distributed under the repository Apache-2.0 license, subject to the following retained third-party notices.

- Electron host portions derive from Caxson's MIT-licensed [dsh-gui 1.6.2](https://github.com/Caxson/dsh-gui/tree/562cc65e143d64b66a551b88bd5d4e55c9e1d587), imported at commit `562cc65e143d64b66a551b88bd5d4e55c9e1d587` and subsequently adapted for AReaL. See `app/LICENSE` and the retained theme licenses. The original DSH engine, update feed and release instructions are not this product's runtime or release channel.
- Renderer portions derive from ZCode commit `872ad960de7ec172591f7e1952f7849229f94521` under Apache-2.0. See `renderer/ZCODE-LICENSE` and `renderer/source-files.json` for the imported source inventory. Changes include the AReaL Core bridge and interface assets.
- Executable Side Chat reference collections, slash parsing, and pane-owned Escape adapt [zai-org/ZCode](https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab) commit `3c5b227649371507ddc4eb46ac5133afe6db1cab` under Apache-2.0. The `sideChatImports` inventory in `renderer/source-files.json` records exact source hashes and adaptations. AReaL reuses its own Core execution, durable receipts, permissions, full Composer, and panel owners. The retained license is `renderer/ZCODE-LICENSE`.
- Terminal appearance detection in `app/src/core/terminal-profile.cjs` adapts the font fallback order, iTerm2 and macOS Terminal profile fields, and Kitty font detection from ZCode `packages/services/src/terminal/terminalProfile.ts` and `terminalProfileMacOs.ts` at commit `3c5b227649371507ddc4eb46ac5133afe6db1cab`. Copyright 2026 Z.AI Co., Ltd, Apache-2.0. The license is retained in `renderer/ZCODE-LICENSE`. AReaL uses bounded asynchronous reads from the supplied home, reads the actual Terminal `Window Settings` container, and keeps profile data limited to presentation metadata.
- Material Icon Theme SVGs in `renderer/public/material-icons` are MIT licensed. The selected 638 SVGs are byte-identical to `packages/desktop/src/renderer/public/material-icons` at ZCode commit `872ad960de7ec172591f7e1952f7849229f94521`; that immutable source revision pins the imported asset bytes. See `licenses/material-icon-theme-LICENSE`. License source: https://github.com/material-extensions/vscode-material-icon-theme/blob/cb1dfb6d9cb73b15681a93939983d75dbba7bf5b/LICENSE . The precise original icon release is not asserted.
- The Fork action glyph preserves the Codex App glyph from the user-supplied design reference as a bounded raster mask (`renderer/src/assets/codex-fork-mask.png`); no capture archive is included.
- Interface glyphs, the file-tree sprite, provider logos and the application icon retain the source repository's assets and provenance comments. Other Lucide icons retain their dependency's ISC license. Appearance previews are original SVG illustrations.
- Agent avatars use DiceBear Core and Bottts 9.4.2 locally with the authoritative Thread ID as seed. DiceBear code is MIT licensed (copyright Florian Körner); Bottts artwork is by Pablo Stanley and is free for personal and commercial use. See `licenses/dicebear-core-LICENSE` and `licenses/dicebear-bottts-LICENSE`, https://www.dicebear.com/styles/bottts/ and https://bottts.com/.
- The bundled official Skill Creator retains the unmodified Apache-2.0 resource from [openai/skills](https://github.com/openai/skills/tree/49f948faa9258a0c61caceaf225e179651397431/skills/.system/skill-creator). Its license and pinned file inventory are retained under `@areal/workbench/assets/builtin-skills`.
- Settings localization uses BSD-3-Clause licensed `react-intl` 12.1.5 from [FormatJS](https://github.com/formatjs/formatjs). ICU parsing, plurals and locale formatting use its packaged dependencies. See `licenses/react-intl-LICENSE`. Both languages are bundled; no translation service or remote catalog is used.
- Runtime dependencies retain their package licenses in the staged application. Core binaries, tools and their licenses come from the repository's Core bundle.

Only the selected runtime icon assets are retained; reference capture archives, private development Skills, signing identities, notarization credentials, and source repository Git history are not part of this module.

## 固定来源与许可

Electron 宿主复用 Caxson 的 MIT 许可项目 [dsh-gui 1.6.2](https://github.com/Caxson/dsh-gui/tree/562cc65e143d64b66a551b88bd5d4e55c9e1d587)，原导入修订为 `562cc65e143d64b66a551b88bd5d4e55c9e1d587`，之后按 AReaL 接口调整。原许可保留于 `app/LICENSE`；原 DSH 引擎、更新源和发布指令不属于本产品的运行或发布入口。

Renderer 的来源修订为 ZCode `872ad960de7ec172591f7e1952f7849229f94521`，Apache-2.0 许可和源码清单保留于 `renderer/ZCODE-LICENSE`、`renderer/source-files.json`。638 个选用 Material Icon Theme SVG 与该修订的 `packages/desktop/src/renderer/public/material-icons` 逐字节一致，以此固定资产来源，不推测原图标语义版本；MIT 许可保留于 `licenses/material-icon-theme-LICENSE`，许可来源修订为 `cb1dfb6d9cb73b15681a93939983d75dbba7bf5b`。

可执行 Side Chat 的引用集合、斜杠命令解析和面板 Esc 归属适配自 [zai-org/ZCode](https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab) 修订 `3c5b227649371507ddc4eb46ac5133afe6db1cab`，采用 Apache-2.0。`renderer/source-files.json` 的 `sideChatImports` 记录原文件摘要和本地适配。AReaL 复用自己的 Core 执行、持久收据、权限、完整 Composer 和面板所有者，原许可保留于 `renderer/ZCODE-LICENSE`。

内置官方 Skill Creator 保留 OpenAI Skills 修订 `49f948faa9258a0c61caceaf225e179651397431` 的原始资源。Apache-2.0 许可与固定文件清单位于 `@areal/workbench/assets/builtin-skills`。

设置国际化复用 FormatJS 的 `react-intl` 12.1.5，BSD-3-Clause 许可保留于 `licenses/react-intl-LICENSE`。两种语言随应用打包，不连接翻译服务或远程词库。


终端外观检测 `app/src/core/terminal-profile.cjs` 适配自 ZCode 修订 `3c5b227649371507ddc4eb46ac5133afe6db1cab` 的 `packages/services/src/terminal/terminalProfile.ts` 与 `terminalProfileMacOs.ts`，复用字体回退顺序、iTerm2 和 macOS Terminal profile 字段及 Kitty 字体检测。Copyright 2026 Z.AI Co., Ltd，Apache-2.0 许可保留于 `renderer/ZCODE-LICENSE`。AReaL 改为从指定 home 异步限量读取，适配 Terminal 实际的 `Window Settings` 容器，且只传递外观 metadata。

- Repository oxlint suppression-reason and ResizeObserver rules adapt T3 Code `f41518f3bc2672c419871c02a3c6728d0f627142`, Copyright (c) 2026 T3 Tools Inc., MIT. The retained license is `oxlint-plugin-areal/LICENSE`. The local test harness uses the existing Vite Plus runner.

Relay certificate management adapts Cindy ACME, CSR, and certificate storage at revision `7d7473c62d17b0a893fa503d8a42e35c34ae02d1`, Apache-2.0. The Relay resource bundle retains `deploy/licenses/CINDY-LICENSE` and `CINDY-NOTICE`. Android native local sockets use Java-WebSocket 1.6.0 and SLF4J API 2.0.13, both MIT. Their notices are packaged in Android assets under `legal/Java-WebSocket-LICENSE.txt` and `legal/SLF4J-LICENSE.txt`.

Relay 证书管理适配 Cindy 修订 `7d7473c62d17b0a893fa503d8a42e35c34ae02d1` 的 ACME、CSR 与证书存储，采用 Apache-2.0；Relay 资源包保留 `deploy/licenses/CINDY-LICENSE` 与 `CINDY-NOTICE`。Android 原生内网连接使用 Java-WebSocket 1.6.0 与 SLF4J API 2.0.13，均为 MIT；许可证随 Android assets 的 `legal/Java-WebSocket-LICENSE.txt` 与 `legal/SLF4J-LICENSE.txt` 分发。

Read-only PDF previews use Mozilla PDF.js (`pdfjs-dist` 6.4.299), Apache-2.0. The retained license is `licenses/pdfjs-dist-LICENSE`. The renderer bundles a dedicated worker and the package's CMaps, standard fonts, ICC profiles, and image decoders with their original license files. Documents are supplied as workspace-scoped bytes, without PDF scripting, form actions, or external document navigation.

SnapShots adapts T3 Code revision `c8a606c7b73e1e3586d5c06f76c69525f2d4c679`, Copyright (c) 2026 T3 Tools Inc., MIT. Retained terms are in `licenses/t3code-snapshots-LICENSE`. Native window capture, modifier-pair shortcuts, capture transitions, accessibility context, settings interactions, and capture sounds are adapted to AReaL desktop and Composer ownership.
