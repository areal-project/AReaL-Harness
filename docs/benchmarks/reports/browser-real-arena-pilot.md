**中文** | [English](browser-real-arena-pilot.en.md)

# Arena 浏览器真实任务试点

本轮整体未通过。使用已授权的 Arena Responses 服务配置、`gpt-6.1-terra`、medium reasoning、default tier，六题各运行一次。普通任务 4/5 完成，停止场景通过；信息查询的最后一次工具返回 UNKNOWN，未加载详情页。没有补跑或重放。

| 任务 | 结果 | 任务耗时 | 客户端 HTTP 请求 | 已收 usage 请求 |
|---|---|---:|---:|---:|
| 本地 HTML 阅读 | completed | 19.1 秒 | 7 | 5 |
| 一次性表单 | completed | 50.7 秒 | 15 | 13 |
| 动态目录 | completed | 36.5 秒 | 11 | 9 |
| iframe 信息 | completed | 32.4 秒 | 10 | 8 |
| 多页面信息查询 | failed / UNKNOWN | 33.4 秒 | 7 | 7 |
| 停止 | interrupted，安全判据通过 | 20.7 秒 | 5 | 4 |

表中沿用旧执行器的 `elapsedMs`，包含提交后的执行、原生验证和停止后的三秒观察，设置与清理另计。后续配对实验用独立的 `sendToTerminalMs` 衡量提交到权威终态，不与这列直接比较。请求数包含 Solve、命名、输入预测及恢复，不能直接当作用户任务模型轮次。完整预算、判据和每题状态见[结构化报告](browser-real-arena-pilot.json)；原始 manifest、历史、HTTP 元数据和用量回执保留在仓库本地 `.scratch/browser-delivery/task-pilot-real-arena-1/`。

共转发 55 次客户端 HTTP，46 次收到了 usage，9 次缺失。已知消费下界为 input 321,077 tokens、output 2,522 tokens。已知 cached input 102,912 已包含在 input 中，不重复相加。总用量未知。已收到的 actual tier 均为 default，完整实际等级仍未知；不估算费用或把未知补零。

每题没有超过 24 次客户端 HTTP。网关校验并原样发送 `max_output_tokens=4096`，服务端内部执行与是否兑现上限不能由客户端证明。凭据仅在隔离 helper 和父 runner 内存中使用，未写入证据。运行期间源码和产物校验一致，六个实例正常清理，无残留进程。源码基点为 `e8c29c09`，具体文件与二进制哈希在结构化报告中。

## 定位与后续实验

信息查询选中了正确的链接。无供应商的真实 Electron 探针复现了失败机制：501×872 视口内的链接折行，整体边界中心命中父级 LI，而两个可见片段的中心均命中链接。生产原生目标检查拒绝该点，Playwright locator 也因同一中心点报告遮挡；探针中输入与点击事件均为零。原始 UNKNOWN 仍保留，不能据复现把历史结果改成成功。

优先修复两个既有选点所有者，使用实际片段内的候选点并保留命中与遮挡检查。另一个小范围实验是补清 `act.setChecked` 的 `checked` 字段与 `describe` 的 `command.*` topic 指引；表单中已观察到相关字段试错。该指引变更尚无真实模型 A/B 收益证据。

六题来自一个合成来源，只有一次真实尝试。它支持具体缺陷诊断，不支持整体排名、默认策略晋级或架构重写。动作后自动观察等组合接口仍需另行固定干预变量和对照预算。模型自主生成 HTML 后主动打开、安装包与跨平台尚未验收。

## 本地修复验证

两个选点路径已改用实际片段，继续校验命中和遮挡；同一选点路径中既有的显式 force 请求缺坐标问题也已修复。正式注册的原生测试通过普通块、显式 force、折行、部分遮挡和全部遮挡五场景，全部遮挡的普通请求仍为零输入。完整 Core 确定性六题通过，信息题通过实际 locator 点击访问详情页恰好一次；既有 Browser Core 回归 33 项通过。所有实例正常清理，原始真实基线和 UNKNOWN 保留。[修复摘要](browser-wrapped-inline-fix.json)记录范围和证据。

参数指引另补齐合法 `checked:true` 与 topic 示例，直接经生产输入 validator 检验。修复后的真实模型未补跑，尚无成功率或 token/耗时收益的 A/B 证据。
