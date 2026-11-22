**中文** | [English](connection-recovery-exploration.en.md)

# 有界恢复探索样板验收

2026-11-22。恢复样板完成了真实操作、逐步证据、数据回放、历史缺陷反证与有预算的失败缩减。验收对应 `fc49e941d` 加冻结补丁；完整源码、补丁及 runner 摘要见[结构化记录](connection-recovery-exploration.json)。期间主工作树有并行 UI 提交，不能将本次结论延伸到那些改动。

## 实际执行

| 检查 | 结果 |
|---|---|
| seed 1、2、3，各 6 步真实探索 | 3/3 通过，18 个动作；包括连续发送、空闲回收、连续重连、编辑和 UNKNOWN |
| 冻结树中的固定旅程基线 | 六项业务事实全部通过 |
| 冻结树中的六步探索回放基线 | 通过，包含恢复后发送、UNKNOWN 和显式停止 |
| 恢复旧加载误报逻辑 | 准确命中 `loading-no-false-failure` |
| 恢复旧休眠 owner guard | 固定旅程命中 `idle-automatic-recovery`，探索命中 `exploration-recovery-progress / idle-reconnect` |
| 六次失败缩减尝试 | 6 步缩为实际复现过的 `idle-reconnect → submit`；预算耗尽，`minimal=false` |
| 证据与清理 | 各次运行均通过导入及清理检查；隔离 worktree 已移除 |
| 针对性契约测试 | Node 27/27，Python 21/21 + 44/44 |
| 文档、旅程清单和引用检查 | 通过 |

每次发送核对唯一 Core Turn 与同一 Turn ID 的可见完成卡片。UNKNOWN 注入只丢弃原 socket、原 commandId 的一次 accepted 响应。项目停止后不会为验证重启 Core：报告引用带步骤编号的上次权威核验，并独立检查当前 Host、历史页面和没有额外发送；下一次用户提交后再读取 Core。

## 首跑问题与边界

较早一次探索中，Host/Core 已报告 ready，但首个 `session.create` 返回 `scheduleHostUnavailable`。最终样板在动作开始前复用既有只读 `taskScheduleContext` 探测，等待原 owner 的调度连接可用。**这没有修复产品的冷启动就绪窗口，也没有证明用户看到 ready 后立即发送一定成功。** 原失败记录保留，首次可用性仍是后续独立验收义务。

另一次在沙箱内启动 Electron 失败，报告保持 blocked；确认原 runner 已退出、隔离注册目录无 Host 后清理了该次 fixture。随后在允许启动本机应用的环境完成真实验收。较早调试记录没有改写成通过。

本轮证明的是源码 Electron owner、生产 Web Renderer、真实 Rust Host/Core 与本地确定性模型下的有限恢复序列。未验收正式安装包、Host 进程换代、真实十五分钟定时、真实供应商或移动真机；两个已知缺陷检出不代表未知缺陷发现率，亦未证明人工时间下降。

## 复用

命令和数据协议见[测试指南](../../development/testing.md#有界恢复探索与回放)，用户义务见[功能地图](../../design/recovery-verification-map.md)。原始证据位于结构化记录列出的本地目录，包含计划、逐步 JSON/截图、事件顺序、回执、首错和清理；这些临时文件未提交。源版本与补丁摘要必须一起使用，当前正确实现回放缩减计划应通过，旧 guard 变异实现才应出现目标失败。

该入口保持可选，没有修改 CI 必需检查。下一条核心旅程可复用证据与缩减入口，但仍须独立定义用户结果、故障边界和验收事实。
