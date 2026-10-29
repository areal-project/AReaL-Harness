[English instructions](README.md)

# 安装示例市场插件

在插件工作台将本目录添加为本地市场。在个人市场选择适配插件，解析来源并核对摘要后安装到当前项目。打开其 Skill 并选择试用会准备普通聊天草稿。点击发送才开始执行。

浏览器与电脑控制包包含 AReaL 原创的 Skill 指导。版本化的 `extensions.org.areal.hostRequirements` 元数据声明已有的 `browser_v1` 或 `computer_v1` 宿主工具。安装不执行脚本、不启动供应商。插件包不包含模型配置、凭据、复制的第三方 Skill 正文或原生可执行文件。

宿主能力就绪表示当前项目已部署所需工具。电脑控制还需要启用设置和相应的系统授权。工具就绪不表示操作系统已经授权。

创建 Skill 继续使用已有的官方 Skill Creator 入口。本示例不复制该来源。

## 安装官方 Heptabase 插件

在本市场选择 **Heptabase**，解析并预览来源，核对摘要后安装到当前项目。目录引用[官方 Heptabase 插件仓库](https://github.com/heptameta/heptabase-agent-plugins) 的 `plugins/heptabase`，固定 commit 为 `7cae4b5988bb4a2875e7ba9ea3f9eec12c644826`，插件版本为 `0.2.0`。

来源保留上游便携 `plugin.json`、`mcp.json`、Skills、许可证，以及包含 `.app.json` 注册的 Codex overlay。AReaL 通过 Git 来源流程下载原包。当前 Heptabase App ID 缺少 AReaL Connector 映射，包内 MCP 也未显式声明 OAuth。本接入已验证原包安装，尚未打通账号授权和真实工具调用。

也可将 `https://github.com/heptameta/heptabase-agent-plugins.git` 作为 Git 市场添加，并使用同一 commit。选择其中的 Heptabase，按相同步骤预览并安装。

## 验证本地适配插件

在仓库根目录通过显式部署的 Core 产物运行隔离源码验收：

```sh
AREAL_CORE_BIN=/absolute/path/to/areal node clients/gui/scripts/plugin-ecosystem-smoke.mjs
```

该流程使用确定性本地模型与受控浏览器页面，记录 GUI 安装、模型请求中的所选 Skill 正文、Core 工具结果、浏览器副作用、电脑控制停用时的准入，以及已有官方 Creator 的 Runtime 路径。它不运行物理原生输入、真实供应商或安装包。manifest 会列出当前组合路径尚未覆盖的过期引用及 UNKNOWN 场景。
