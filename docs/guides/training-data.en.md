[中文](training-data.md) | **English**

# Trajectory preparation and SFT

Training prefixes must come from the actual input to each generation. `[model] history_thinking = "preserve"` replays historical thinking by default; `"omit"` excludes it. Chat and Responses share this policy. Both retain newly generated thinking and train from effective engine tokens and native loss masks. This setting does not disable current reasoning generation.

Harness projects the policy into the actual HTTP request before sending, without requiring a new training-framework API or disabling current reasoning. Chat replays `reasoning_content`; Responses replays native reasoning. Omit filters both forms of history and explicit leading `<think>…</think>` blocks in assistant content, retaining quoted markers in user/tool data and ordinary text. Responses WebSocket omit uses fresh connections and full input. Native Responses replays encrypted items unchanged; summaries, IDs, or ciphertext cannot substitute for plaintext thinking.

Correct HTTP input does not establish effective tokens for every backend. Fix the tokenizer, template, and `chat_template_type`, then inspect actual engine `input_tokens`: preserve needs a template retaining thinking or a valid concat parent prefix; omit needs complete-request rendering or a changed message history that cannot match a parent containing omitted thinking. An unrecognized request header cannot select those behaviors. Existing AReaL can export effective tokens without source changes. Its support for Responses content, `include`, and streaming depends on the deployed API version; Harness support alone does not establish proxy support.


Existing token rollouts can continue training with their actual context without waiting for a complete historical audit. This setting cannot retroactively convert historical data into another mode. Ordinary KV caching does not establish parent-token continuation. Never insert archived thinking into prefixes or remove thinking from effective tokens based on HTTP messages.

## Prefer original AReaL tokens

In the Python environment used for training, save an existing `/export_trajectories` response as complete JSON. Keep `interactions` in its native serialized format. Do not substitute decoded text for tokens.

```sh
python scripts/export-training-data.py areal \
  --areal-root /path/to/AReaL \
  --input /data/export-trajectories.json \
  --output-dir /data/sft-tokens
```

Native RPC exports already contain `input_ids` and `loss_mask`; both arrays are preserved. Historical thinking, tool observations, and multiple generation regions in concat rollouts therefore remain intact without template rendering. Missing parent links and termination reasons are not invented. These samples have `scope=rollout` and an unknown template mode. Data provenance and training configuration remain responsible for task quality, Harness acceptance, and checkpoint/tokenizer compatibility.

For local objects returned by `client.export_interactions(...)`, call `samples_from_areal(interactions)` from `scripts/training_data.py` after rollout completion. It yields `(sample, audit)` pairs; write nonempty samples. Each local `ModelResponse.input_tokens + output_tokens` becomes one sample supervising only its current output. Parents of local concat leaves are included, with shared parents exported once across branches. HF and unmatched-parent requests also use actual tokens. Remote RPC masks retain their existing multiple target regions. These export styles can assign different sample weights and must not be described as an identical training distribution when mixed.

This path requires no AReaL configuration schema changes, regeneration, or new online service. External API interactions lack engine tokens. Local responses terminated by abort/length and those requiring multimodal processing are individually marked UNKNOWN.

## When only Harness HTTP trajectories are available

Input is Collector OTLP/JSON Logs: one JSON document, a JSON array, or one document per line in `.jsonl`. Expanded `{resource,eventName,attributes}` records with ordinary object maps are also supported. Include complete Turns and all retry batches. Convert protobuf to OTLP/JSON with a Collector first; the CLI does not guess binary formats.

```sh
make training-export ARGS='otlp --input /data/logs.jsonl --output-dir /data/sft-requests'
```

Each `areal.sft.request/v1` candidate includes the unchanged `request_body`, parsed `request`, current `response`, and provenance. Its prefix uses only that request's `messages`; tool schemas remain in `request.tools`. Current thinking is retained as `response.reasoning_content`. Thinking from other requests is never appended, including for short trajectories. `alignment=http_messages` and `engine_context=UNKNOWN` explicitly indicate that downstream input tokens have not been established.

