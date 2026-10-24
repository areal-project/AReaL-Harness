# 浏览器数据导入

`@areal/browser-data` 把 Chrome Cookie 和 localStorage 导入调用者持有的 Electron Session。实现来自 [ZCode](https://github.com/zai-org/ZCode) 的 `3c5b227649371507ddc4eb46ac5133afe6db1cab` 提交。[UPSTREAM.json](./UPSTREAM.json) 记录文件和上游哈希，[NOTICE](./NOTICE) 说明本地适配。

## Main 进程 API

```ts
import { importChromeBrowserData } from '@areal/browser-data';

const result = await importChromeBrowserData({
	targetSession: sharedBrowserProfile.session,
	registerWebContents: (contents) => sharedBrowserProfile.registerImporter(contents),
	logger: console,
});
```

Main 在用户明确操作后、持有共享浏览器 Profile 数据操作 gate 时调用。`targetSession` 是必填项。本包不选择分区，也不清除浏览器数据。`registerWebContents` 在临时目标窗口导航前登记 WebContents，并返回注销回调。登记对象的网络、权限和下载策略由 Main 管理。

公开函数只接受这三个选项。源路径、平台、凭据读取器和数据读取器属性不会传入内部实现。测试注入仅通过内部源码模块和夹具 bundle 使用。本包没有 Renderer API。

## 返回结果

结果包含 `success`、Cookie 数量、localStorage origin 和条目数量，以及可选错误码。`success` 沿用 ZCode 语义。部分导入成功或已有 Cookie 数据库为空时，也可能返回 true。调用方必须显示失败、跳过计数和 `issues`。后续失败不会撤销已经写入的 Cookie。

导入器读取 SQLite 快照，并通过 Chrome Safe Storage 解密 macOS v10 Cookie。用户拒绝 Keychain 授权时，操作在写入 Cookie 或 localStorage 前返回 `chrome_cookie_access_denied`。结果和日志不包含 Cookie 值、localStorage 值、密钥或源路径。

localStorage 先复制到临时 Chrome Profile，再由已安装的 Chrome helper 读取。helper 与目标 writer 都通过 CDP 用空白文档回应导航，并拒绝页面资源请求。目标使用隐藏、启用 sandbox 的 BrowserWindow。关闭 helper 窗口不会清除调用者的 Session。

## 运行环境

产品入口支持 macOS。其他操作系统返回 `chrome_import_not_supported`。包内保留可移植的上游发现实现。由于未迁入签名原生 helper，Windows App-Bound 解密不可用。

运行时需要 Electron，以及提供 `DatabaseSync` 和 `backup` 的 Node `node:sqlite` 模块。缺少 SQLite 时，在发现源 Profile 前返回 `chrome_sqlite_unavailable`。构建产物为 CommonJS，`electron` 和 `ws` 保持外部依赖。

## 验证命令

从 GUI workspace 执行以下命令。

```sh
pnpm --filter @areal/browser-data build
pnpm --filter @areal/browser-data typecheck
pnpm --filter @areal/browser-data verify:upstream
pnpm --filter @areal/browser-data test:fixtures
pnpm --filter @areal/browser-data test:electron
```

夹具使用合成 SQLite 数据库和固定测试密钥，拒绝系统凭据命令与个人 Chrome 发现。Electron 验收从隔离目标 Session 回读 Cookie 和 localStorage，检查部分失败与临时窗口销毁，并检查导入导航没有访问合成站点。这些验证不代表真实 Chrome 账号、Keychain 授权窗口、安装包或其他操作系统已经通过。

`verify:upstream` 按 manifest 检查本地文件。传入可选的 ZCode checkout 路径后，还会核验指定上游提交的原始文件。
