# 测试指南

按改动落在哪一层选一份读，不必全读。总规则与平台资格见 [docs/development/testing.md](../../docs/development/testing.md)。

| 改动落在 | 读 |
| --- | --- |
| Host、Core、Runtime、协议、桌面后台（services/workbench） | [core.md](core.md) |
| CLI 子命令、`exec`/`-p`、`areal host` 管理命令 | [cli.md](cli.md) |
| TUI 界面、按键、恢复 | [tui.md](tui.md) |
| renderer 界面、本机浏览器、远程网页 | [web.md](web.md) |
| Electron 外壳：窗口、菜单、预览、加密、退出、升级 | [gui.md](gui.md) |
| 手机：配对、WebView、iOS/Android 原生 | [mobile.md](mobile.md) |

跨层改动按每一层各读一份。界面逻辑大多能在 web 层测完，只有原生外壳行为才需要启动 GUI。
