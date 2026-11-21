# GUI、共享网页与 Electron

- 改组件、页面、样式或文案前按 [设计系统开工顺序](design-system/README.md#开工顺序)读取规范。视觉变更按用户实际尺寸查看，核对相关主题和交互，保留前后截图。设计例外和证据按[完成条件](design-system/governance.md#完成条件)提交。
- GUI 与网页共用 Renderer 和 Host 协议。Renderer 只消费投影，平台适配文件独占 preload 访问。Node/Electron、凭据读取和 Agent 执行循环留在各自拥有层。
- Electron Main/preload 承载原生能力及必要协议适配。新增能力先登记到 [shell-capabilities.cjs](packages/workbench/client/desktop-contract/shell-capabilities.cjs)，写明桌面专属原因。清单中的 `transitional` 只减不增。GUI health 的职责、依赖与类型覆盖是门禁，规模变化用于审查。
- 新源码用 TypeScript，Main 构建为 CommonJS。新增 `.mjs` / `.cjs` 仅用于测试，使用 `.test` / `.spec` 后缀或登记到测试清单。生产代码不依赖测试模块。修改受控源码或 [patches/](patches/)，避免直接修改依赖安装目录。
- 共享业务旅程优先跑网页的 `test:web-journeys`。原生窗口、焦点、工具连接及生命周期用隔离 Electron 验证。启动、打包与数据隔离见 [GUI 指南](README.md)。

## Code Review Rules

- 查迟到结果是否按原连接、代际和 viewId 核对归属，Main 断连是否撤销原生工具及资源。查未经登记的 IPC、第三方页面访问 bridge，以及桌面与网页遗漏同一共享行为的情况。
