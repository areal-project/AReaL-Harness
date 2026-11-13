**中文** | [English](training-data.en.md)

# 轨迹制样与 SFT

训练前缀必须来自该次生成的真实输入。`[model] history_thinking = "preserve"` 默认回放历史 thinking，`"omit"` 省略历史 thinking；Chat 和 Responses 使用同一个策略。两种模式都保留本轮生成的 thinking，并按实际引擎 tokens 和原生 loss mask 训练。该选项不关闭模型本轮的思考能力。

策略由 Harness 在发送前投影到真实 HTTP 请求，不依赖训练框架新增接口，也不关闭本轮 thinking。Chat 回放 `reasoning_content`，Responses 回放原生 reasoning；omit 同时过滤这两类历史以及 assistant 正文开头显式的 `<think>…</think>` 块，保留用户、工具与普通正文中的引用。Responses WebSocket 的 omit 使用新连接和完整输入。密文 reasoning 在原生 Responses 中原样回放，不能用摘要、ID 或密文冒充明文 thinking。

HTTP 输入正确不等于任意后端的 tokens 已获保证。训练时固定模型 tokenizer、模板与 `chat_template_type`，直接检查实际引擎 `input_tokens`：preserve 需要模板保留历史 thinking 或正确的 concat 父前缀；omit 需要完整请求重编码，或由省略后的消息使旧含 thinking 父前缀无法匹配。不能依赖一个未被后端识别的请求头来切换这些行为。现有 AReaL 无须改源码即可导出真实 tokens；是否支持某种 Responses 内容、`include` 和流式请求取决于其现有接口版本，应按部署版本验证，不能仅凭 Harness 支持 Responses 就推定训练代理也支持。


已有 token rollout 可以按其真实上下文继续训练，无需等待全部历史轨迹审计。历史数据不能事后通过这个配置变成另一模式；普通 KV 缓存也不能证明引擎沿父 token 续接。不能从完整归档补入 thinking，或根据 HTTP 消息删除引擎 tokens 中已有的 thinking。

## 优先使用 AReaL 原始 tokens

在训练使用的 AReaL Python 环境中，把已有 `/export_trajectories` 返回的完整 JSON 保存为文件；其中 `interactions` 保持 AReaL 原生序列化格式。不要用 decode 后的文本代替 tokens。

```sh
python scripts/export-training-data.py areal \
  --areal-root /path/to/AReaL \
  --input /data/export-trajectories.json \
  --output-dir /data/sft-tokens
```

原生 RPC 导出已经包含 `input_ids` 和 `loss_mask`，转换保持这两个数组不变。`concat` 的历史 thinking、工具观察和多个生成区间因此被保留，不重新套模板。RPC 已失去的父链和终止原因不会被补造；它的 `scope=rollout`，模板模式标为 unknown。任务质量、Harness 是否受理该响应、原始 checkpoint 与 tokenizer 的匹配仍由数据来源和训练配置负责。

本机直接持有 `client.export_interactions(...)` 的对象时，也可以在 rollout 完成后调用 `scripts/training_data.py` 的 `samples_from_areal(interactions)`。它返回 `(sample, audit)` 迭代器；写出非空 sample 即可。直接对象按每次 `ModelResponse.input_tokens + output_tokens` 制样，仅当前输出区间计算 loss；本地 concat 叶子的父交互被补齐，分叉共享的父交互只导出一次。`hf` 和无匹配父节点也按实际 tokens 处理。远端 RPC 的已有多区间 mask 则原样保留，两种导出的样本权重可能不同，不能混用后声称训练分布相同。

此路径不需要修改 AReaL 配置结构、重新生成数据或接入新的线上服务。外部 API 模式没有真实 tokens，不能走这条路径；生成被 abort、length 截断或带多模态处理数据的直接对象单独记为 UNKNOWN。

## 只有 Harness HTTP 轨迹时

输入是 Collector 的 OTLP/JSON Logs：一个 JSON、JSON 数组，或每行一个 JSON 的 `.jsonl`。也支持已经展开的 `{resource,eventName,attributes}` 记录；`resource`、`attributes` 为普通对象。输入应覆盖完整 Turn，包含所有重传批次。protobuf 输入先由 Collector 转为 OTLP/JSON；CLI 不猜测二进制格式。

```sh
make training-export ARGS='otlp --input /data/logs.jsonl --output-dir /data/sft-requests'
```

每个 `areal.sft.request/v1` 候选包含完整、未经改写的 `request_body`、解析后的 `request`、本次 `response` 及来源。前缀严格使用该次请求的 `messages`，工具 schema 留在 `request.tools`；本次 thinking 保存为 `response.reasoning_content`。不会把其他请求的 thinking 拼入前缀，短轨迹也同样逐请求制作。`alignment=http_messages`、`engine_context=UNKNOWN` 明确表示尚未证明网关之后的输入 tokens。

