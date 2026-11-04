**中文** | [English](programmatic-tools.en.md)

# 程序化工具调用

`ToolPolicy.programmatic_tools`（JSON `programmaticTools`）默认开启；配置了 Runtime 且原生工具可见时增加 `tool_program`，允许模型通过 JavaScript 将工具返回值用于后续参数、分支、循环、进程等待和输出筛选。默认同时保留原生单工具入口，程序目录只列名字，不重复 schema。`programmaticToolsOnly` 默认关闭；开启须同时开启前者，并把相同原生 schema 移入程序工具目录。它只改变模型展示，不授予任何额外工具或文件权限。

```json
{"policy":{"programmaticTools":true,"programmaticToolsOnly":false}}
```

可用 `programmaticTools:false` 恢复只展示原生工具的模式。将 JSON 保存为 `[tools] extensions_file` 指定的配置文件。普通工具模式和历史协议保持兼容；Rust 的穷举 `ToolPolicy` 字面量需要提供这两个字段或使用 `..ToolPolicy::default()`。

## 执行和观察

`tool_program({code, input?, timeoutMs?})` 在新的 QuickJS 上下文执行顶层 await。没有 Node、文件、网络、模块导入、计时器或跨调用状态；文件和进程操作只能调用目录里列出的原生工具。每个调用沿原 Core/Runtime 入口完成 schema、权限、hooks、文件版本、预算与持久化。只包含本次可见的内置工具以及 `read_history/read_tool_result/edit_files`，不支持递归编排、MCP 或委派。

模型已读过文件并确定补丁和测试入口后，可以把关联修改、验证及有界回收放进同一程序。新错误、冲突、权限、UNKNOWN 或视觉判断必须回到模型；不在循环里安装依赖或更换方案。无独立工作时使用正常等待预算，不显式用 1 秒制造回收轮次。

```javascript
const e = await tools.edit_files({files:[{path:'src/a.py',patches:[{oldText:'old_a',newText:'new_a'}]},{path:'src/b.py',patches:[{oldText:'old_b',newText:'new_b'}]}]});
text(e);
if (e.success && e.data.allApplied) {
  await collect(await tools.run_command({argv:['python','-m','pytest','tests/test_feature.py','-q']}));
}
```

`tools.NAME(args)` 返回 `{success,outcome,callId,itemId,data,text,availableImages}`，`data` 是可解析的原生 JSON，`text` 保留文本。调用按顺序完成，`await` 可用，`Promise.all` 也不会增加原生并发。`text(value)` 返回选定观察；`text(nativeResult)` 在 JSON 可解析时只展示 `{itemId,data}`；身份、成功状态和错误仍在强制子回执中，程序内部原始对象及 `data/text` 不变。同一原生结果对象的相同展示在一个程序内只发送一次（包括 `collect` 后再次 `text`）；对象改变仍会发送新的展示。`image(nativeResult)` 只转发本次父调用的真实子结果图片。模型需要新的视觉或业务判断时应返回观察，不能让脚本代替该判断。原生进程的 `commandStatus/outputReadComplete/processId` 和每个子调用终态属于强制回执，无法通过筛选隐藏。

`await collect(processResult, {timeoutMs?, maxReads?})` 是现有程序内的回收助手，只对传入结果的同一进程调用 `read_process`，不启动或重试命令。它自动展示每页观察，返回最后一个原生结果，无需再次 `text()`。默认总等待 540000 毫秒、最多 16 次读取，可显式设为 0–1800000 毫秒和 0–64 次；实际还受程序剩余时间、原生调用次数、取消及共享预算限制。按退出和输出读完状态结束，失败立即返回；到达上限或已退出且游标无进展时保留真实状态、游标和停止原因，不推断证据充分或测试通过。它不适用于需要先观察交互提示或已有独立工作的等待。

中间原文保留在独立 `DynamicToolCall` 中，`ToolExecution.parentCallId` 可选字段关联父调用。投影给模型时只发送实际模型发起的父 function_call 和父结果，不伪造子 function_call；使用 `read_history(itemId)` 可读回已记录子观察。原生结果的分页/快照限制保持不变，不会把未读取的进程输出伪装成已读取。

## 预算、失败与恢复

单程序最多 64 次叶子调用，代码及显式 input 的序列化 JSON 合计 64 KiB，单次叶子参数 64 KiB，解释器内存 64 MiB、栈 512 KiB，选定文本按真实 UTF-8 字节计量，最多 1 MiB，最多四项图片选择。默认墙钟 600 秒，`timeoutMs` 范围 1–1800000；全 Turn 的原始时限仍有效。父和叶子共享工具次数、输出与 Agent 预算，文本筛选不豁免执行成本。长程序会受 CPU 中断检查，不能通过无限循环绕过时限。

超过 16 KiB 的选定文本先持久保存完整 JSON，再向模型提供有明确标记的预览和 `read_tool_result` 引用；不会因为展示长度打断后续步骤。所有子操作状态、进程回执和真实图片保持完整。无法保存原文或不允许回取时保留原始有界结果，仍受总输出预算约束。超过 1 MiB 的归档上限仍显式报错，已完成效果不会回滚。

已知失败可由脚本读取并作显式判断；UNKNOWN、取消和共享预算耗尽停止后续派发，不能被 catch 绕过。已产生的效果不回滚，不自动重试。取消先结算已准入叶子并退出解释器。Core 重启只重建父子回执，将不确定结果保留为 UNKNOWN；不恢复 JavaScript 状态、不重新执行代码。

