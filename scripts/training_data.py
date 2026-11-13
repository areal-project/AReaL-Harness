"""离线制样：区分客户端消息与引擎 tokens，不从归档推测生成前缀。"""

from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
import hashlib
import json
from pathlib import Path


class EvidenceError(ValueError):
    """仅隔离当前记录，保留其诊断。"""


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def json_value(value):
    return json.loads(value) if isinstance(value, str) else value


def any_value(value):
    for key in ("stringValue", "boolValue", "doubleValue"):
        if key in value:
            return value[key]
    if "intValue" in value:
        return int(value["intValue"])
    if "arrayValue" in value:
        return [any_value(v) for v in value["arrayValue"].get("values", [])]
    if "kvlistValue" in value:
        return attributes(value["kvlistValue"].get("values", []))
    raise EvidenceError("unsupported_otlp_value")


def attributes(values):
    result = {}
    for item in values:
        if item["key"] in result:
            raise EvidenceError("duplicate_attribute")
        result[item["key"]] = any_value(item["value"])
    return result


def log_records(document):
    """接受 Collector OTLP/JSON 或已经展开的 {resource,eventName,attributes}。"""
    if isinstance(document, list):
        for value in document:
            yield from log_records(value)
    elif "resourceLogs" in document:
        for resource in document["resourceLogs"]:
            attrs = attributes(resource.get("resource", {}).get("attributes", []))
            for scope in resource.get("scopeLogs", []):
                for record in scope.get("logRecords", []):
                    yield {
                        "resource": attrs,
                        "eventName": record.get("eventName"),
                        "attributes": attributes(record.get("attributes", [])),
                    }
    elif "attributes" in document:
        yield document
    else:
        raise EvidenceError("expected_otlp_logs")


