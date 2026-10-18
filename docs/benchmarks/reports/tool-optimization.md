**中文** | [English](tool-optimization.en.md)

# 原生工具优化 A/B

固定版本 `acfdb2e` 与改动前 `85f4a27` 在同一个当前配置模型 `grok-4.7` 上比较。最终 12 对尝试双方均正常完成且通过独立校验；总输入 token 变化 -38.9%，工具调用变化 -46.3%，平均耗时变化 -27.9%。收益来自输出处理和编辑效率，本报告没有证明 MM480 成功率提高。

[56 次尝试的脱敏证据](tool-optimization-evidence.json)保留探索、修正和最终三轮的全部计划、结果、用量及二进制摘要。原始模型轨迹和私有模型路由未公开；这些摘要支持统计核对，不是完整公共轨迹材料。这里比较的是两个 Harness 版本，没有重新测量 Codex、Claude Code 或 RTK 的端到端表现。

## 设计与评分

四个题在首轮前按待验证的机制固定，之后没有淘汰题：`pricing` 复用仓库 lite 修复题；其余是人工构造的诊断/编辑负载。`output-tail` 包含 120 条较长的 pytest 成功进度和末尾失败；`failure-context` 包含嵌套值的多行 diff；`batch-edit` 需要修改同一文件的 12 个函数，存在重复字面量。它们都由真实模型通过生产 launcher、Core 和 Runtime 解题，运行真实测试，没有另建 Agent 循环或伪造工具输出。

最终每题每版本运行 3 次，按题目和重复序号配对，seed=163 随机交错，宿主并发为 2。macOS 26.3.2 arm64、Python 3.14.2、pytest 8.4.2，debug 构建；两个版本使用独立工作区和私有 HOME，不加载用户全局 skills。统一 Turn 上限 180 秒、stream idle 60 秒、80 次工具调用。保留当前模型/同一路由和采样设置，所有请求的记录参数一致；没有覆盖温度或推理预算。构建和其他回归在最终测量前完成。

评分在 Agent 退出后由宿主执行额外断言，并检查原测试文件未被修改。答案正确和正常完成分别记录；最终 24/24 尝试具备完整请求 usage，没有失败、超时、异常评分或丢弃样本。耗时从 launcher 启动算到退出/清理，排除构建、准备题目和评分；总耗时是各尝试时长之和，不是两个并发槽的整轮历时。输入包含缓存输入，缓存不再次相加，token 数不等于账单成本。

连通性预检发现宿主 SOCKS 代理与当前 HTTP client 构建不兼容。测量通过 `--direct` 仅清除测试子进程的代理变量；未修改全局设置或模型供给。预检不属于上述题目尝试。

## 最终 12 对结果

| 指标 | 基线 | 最终版本 | 变化 |
|---|---:|---:|---:|
| 输入 token（含缓存） | 1,245,302 | 761,023 | -38.9% |
| 其中缓存输入 | 927,616 | 449,024 | -51.6% |
| 未缓存输入 | 317,686 | 311,999 | -1.8% |
| 输出 token | 8,208 | 6,872 | -16.3% |
| 模型请求 | 115 | 77 | -33.0% |
| 工具调用 | 162 | 87 | -46.3% |
| 工具结果字节 | 204,953 | 156,284 | -23.7% |
| 每次尝试平均秒数 | 28.40 | 20.48 | -27.9% |

下表的 token 和工具调用为每组三次尝试之和；耗时为每次均值。每格均为基线 → 最终版本。

| 场景 | 输入 token | 工具调用 | 平均秒数 |
|---|---:|---:|---:|
| `pricing` | 133,381 → 128,440 | 19 → 18 | 13.54 → 12.44 |
| `failure-context` | 223,914 → 173,592 | 29 → 24 | 24.56 → 17.90 |
| `output-tail` | 678,287 → 302,552 | 56 → 25 | 45.77 → 28.13 |
| `batch-edit` | 209,720 → 156,439 | 58 → 20 | 29.74 → 23.45 |

输入节省主要来自重复的缓存上下文；未缓存输入只降低 1.8%，不能推出相同幅度的账单节省。小任务仍有工具描述/schema 的固定开销：pricing 中请求/工具数相同的两对，最终输入仍略增，不能据汇总宣称小任务稳定加速。工具调用减少也不保证模型请求或耗时同比下降。四个定向小题、三次重复和同一模型不足以推断通用成功率；缓存、网络和模型随机性仍影响时延。应在实际题集上另行验证成功率，不能把这组结果当成原 MM480 的复测或每个工具独立的消融收益。

