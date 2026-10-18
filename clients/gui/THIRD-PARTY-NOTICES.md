# Third-party notices

The GUI is distributed under the repository Apache-2.0 license, subject to the following retained third-party notices.

- Electron host portions derive from Caxson's MIT-licensed [dsh-gui 1.6.2](https://github.com/Caxson/dsh-gui/tree/562cc65e143d64b66a551b88bd5d4e55c9e1d587), imported at commit `562cc65e143d64b66a551b88bd5d4e55c9e1d587` and subsequently adapted for AReaL. See `app/LICENSE` and the retained theme licenses. The original DSH engine, update feed and release instructions are not this product's runtime or release channel.
- Renderer portions derive from ZCode commit `872ad960de7ec172591f7e1952f7849229f94521` under Apache-2.0. See `renderer/ZCODE-LICENSE` and `renderer/source-files.json` for the imported source inventory. Changes include the AReaL Core bridge and interface assets.
- Material Icon Theme SVGs in `renderer/public/material-icons` are MIT licensed. The selected 638 SVGs are byte-identical to `packages/desktop/src/renderer/public/material-icons` at ZCode commit `872ad960de7ec172591f7e1952f7849229f94521`; that immutable source revision pins the imported asset bytes. See `licenses/material-icon-theme-LICENSE`. License source: https://github.com/material-extensions/vscode-material-icon-theme/blob/cb1dfb6d9cb73b15681a93939983d75dbba7bf5b/LICENSE . The precise original icon release is not asserted.
- The Fork action glyph preserves the Codex App glyph from the user-supplied design reference as a bounded raster mask (`renderer/src/assets/codex-fork-mask.png`); no capture archive is included.
- Interface glyphs, the file-tree sprite, provider logos and the application icon retain the source repository's assets and provenance comments. Other Lucide icons retain their dependency's ISC license. Appearance previews are original SVG illustrations.
- Agent avatars use DiceBear Core and Bottts 9.4.2 locally with the authoritative Thread ID as seed. DiceBear code is MIT licensed (copyright Florian Körner); Bottts artwork is by Pablo Stanley and is free for personal and commercial use. See `licenses/dicebear-core-LICENSE` and `licenses/dicebear-bottts-LICENSE`, https://www.dicebear.com/styles/bottts/ and https://bottts.com/.
- Runtime dependencies retain their package licenses in the staged application. Core binaries, tools and their licenses come from the repository's Core bundle.

Only the selected runtime icon assets are retained; reference capture archives, private development Skills, signing identities, notarization credentials, and source repository Git history are not part of this module.

## 固定来源与许可

Electron 宿主复用 Caxson 的 MIT 许可项目 [dsh-gui 1.6.2](https://github.com/Caxson/dsh-gui/tree/562cc65e143d64b66a551b88bd5d4e55c9e1d587)，原导入修订为 `562cc65e143d64b66a551b88bd5d4e55c9e1d587`，之后按 AReaL 接口调整。原许可保留于 `app/LICENSE`；原 DSH 引擎、更新源和发布指令不属于本产品的运行或发布入口。

Renderer 的来源修订为 ZCode `872ad960de7ec172591f7e1952f7849229f94521`，Apache-2.0 许可和源码清单保留于 `renderer/ZCODE-LICENSE`、`renderer/source-files.json`。638 个选用 Material Icon Theme SVG 与该修订的 `packages/desktop/src/renderer/public/material-icons` 逐字节一致，以此固定资产来源，不推测原图标语义版本；MIT 许可保留于 `licenses/material-icon-theme-LICENSE`，许可来源修订为 `cb1dfb6d9cb73b15681a93939983d75dbba7bf5b`。