Export validates event identities, continuous sequence numbers, terminal manifests, capture truncation, raw request SHA, acceptance, finish reasons, tool/result pairing, and raw arguments. Identical delivery retries are deduplicated. Conflicts, missing evidence, unknown protocols, and unsupported modalities enter audit individually without blocking other complete records. Failed, cancelled, and auxiliary requests are excluded from normal solve samples. Delivery completeness and task correctness are independent. An accepted intermediate response can belong to a failed Turn; its `turn_status` remains in provenance and does not establish task success.

Responses encrypted reasoning, summaries, and multimodal output cannot be reconstructed as ordinary text targets: use original engine tokens and the appropriate processor. Old tool outputs without `arguments_json` cannot be presented as verbatim output after argument reserialization. Keep them UNKNOWN and prefer existing AReaL token exports. Missing historical evidence does not require stopping current rollout or training.

Tokenize HTTP candidates only after establishing that the inference backend renders complete requests with the same HF template, argument-object conversion, and kwargs. Use original engine tokens for AReaL concat. An unbranched rollout alone does not establish this condition.

```sh
python scripts/export-training-data.py tokenize \
  --input /data/sft-requests/samples.jsonl \
  --output-dir /data/sft-template-tokens \
  --tokenizer /models/tokenizer \
  --backend-context request-template \
  --template-kwargs '{"enable_thinking":true,"keep_thinking":true}'
```

The tokenizer must be local; no automatic downloads or remote custom code execution occur. Tool arguments are rendered as HF/AReaL JSON objects while the candidate retains the original text. Captured `chat_template_kwargs` are inherited; conflicting explicit kwargs produce UNKNOWN. Each sample verifies that prompt tokens prefix the complete sequence and that rendering retains historical thinking, current thinking, text, and tool calls. Otherwise use original tokens rather than guessing masks. Output has `alignment=request_template`, `engine_context=not_observed`; it does not claim exact remote generation replay. This mode is for data with an established backend rendering contract.

## Connect to training

Both token modes produce `areal.sft.tokens/v1` JSONL with `input_ids`, an equal-length binary `loss_mask`, provenance, alignment level, and `quality=unreviewed`. Zero marks conditioning and one marks supervised targets. Current thinking and existing stop tokens are retained; EOS is not appended and labels are not shifted in advance. Alignment checks do not replace quality filtering, decontamination, or train/validation splitting. The training entry point consumes a sample file already selected upstream and does not select by reward.

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

The first command checks the actual AReaL dataset/collator on CPU. The second passes only `input_ids` and `loss_mask` to the existing `SFTTrainer`, using the training configuration's model, GPUs, optimizer, and scheduler. Use an interpreter with the matching AReaL training environment installed. A local check does not establish completed GPU training.

Every export writes a new directory containing `samples.jsonl`, per-record `audit.jsonl`, and `report.json` with source file SHAs and counts. Samples remain `.tmp` files until export finishes; existing data is never overwritten. `--max-length N` isolates oversized token samples without truncation; the training entry point can validate selected data with the same option. Arbitrary window splitting changes conditional context and is not a transparent repair. Original records remain intact. Use evidenced data first and re-export UNKNOWN records after obtaining evidence.

## Validation and effect boundaries

```sh
python3 -m unittest discover -s scripts/tests -p test_training_data.py
make training-smoke PYTHON=/path/to/AReaL/.venv/bin/python ARGS='--areal-root /path/to/AReaL'
```

Tests cover per-request thinking, actual AReaL hf/concat inputs, parent links and RPC export, prefixes and loss masks, missing/conflicting/cancelled records, real HF tokenization, the SFT dataset/collator, and CPU backward propagation. They establish data preparation behavior, not overall Agent improvement after training. Default preserve changes Chat inputs that previously omitted historical thinking, increases context length, and may trigger normal compaction earlier. Task quality, latency, and cost are not guaranteed unchanged. Offline export stays outside the rollout critical path. Correcting training prefixes also changes the training distribution; evaluate trained models on a comparable validation set.