def read_documents(path):
    if Path(path).suffix in {".jsonl", ".ndjson"}:
        with Path(path).open(encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    yield json.loads(line)
        return
    text = Path(path).read_text(encoding="utf-8")
    try:
        yield json.loads(text)
    except json.JSONDecodeError:
        for line in text.splitlines():
            if line.strip():
                yield json.loads(line)


def _turn_error(records):
    seen = {}
    for record in records:
        a = record["attributes"]
        event_id = a.get("areal.event.id")
        if not event_id:
            return "missing_event_identity"
        if event_id in seen and seen[event_id] != record:
            return "conflicting_event_identity"
        seen[event_id] = record
    events = list(seen.values())
    if any(r["attributes"].get("areal.capture.truncated") is True for r in events):
        return "capture_truncated"
    if any(
        r["attributes"].get("areal.trajectory.schema_version") != "areal.trajectory/v1"
        for r in events
    ):
        return "unknown_trajectory_schema"
    sequences = [r["attributes"].get("areal.event.sequence") for r in events]
    if any(type(v) is not int for v in sequences):
        return "missing_event_sequence"
    events.sort(key=lambda r: r["attributes"]["areal.event.sequence"])
    if sorted(sequences) != list(range(1, len(events) + 1)):
        return "event_sequence_gap_or_conflict"
    terminal = events[-1]
    if terminal.get("eventName") != "areal.turn.completed":
        return "missing_terminal_manifest"
    a = terminal["attributes"]
    manifest = "".join(
        f"{r['attributes']['areal.event.sequence']}:{r['attributes']['areal.event.id']}\n"
        for r in events
    )
    if a.get("areal.turn.event_count") != len(events) or a.get(
        "areal.turn.events_sha256"
    ) != digest(manifest):
        return "terminal_manifest_mismatch"
    return None


def validate_tools(messages):
    pending = set()
    for message in messages:
        role = message.get("role")
        if role not in {"system", "developer", "user", "assistant", "tool"}:
            raise EvidenceError("unsupported_message_role")
        content = message.get("content")
        if content is not None and not isinstance(content, str):
            raise EvidenceError("multimodal_or_nontext_content")
        if role == "tool":
            call_id = message.get("tool_call_id")
            if call_id not in pending:
                raise EvidenceError("orphan_or_duplicate_tool_result")
            pending.remove(call_id)
            continue
        if pending:
            raise EvidenceError("missing_tool_result")
        for call in message.get("tool_calls", []):
            call_id = call.get("id")
            if role != "assistant" or not call_id or call_id in pending:
                raise EvidenceError("invalid_or_duplicate_tool_call")
            if call.get("type") != "function" or not call.get("function", {}).get("name"):
                raise EvidenceError("unsupported_tool_call")
            if not isinstance(call["function"].get("arguments"), str):
                raise EvidenceError("nonstring_tool_arguments")
            pending.add(call_id)
    if pending:
        raise EvidenceError("missing_tool_result")


def assistant_message(output):
    output = json_value(output)
    if not isinstance(output, list) or len(output) != 1 or output[0].get("role") != "assistant":
        raise EvidenceError("unsupported_output_messages")
    text, reasoning, calls = [], [], []
    phase = 0
    for part in output[0].get("parts", []):
        kind = part.get("type")
        if kind == "reasoning":
            if phase or part.get("source", {}).get("kind") != "text":
                raise EvidenceError("nonchat_reasoning_order_or_summary")
            reasoning.append(part["content"])
        elif kind == "text":
            if phase > 1:
                raise EvidenceError("interleaved_tool_output")
            phase = 1
            text.append(part["content"])
        elif kind == "tool_call":
            phase = 2
            raw = part.get("arguments_json")
            if not isinstance(raw, str):
                raise EvidenceError("missing_raw_tool_arguments")
            try:
                parsed = json.loads(raw)
            except ValueError:
                parsed = raw
            if parsed != part.get("arguments"):
                raise EvidenceError("tool_arguments_projection_mismatch")
            calls.append(
                {
                    "id": part["id"],
                    "type": "function",
                    "function": {"name": part["name"], "arguments": raw},
                }
            )
        else:
            raise EvidenceError("unsupported_output_part")
    if not text and not calls:
        raise EvidenceError("empty_response")
    if len({c["id"] for c in calls}) != len(calls):
        raise EvidenceError("duplicate_output_tool_call")
    message = {"role": "assistant", "content": "".join(text) if text else None}
    if reasoning:
        message["reasoning_content"] = "".join(reasoning)
    if calls:
        message["tool_calls"] = calls
    return message


def requests_from_logs(records):
    """逐请求输出候选和审计记录；不从完整 Turn 拼接训练前缀。"""
    groups = defaultdict(list)
    request_events = defaultdict(set)
    for record in records:
        a, resource = record["attributes"], record.get("resource", {})
        groups[
            (resource.get("service.instance.id"), a.get("areal.thread.id"), a.get("areal.turn.id"))
        ].append(record)
        if a.get("areal.model.request.id"):
            request_events[(resource.get("service.instance.id"), a["areal.model.request.id"])].add(
                (a.get("areal.thread.id"), a.get("areal.turn.id"), a.get("areal.event.id"))
            )
    for identity, turn in groups.items():
        error = _turn_error(turn) if all(identity) else "missing_source_identity"
        seen_events = set()
        for record in turn:
            a, resource = record["attributes"], record.get("resource", {})
            if record.get("eventName") != "gen_ai.client.inference.operation.details":
                continue
            event_id = a.get("areal.event.id")
            if event_id and event_id in seen_events:
                continue
            seen_events.add(event_id)
            source = {
                "installation_id": identity[0],
                "thread_id": identity[1],
                "turn_id": identity[2],
                "event_id": event_id,
                "request_id": a.get("areal.model.request.id"),
                "response_id": a.get("gen_ai.response.id"),
                "request_sha256": a.get("areal.model.request.sha256"),
                "history_thinking": a.get("areal.model.request.history_thinking", "unknown"),
                "build_revision": resource.get("service.build.revision", "unknown"),
                "event_sha256": digest(json.dumps(record, sort_keys=True, ensure_ascii=False)),
                "turn_status": next(
                    (
                        r["attributes"].get("areal.turn.status")
                        for r in turn
                        if r.get("eventName") == "areal.turn.completed"
                    ),
                    "unknown",
                ),
            }
            audit = {"source": source, "status": "UNKNOWN", "reason": error}
            sample = None
            try:
                if error:
                    raise EvidenceError(error)
                if a.get("areal.model.request.purpose") != "solve":
                    audit.update(status="SKIPPED", reason="auxiliary_request")
                    yield None, audit
                    continue
                if "areal.model.response.accepted" not in a:
                    raise EvidenceError("missing_acceptance_evidence")
                if a.get("areal.model.response.accepted") is not True or a.get("error.type"):
                    audit.update(status="SKIPPED", reason="response_not_accepted")
                    yield None, audit
                    continue
                if a.get("areal.model.request.protocol") != "chat-completions":
                    raise EvidenceError("requires_engine_tokens_for_protocol")
                if a.get("areal.model.adapter.version") != "areal.model/v1":
                    raise EvidenceError("unknown_model_adapter")
                raw = a.get("areal.model.request.body")
                if not isinstance(raw, str) or digest(raw) != source["request_sha256"]:
                    raise EvidenceError("request_hash_mismatch_or_missing")
                key = (identity[0], source["request_id"])
                if not key[1] or len(request_events[key]) != 1:
                    raise EvidenceError("missing_or_duplicate_request_id")
                request = json.loads(raw)
                validate_tools(request["messages"])
                reasons = json_value(a.get("gen_ai.response.finish_reasons"))
                if reasons not in (["stop"], ["tool_calls"]):
                    raise EvidenceError("incomplete_or_unknown_finish_reason")
                response = assistant_message(a.get("gen_ai.output.messages"))
                source["response_sha256"] = digest(
                    json.dumps(response, sort_keys=True, ensure_ascii=False)
                )
                if (reasons == ["tool_calls"]) != bool(response.get("tool_calls")):
                    raise EvidenceError("finish_reason_output_mismatch")
                sample = {
                    "schema": "areal.sft.request/v1",
                    "id": f"{key[0]}:{key[1]}",
                    "alignment": "http_messages",
                    "engine_context": "UNKNOWN",
                    "quality": "unreviewed",
                    "source": source,
                    "request_body": raw,
                    "request": request,
                    "response": response,
                }
                audit.update(status="CANDIDATE", reason=None)
            except (EvidenceError, ValueError, TypeError, KeyError, AttributeError) as exc:
                audit["reason"] = str(exc) if isinstance(exc, EvidenceError) else "malformed_record"
            yield sample, audit


def validate_sft(sample, max_length=None):
    ids, mask = sample["input_ids"], sample["loss_mask"]
    if not ids or len(ids) != len(mask) or any(type(t) is not int or t < 0 for t in ids):
        raise EvidenceError("invalid_input_ids_or_shape")
    if any(type(v) not in {int, bool} or v not in (0, 1) for v in mask) or not any(mask):
        raise EvidenceError("invalid_or_empty_loss_mask")
    if mask[0]:
        raise EvidenceError("unconditioned_first_token")
    if max_length is not None and len(ids) > max_length:
        raise EvidenceError("overlength_no_truncation")
    for field in ("input_ids", "loss_mask"):
        expected = sample.get("source", {}).get(f"{field}_sha256")
        if expected and digest(json.dumps(sample[field], separators=(",", ":"))) != expected:
            raise EvidenceError("tokens_or_mask_changed_after_export")
    return {"input_ids": ids, "loss_mask": mask}


def samples_from_areal(interactions):
    """在已有 export_interactions() 之后调用，不改变 rollout 与生成策略。"""
    # 本地 concat 导出只返回叶子；父响应也要监督一次，分叉共享父节点不能重复加权。
    expanded = {}
    invalid = set()
    for key, leaf in interactions.items():
        chain, node = set(), leaf
        while node is not None:
            interaction_id = node.interaction_id or (key if node is leaf else None)
            if not interaction_id or interaction_id in chain:
                invalid.update(chain)
                invalid.add(key)
                break
            chain.add(interaction_id)
            if interaction_id in expanded:
                if expanded[interaction_id] is not node:
                    invalid.add(interaction_id)
                break
            expanded[interaction_id] = node
            node = node.parent
    for interaction_id, interaction in expanded.items():
        audit = {"id": interaction_id, "status": "UNKNOWN", "reason": None}
        sample = None
        try:
            if interaction_id in invalid:
                raise EvidenceError("conflicting_or_cyclic_interaction_identity")
            response = interaction.model_response
            if response is not None:
                if response.input_images:
                    raise EvidenceError("multimodal_tokens_require_processor")
                if response.stop_reason not in {"stop", "tool_calls"}:
                    raise EvidenceError("incomplete_generation")
                ids = list(response.input_tokens) + list(response.output_tokens)
                mask = [0] * len(response.input_tokens) + [1] * len(response.output_tokens)
                scope = "request"
            else:
                if not interaction.has_tensor_data:
                    raise EvidenceError("external_api_has_no_engine_tokens")
                data = interaction.to_tensor_dict()
                if set(data) - {
                    "input_ids",
                    "loss_mask",
                    "attention_mask",
                    "logprobs",
                    "versions",
                    "rewards",
                    "original_rewards",
                }:
                    raise EvidenceError("unsupported_tensor_fields")
                if data["input_ids"].ndim != 2 or data["input_ids"].shape[0] != 1:
                    raise EvidenceError("expected_single_rollout_tensor")
                if data["loss_mask"].shape != data["input_ids"].shape:
                    raise EvidenceError("invalid_loss_mask_shape")
                if data["attention_mask"].shape != data["input_ids"].shape:
                    raise EvidenceError("invalid_attention_mask_shape")
                if not data["attention_mask"].all():
                    raise EvidenceError("padded_rollout_requires_lengths")
                ids = data["input_ids"][0].tolist()
                mask = data["loss_mask"][0].tolist()
                scope = "rollout"
            sample = {
                "schema": "areal.sft.tokens/v1",
                "id": interaction_id,
                "alignment": "engine_tokens",
                "scope": scope,
                "quality": "unreviewed",
                "input_ids": ids,
                "loss_mask": mask,
                "source": {
                    "interaction_id": interaction_id,
                    "chat_template_type": interaction.chat_template_type
                    if response is not None
                    else "unknown",
                    "history_thinking": getattr(interaction, "history_thinking", "unknown"),
                    "parent_id": interaction.parent.interaction_id if interaction.parent else None,
                    "input_ids_sha256": digest(json.dumps(ids, separators=(",", ":"))),
                    "loss_mask_sha256": digest(json.dumps(mask, separators=(",", ":"))),
                },
            }
            validate_sft(sample)
            audit.update(status="READY", reason=None)
        except (EvidenceError, ValueError, KeyError, TypeError, AttributeError) as exc:
            sample = None
            audit["reason"] = (
                str(exc) if isinstance(exc, EvidenceError) else "malformed_interaction"
            )
        yield sample, audit


def tokenize_request(sample, tokenizer, template_kwargs=None):
    """只适用于已确定按该模板重编码的后端；concat 必须走原始 tokens。"""
    if sample.get("schema") != "areal.sft.request/v1":
        raise EvidenceError("expected_request_sample")
    raw = sample["request_body"]
    if digest(raw) != sample["source"]["request_sha256"] or json.loads(raw) != sample["request"]:
        raise EvidenceError("request_changed_after_capture")
    request, response = sample["request"], sample["response"]
    if sample["source"].get("response_sha256") != digest(
        json.dumps(response, sort_keys=True, ensure_ascii=False)
    ):
        raise EvidenceError("response_changed_after_capture")
    validate_tools(request["messages"])
    kwargs = dict(request.get("chat_template_kwargs") or {})
    if any(
        key in kwargs and kwargs[key] != value for key, value in (template_kwargs or {}).items()
    ):
        raise EvidenceError("template_kwargs_disagree_with_request")
    kwargs.update(template_kwargs or {})
    if set(kwargs) & {
        "messages",
        "conversation",
        "tools",
        "tokenize",
        "add_generation_prompt",
        "return_tensors",
        "return_dict",
    }:
        raise EvidenceError("reserved_template_keyword")
    if request.get("tools"):
        kwargs["tools"] = request["tools"]
    messages = deepcopy(request["messages"])
    template_response = deepcopy(response)
    # HF 工具模板与 AReaL 的 _parse_tool_call_arguments 接收对象参数；原始请求仍完整保留。
    for message in messages + [template_response]:
        for call in message.get("tool_calls", []):
            call["function"]["arguments"] = json.loads(call["function"]["arguments"])
    prompt = tokenizer.apply_chat_template(
        messages, tokenize=True, add_generation_prompt=True, **kwargs
    )
    complete = messages + [template_response]
    full = tokenizer.apply_chat_template(
        complete, tokenize=True, add_generation_prompt=False, **kwargs
    )
    # transformers 5 默认返回 BatchEncoding，4 默认返回 token 列表。
    if hasattr(prompt, "keys"):
        prompt = prompt["input_ids"]
    if hasattr(full, "keys"):
        full = full["input_ids"]
    if full[: len(prompt)] != prompt or len(full) <= len(prompt):
        raise EvidenceError("template_is_not_prefix_preserving_use_engine_tokens")
    # 部分模板会静默丢弃 reasoning_content；这种样本不能当作已监督了当前 thinking。
    rendered = tokenizer.apply_chat_template(
        complete, tokenize=False, add_generation_prompt=False, **kwargs
    )
    rendered_prompt = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True, **kwargs
    )
    if not rendered.startswith(rendered_prompt):
        raise EvidenceError("rendered_template_prefix_mismatch")
    for message in messages:
        if (
            message.get("role") == "assistant"
            and message.get("reasoning_content")
            and message["reasoning_content"] not in rendered_prompt
        ):
            raise EvidenceError("template_dropped_historical_thinking_use_engine_tokens")
    suffix = rendered[len(rendered_prompt) :]
    for field in ("content", "reasoning_content"):
        if response.get(field) and response[field] not in suffix:
            raise EvidenceError(f"template_dropped_current_{field}")
    for call in response.get("tool_calls", []):
        function = call["function"]
        try:
            arguments = json.loads(function["arguments"])
        except ValueError as exc:
            raise EvidenceError("invalid_current_tool_arguments") from exc
        values = []
        decoder = json.JSONDecoder()
        for offset, char in enumerate(suffix):
            if char in "{[":
                try:
                    value, _ = decoder.raw_decode(suffix, offset)
                    values.append(value)
                    if isinstance(value, dict):
                        values.extend(value.values())
                except ValueError:
                    pass
        if function["name"] not in suffix or arguments not in values:
            raise EvidenceError("template_dropped_or_changed_current_tool_call")
    result = {
        "schema": "areal.sft.tokens/v1",
        "id": sample["id"],
        "alignment": "request_template",
        "engine_context": "not_observed",
        "template_tool_arguments": "json_objects",
        "source": {
            **sample["source"],
            "input_ids_sha256": digest(json.dumps(full, separators=(",", ":"))),
            "loss_mask_sha256": digest(
                json.dumps(
                    [0] * len(prompt) + [1] * (len(full) - len(prompt)), separators=(",", ":")
                )
            ),
        },
        "quality": sample["quality"],
        "input_ids": full,
        "loss_mask": [0] * len(prompt) + [1] * (len(full) - len(prompt)),
    }
    validate_sft(result)
    return result


