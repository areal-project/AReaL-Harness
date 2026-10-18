[中文](STYLE_GUIDE.md) | **English**

# Diagram style

Architecture diagrams explain responsibility, dependency and ownership; flow diagrams explain execution and control. Distinguish implemented behavior from proposals and omit unmeasured performance figures.

| Item | Convention |
|---|---|
| Format | Matching `.drawio` source and `.svg` preview; update existing `.png` previews too |
| Canvas | Default 1600 × 1000, 64 px margins, 8 px grid |
| Flow | Left to right, at most 6 main nodes and 2 nesting levels; split larger diagrams |
| Spacing | 64–80 px horizontally, 40–56 px vertically |
| Colors | White background; primary `#0F1012`, text `#3A3D44`, secondary `#8B8F97`, borders `#A0A1A3`, dividers `#E9E9EA` |
| Fonts | Baskerville/Georgia titles; Inter/Helvetica Neue body; PingFang SC/Noto Sans CJK SC Chinese; SF Mono/Menlo protocols |
| Sizes | Titles 32–36 px, nodes 15–16 px, relationships 11–12 px; do not squeeze labels |
| Edges | Orthogonal, avoid crossings, point toward the dependency/data receiver; distinguish execution and control |

Use neutral grayscale without gradients, shadows, decorative icons or large shaded regions. Prioritize layout, group related nodes and keep labels short and clear of edges. Shared previews retain protocol/module names; accompanying prose explains them in both languages.

Store files in `docs/design/diagrams/` and link both preview and source from the document. Re-export after source changes and inspect text, margins, clipping and edges visually. Do not commit generation scripts or unrelated presentation assets. See the [architecture diagram](architecture.en.md).
