# Chrome 导入验收

本计划先于实现建立。所有数据由夹具创建。禁止调用系统凭据命令、发现个人 Chrome Profile 或读取个人浏览器数据。

| 用户可观察结果 | 失败方式 | 验收 |
| --- | --- | --- |
| 目标 Session 收到明文和 macOS v10 加密 Cookie。 | 快照、解密、属性映射或写入失败。 | 合成 SQLite 和固定测试密钥，Electron cookies.get 回读。 |
| 原始 Profile 不变。 | 在线备份或 helper 写回源目录。 | 导入前后合成 Profile 文件内容哈希一致。 |
| 返回实际导入、跳过和失败数量。 | 不支持的密文或目标写入失败被计算为成功。 | 混合合成 Cookie，拒绝一个目标写入，断言计数与回读数据。 |
| 用户拒绝 Keychain 后整次停止。 | 继续写 Cookie 或 localStorage。 | 注入抛出授权拒绝的读取器，目标 Session 为空，localStorage 读取器未执行。 |
| localStorage 写入真实目标 Session，临时 WebContents 及时销毁。 | 注册遗漏、初始化抛错泄漏、导航超时、写入不完整。 | 合成记录通过真实 CDP writer，回读值，检查登记和销毁，故障注入注册回调。 |
| 导入不运行站点代码。 | helper 导航真实 origin 并发出网络请求。 | 合成本地 HTTP 服务记录请求计数。导入计数必须为零。 |
| 运行时缺少 SQLite 时返回明确失败。 | 包载入时崩溃或返回成功。 | 在隔离 VM 中拒绝 node:sqlite，检查稳定错误码。 |
| Windows App-Bound helper 缺失时返回不支持。 | 留下缺失依赖或假成功。 | 直接调用不支持适配器，检查错误码。 |

Node 夹具验证数据库、解密、计数、拒绝和依赖失败。Electron 夹具验证 Session、CDP 写入与临时窗口生命周期。真实 Chrome Profile、Keychain 授权窗口和安装包不在合成验收结论内。