def load_sft_dataset(path, max_length=None):
    """返回 SFTTrainer 直接消费的两个列；不重新套模板或移位标签。"""
    from datasets import Dataset, Features, Sequence, Value

    def generate(source_path, limit, source_sha256):
        count = 0
        for document in read_documents(source_path):
            for sample in document if isinstance(document, list) else [document]:
                if sample.get("schema") != "areal.sft.tokens/v1" or sample.get("alignment") not in {
                    "engine_tokens",
                    "request_template",
                }:
                    raise EvidenceError("expected_aligned_token_sample")
                yield validate_sft(sample, limit)
                count += 1
        if not count:
            raise EvidenceError("empty_training_dataset")

    with Path(path).open("rb") as stream:
        source_sha = hashlib.file_digest(stream, "sha256").hexdigest()
    # 使用 Arrow 磁盘映射，不把所有长前缀及其 Python 整数同时留在训练进程内存中。
    # 内容摘要参与缓存身份，原路径下替换样本也不会误读旧缓存。
    return Dataset.from_generator(
        generate,
        gen_kwargs={
            "source_path": str(Path(path).resolve()),
            "limit": max_length,
            "source_sha256": source_sha,
        },
        features=Features(
            {"input_ids": Sequence(Value("int64")), "loss_mask": Sequence(Value("int64"))}
        ),
        writer_batch_size=16,
    )
