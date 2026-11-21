# iOS、Android 与 Remote

- 远程业务通过共享 `@areal/remote-client` 接入 Host，包括能力协商、命令回执和会话状态。平台适配负责本机桥接、安全存储与生命周期。
- 修改配对、回连或远程命令时，按影响核对网页、iOS、Android 和实际连接方式。断线或换代后，用原身份核对原命令并恢复观察。
- 构建和验收入口见 [iOS 指南](../../docs/development/ios-development.md) 与 [Android 指南](../../docs/development/android-development.md)。将 web/模拟器/设备证据分别记录，配对、系统权限与升级结论用实际设备路径核对。
