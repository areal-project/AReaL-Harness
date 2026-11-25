**中文** | [English](unknown-receipt-recovery-map.en.md)

# 断线收据核对与显式停止重开功能地图

本表记录 `unknown-receipt-recovery` 与 `host-stop-reopen` 两条核心恢复旅程的用户视角产品规则与验证绑定，不复制测试命令或源码路径。机器选检与执行契约由 [journey manifest](../../clients/gui/scripts/journey-manifest.json) 唯一持有；方法论见[系统化验证设计](verification-system.md)。

> 编写铁律：**预期产品规则列只写纯用户视角的行为承诺，不出现内部错误码、进程名或实现词**；工程线索仅记录在现状列供排查。

| 规则 ID 与用户目标 | 预期产品规则（PM 意图） | 现状与工程线索 | 权威结果 & 可见结果 | 绑定锚点与覆盖边界 | PM 裁决 |
|---|---|---|---|---|---|
| **`FM-REC-01`**<br>提交后断线或页面异常退出，重开后查看原提交<br>（Web / Desktop / Mobile） | 异常断开后重新打开应用，系统保留原提交记录并只核对原请求结果，**不会静默重发第二条消息**。 | `service-reopen-smoke` 已接入 `unknown-receipt-recovery` 的 schema-v1 业务报告与 4 个 `terminalFacts`。 | **权威**：Core 仅保留原请求回执，无重复 Turn。<br>**可见**：历史消息与未发送草稿与真实结算一致。 | `unknown-receipt-recovery`：`originalRequestRetained` / `receiptReconciled` / `noReplay`。<br>Mobile 与正式包未执行。 | 待拍板 |
| **`FM-REC-02`**<br>用户在设置或菜单中显式停止后台服务后重新打开桌面<br>（Desktop） | 点击停止后，所有后台任务与原服务确实退出；再次打开桌面时以全新会话正常就绪，不残留旧实例。 | `gui-stop-reopen-smoke` 已接入 `host-stop-reopen` 的 schema-v1 业务报告与 4 个 `terminalFacts`。 | **权威**：离线收据确认停止完成，原进程全部退出，重开产生新代际。<br>**可见**：重开后工作台正常可用且无旧错误残留。 | `host-stop-reopen`：`stopReceiptSettled` / `originalProcessesExited` / `newGenerationObserved` / `cleanupSettled`。 | 待拍板 |
| **`FM-VIS-01`**<br>修改样式、Token 或组件视觉后在亮暗主题与窄屏下浏览界面<br>（Web / Desktop） | 亮色、暗色、中英文、常规宽屏、窄屏与大字号下均无横向溢出、布局跳动或动效违例，且产出可视化对比图。 | `ui-audit-probe.mjs` 已注册至 `test-manifest.json`（`audit:ui`）并接入 `ui-visual-audit` 旅程的 `evidenceCheck`。 | **权威**：10 视口扫描零溢出、零 CLS、`reduced-motion` 动效数为 0。<br>**可见**：自动生成 `contact-sheet-overview.png` 供双主题复核。 | `ui-visual-audit`：`overflowFree` / `layoutStable` / `reducedMotionRespected` / `contactSheetCaptured`。 | 待拍板 |

## 防漂移原则

代码行为与本表不一致时，按三类处理：**文档漂移**（产品规则有意变更，经 PM 确认后更新本表）、**验证缺口**（本表已定但未覆盖，补 `factId` 与断言）、**产品回归**（代码偏离既定规则，先留红灯再修代码，严禁反改本表掩盖回归）。