## 轨迹驱动的修正

初版 `a138620` 的长输出样本虽然答对，但输入从基线 214,028 增至 459,684 token。按关键字过滤丢掉了多行失败上下文，摘要又在 `stdout` 和 `outputView.text` 中重复；模型为了取回证据反复回读，甚至改用文件。最终实现只折叠明确识别的成功进度行，保留未知行、失败上下文和流边界，比较包含元数据的完整序列化大小，并用 `view=raw` 明确回读原始页。`waitMs=0` 也会填满已保留的安全页，不再意外退化为一次只取 1 KiB。

中间版本的批量编辑样本均遇到笼统的匹配冲突，部分退回逐项编辑。最终工具说明要求重复文本包含函数等上下文，匹配错误指出从 1 开始的替换序号、缺失或歧义，并明确整批未写入。CAS 版本校验和失败不写入的语义不变；独立回归覆盖缺失、歧义和陈旧版本。

最终版本还修正通用日志前后缀再次 JSON 转义后的大小预算，补齐 TypeScript `applyPatches` 类型和 native host schema。确定性测试覆盖原始回读、游标、完整 diff、流边界、转义预算及原子回滚；它们验证契约，不替代模型效果测量。

## 全部计划尝试

中间版本为 `a138620` 加证据 JSON 中记录摘要的源码补丁；最终版本为 `acfdb2e`。每轮使用同一个 `85f4a27` 基线重新配对，不把不同轮的绝对耗时直接比较。

| 轮次 / 版本 | 尝试 | 正常完成且正确 | 输入 token | 工具调用 | 累计秒数 |
|---|---:|---:|---:|---:|---:|
| exploratory / baseline | 4 | 4 | 385,603 | 52 | 121.71 |
| exploratory / initial | 4 | 4 | 676,867 | 52 | 126.16 |
| paired / baseline | 12 | 12 | 1,245,623 | 164 | 297.66 |
| paired / tuned | 12 | 12 | 826,270 | 110 | 258.50 |
| final / baseline | 12 | 12 | 1,245,302 | 162 | 340.81 |
| final / final | 12 | 12 | 761,023 | 87 | 245.78 |

## 复跑与核对

使用[开发指南](../../development/README.md)在独立 checkout / Cargo target 目录构建 `85f4a27` 和 `acfdb2e`。每个 `*_BIN` 目录保存该版本的 `areal-server`、`areal-tui`、`areal-runtime`、`areal-runtime-fs` 和 `scripts/launch.py`（命名为 `launch.py`）。准备 Python 3.11+、pytest 8.4.2 和当前 Core 模型配置需要的凭据环境变量：

```sh
python3 tests/perf/native_tool_ab.py \
  --variant "baseline=$BASELINE_BIN" --variant "final=$FINAL_BIN" \
  --model-config "$HOME/.areal-harness/config.toml" \
  --case pricing --case output-tail --case failure-context --case batch-edit \
  --output target/perf/native-tool-ab --repeat 3 --seed 163 --jobs 2 --direct
```

`--direct` 是可选的子进程代理覆盖；`--pytest` 可指定 pytest 可执行文件。runner 保存 `plan.json`、`results.json` 和逐次日志/评分，目录不能复用；公开前检查脱敏范围。以下命令可独立核对最终统计：

```sh
python3 - <<'PYCODE'
import json
from pathlib import Path
p = Path("docs/benchmarks/reports/tool-optimization-evidence.json")
rows = json.loads(p.read_text())["rounds"][-1]["results"]
for variant in ("baseline", "final"):
    r = [x for x in rows if x["variant"] == variant]
    assert len(r) == 12 and all(x["usage_complete"] for x in r)
    print(variant, {
        "correct_and_completed": sum(x["grade"]["correct"] and x["completed"] for x in r),
        "input_tokens": sum(x["usage"]["inputTokens"] for x in r),
        "tool_calls": sum(x["tool_calls"] for x in r),
        "mean_seconds": round(sum(x["elapsed_s"] for x in r) / len(r), 2),
    })
PYCODE
```

统计规则见[方法](../methodology.md)，当前工具契约见[工具指南](../../guides/tools.md)。