该实现支持数据依赖编排与选择观察，不包含 Codex 的跨模型轮 yield/wait 单元或并行叶子调度。这些能力不代表完整产品兼容。减少模型请求未必减少净 token 或总耗时；脚本、目录、强制回执、额外读取和失败恢复都可能抵消收益。可用既有轨迹回放验证确定性恢复错误与投影开销，用同一操作集回归排除提前失败导致的假提速。真实模型采用率、缓存命中和任务质量仍须与机制证据区分；跨任务能力声明遵循[评测方法](../benchmarks/methodology.md)。

已知范围的多文件读取可直接在一个程序中 `for (const path of paths) text(await tools.read_file({path,offset:1,limit:80}));`。正文和 `fileVersion/nextLine` 一并返回；未知代码的理解仍由模型完成。进程到达循环或时间上限时保留真实状态、句柄和游标，不自动认定完成。`edit_files` 可直接调用，不依赖启用 PTC；原文件工具继续兼容，详见[工具合同](tools.md)。批量容器及其每个叶子均计入程序的 64 次上限和 Turn 工具预算；准入按请求的最大叶子数保守预留。

## 精简交互候选

`policy.compactTools:true` 将原生常用层收敛为读取、搜索、`edit_files`、命令/验证、进程交互、图像、环境事实和原文回取；`tool_search` 按名称/说明发现其余已授权原生能力，完整 schema 在下一次模型请求可见，Turn 结束清空。底层文件、恢复、技能、服务和协作入口仍注册、受原权限及 allowlist 约束；批量编辑在内部调用底层工具。若 allowlist 不允许发现入口，保留原展示，避免让能力不可达。MCP 的 `lazyMcpSchemas` 仍独立配置。

精简配置使用较短基础说明和程序描述；不改变执行内核。`programmaticTools` 可独立开关，不按模型名称选择。`programmaticToolsOnly` 仍会把 schema 移入程序描述，不能据入口减少推断 token 下降。可将下面片段并入现有 extensions 文件，保留部署原有 tools/hooks/权限；它是显式候选，不是通用性能默认。

```json
{"policy":{"compactTools":true,"programmaticTools":true,"programmaticToolsOnly":true,"programmaticDirectTools":["edit_files"],"resultViews":{"repeatedObservations":true}}}
```

准入分别核对最终请求大小、真实采用率、实际 provider 输入/缓存/输出及总结/恢复子请求。确定性回放只能证明操作与权限不变量，不能证明模型选择了组合路径。

程序结果分别报告 `programCompleted`（解释器结束）、`allChildrenSucceeded`（每个原生子调用均成功）和 `pendingProcesses`（按进程最新收据去重）。外层 success 只有解释器及全部子调用成功才为 true；后续成功不能覆盖先前失败，已知失败对照仍如实保留失败，由模型判断其预期含义。此为结果契约变化，不自动阻断已明确编排的后续步骤，也不添加重试。

保留编辑直达的组合配置使用 [compact-composition.json](../../examples/tool-profiles/compact-composition.json)：大段文件创建保持 `edit_files` 直达，收到 `allApplied` 后将已选执行和回收放入程序；小补丁可与测试一起编排。`collect` 自动展示观察，不再手写轮询循环或重复 `text()`。默认配置不变。原 [compact-programmatic.json](../../examples/tool-profiles/compact-programmatic.json) 仅保留为全程序化对照：它把 schema 搬入描述，可能增加固定输入和代码转义/恢复成本，不能以较小菜单证明效率。比较最终说明、schema、历史、缓存输入与未缓存输入，不能只比较命中率；减少高缓存的机械轮次也会改变该比例。

`programmaticDirectTools`（默认空数组）可在 `programmaticToolsOnly:true` 时保留最多 16 个不同原生工具的直达入口；仅与当前可见、已授权目录求交集，不能借此暴露隐藏工具。直达定义不再重复嵌入程序目录，`tools.NAME` 内部调用仍可用。不启用 only 模式时配置非空数组会报错。显式组合配置使用 `programmaticDirectTools:["edit_files"]`：保留大段文件的 JSON 表达，同时将确定的读取、执行和回收集中于程序入口。需要更自由的直接操作时可显式选择 only=false 并清空该数组；采用率与净成本必须单独验证。Rust 的完整 `ToolPolicy` 字面量需包含新字段或使用默认展开。

`input` 是可选 JSON 对象，作为程序中的 `input` 实参解析，不拼接进 JavaScript 源码。把小补丁、正则和短脚本/argv 放入该对象可以避免第二层 JavaScript 引号与反斜杠；权限、版本检查和预算仍沿原叶子入口执行。数据不能成为宿主代码，`__proto__` 也只是 JSON 键。大段文件正文继续使用 edit_files 直达。

```javascript
tool_program({input:{edit:{files:[{path:"src/a.py",patches:[{oldText:"old",newText:"new"}]}]},check:{argv:["python","-m","pytest","tests/test_a.py"]}},code:"const e=await tools.edit_files(input.edit);text(e);if(e.success && e.data.allApplied) await collect(await tools.verify_command(input.check));"});
```

检查仍须由模型根据公开要求选择。保留仍相关的验证与失败对照，在影响对应条件的修改后重新执行；未覆盖的要求显式报告。程序只能组合已经确定的动作，不能以少做检查换取较低消耗。
