**中文** | [English](browser-paired-readiness.en.md)

# 浏览器配对基准验收状态

基准与独立 HTML 验收已实现并提交，真实模型测量被 Arena TLS 连通性阻断。预登记的 130 次配对尝试尚未开始，没有新的真实模型完成率或效率收益。完整口径见[评测方法](../methodology.md)，输入见[冻结计划](../browser-guide-ablation-plan.json)，结果状态见[结构化报告](browser-paired-readiness.json)。

## 已完成的验证

71 项 Node 测试、GUI 类型检查、受影响 GUI 文件的正式静态检查、文档检查及提交格式检查通过。当前产品的 13 项确定性 Core 场景通过；三个原生反例被评分器正确拒绝。修复后的旧指引对照组、TodoMVC Active 及独立 HTML 创建与打开专项通过并正常清理。HTML 原生页面截图已单独检查，主窗口截图不代替原生页证据。

独立 HTML fixture 从不存在的文件开始，经真实 `fs_create` 创建，写入回执摘要与磁盘一致；随后 `openDocument` 打开同一文件，原生标题、Results 和公开 nonce 一致。这使用脚本模型，只验证链路。销毁竞态与早期失败回执仍保留，不改写为成功。

基准源码提交为 `3a868d54`，两臂产品基点为 `4b392194`。两臂实际工件摘要只有 `service-protocol.cjs` 的参数指引不同。每题预算、种子、次序与评分器已封存；独立生成验收不进入 130 次配对统计。

## 独立真实验收的阻碍

一次真实生成验收以 failed 结束。六次客户端请求均已转发，但都在 HTTP 响应前出现 transport_error，未得到用量回执。原传输错误码未被 gate 保存，不能据事后探针反推每次失败的具体原因。Core/Electron 均已停止，供应商请求在途数为零，源码校验一致，没有手动重放任务。

无凭据对照显示，Arena DNS 与 TCP 可建立；直连默认 TLS、TLS 1.2 以及系统代理 CONNECT 200 后的 TLS 都在八秒超时。公开站点 TLS 1.3 在 68 毫秒完成并通过证书验证。目标路由使用 utun4，但其隧道归属未知。这将问题范围缩小到 Arena 端点或其当前网络路径，尚不能指定服务端或 VPN 为唯一根因。

需先恢复 Arena 的 TLS 连通性，再继续封存的配对实验及独立真实生成验收。保留失败的原始尝试与全部请求，不自动覆盖或重放。后续依据同条件实测判断 57/60 普通任务、5/5 停止和至少 15% 请求成本改善目标；现有确定性结果不计入这些分数。

本地原始证据位于 `.scratch/browser-hillclimb-v2/`，包括 `runtime-seal.json`、`generated-real-arena-01/`、`preflight/` 和 `real-helper/` 的无凭据网络对照。真实用量与费用仍未知；源码桌面结果不代表安装包或跨平台验收。