导出核验事件身份、连续序号、终态清单、采集截断、原始请求 SHA、响应受理状态、结束原因、工具结果配对和参数原文。相同事件的重传去重，冲突记录、缺失证据、未知协议与不支持的模态单独进入 audit；不阻断其他完整记录。失败、取消和辅助模型请求不作为正常求解样本。完整送达与任务正确性是独立事实；已受理的中间响应可能来自最终失败的 Turn，来源中保留 `turn_status`，不能当作成功轨迹。

Responses 的 encrypted reasoning、summary 和多模态不能用普通文本目标重建，使用原始引擎 tokens 及对应 processor。旧工具输出没有 `arguments_json` 时，不能把重编码参数伪称为原始输出；保留 UNKNOWN，优先从已有 AReaL token 导出取样。缺少历史证据不要求停止当前 rollout 或训练。

只有确认推理后端按相同的 HF 模板、工具参数对象转换和 kwargs 重编码整次请求时，才可以进一步 tokenize。对于 AReaL concat 应直接使用前一节；仅看到一条未分叉的 rollout 不满足这个条件。

```sh
python scripts/export-training-data.py tokenize \
  --input /data/sft-requests/samples.jsonl \
  --output-dir /data/sft-template-tokens \
  --tokenizer /models/tokenizer \
  --backend-context request-template \
  --template-kwargs '{"enable_thinking":true,"keep_thinking":true}'
```

使用本地 tokenizer，不自动下载或执行远端自定义代码。工具参数按 HF/AReaL 的对象格式渲染；原文仍留在候选中。请求携带的 `chat_template_kwargs` 自动沿用，显式 kwargs 与之冲突时报 UNKNOWN。逐样本验证 prompt 是完整序列的 token 前缀，并检查模板没有丢弃历史 thinking、当前 thinking、正文或工具调用；不能满足时不猜 mask，转用原始引擎 tokens。生成样本为 `alignment=request_template`、`engine_context=not_observed`，不能宣称精确复现远端生成条件。这个模式适合已核对后端渲染契约的数据。

## 接入训练

两个 token 导出模式均产生 `areal.sft.tokens/v1` JSONL，包含 `input_ids`、等长二值 `loss_mask`、来源、对齐等级和 `quality=unreviewed`。0 表示条件，1 表示监督目标；保留当前生成的 thinking 和停止 token，不额外追加 EOS，也不预先移位 labels。对齐验收不替代任务质量筛选、去污染和训练/验证集划分。训练入口读取的是上游已经选好的样本文件，不按 reward 自行挑选。

```sh
python scripts/train-trajectory-sft.py \
  --areal-root /path/to/AReaL \
  --samples /data/selected-sft.jsonl --check-only

python scripts/train-trajectory-sft.py \
  --areal-root /path/to/AReaL \
  --samples /data/selected-sft.jsonl \
  --validation-samples /data/selected-valid.jsonl \
  --config /path/to/existing-sft.yaml
```

第一条使用真实 AReaL dataset/collator 在 CPU 检查；第二条把 `input_ids`、`loss_mask` 两列直接交给现有 `SFTTrainer`，模型、GPU、优化器和调度沿用训练侧配置。解释器需已安装该配置对应的 AReaL 训练环境。本机检查不等于 GPU 集群训练已完成。

所有导出只写入新目录，包含 `samples.jsonl`、逐条 `audit.jsonl`、输入文件 SHA 和统计 `report.json`。生成完成前只写 `.tmp` 样本，不覆盖已有数据。`--max-length N` 单独隔离超长 token 样本，不截断；训练入口可用同参数校验选中数据。重新按任意窗口切块仍会改变条件上下文，不作为透明修复。原始记录不被删除；有证据的样本可先使用，UNKNOWN 可随后补证据重导。

## 验证与效果边界

```sh
python3 -m unittest discover -s scripts/tests -p test_training_data.py
make training-smoke PYTHON=/path/to/AReaL/.venv/bin/python ARGS='--areal-root /path/to/AReaL'
```

测试覆盖逐请求 thinking、真实 AReaL hf/concat 输入、父链与 RPC 导出、前缀和 loss mask、缺失/冲突/取消隔离、真实 HF tokenizer、SFT dataset/collator 及 CPU 反向传播。它们证明制样机制；不证明训练后整体 Agent 能力提升。默认 preserve 会改变原先省略历史 thinking 的 Chat 输入，增加上下文长度并可能提前触发正常压缩；不能据此保证任务效果、延迟或成本不变。离线导出不进入 rollout 关键路径；训练数据从错误前缀改为实际条件也会改变训练分布，效果需相同设置下的验证集确认。
