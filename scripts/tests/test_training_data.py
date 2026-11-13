"""训练前缀以请求或引擎 tokens 为准，归档 thinking 不参与猜测。"""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest

SCRIPTS = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("training_data", SCRIPTS / "training_data.py")
data = importlib.util.module_from_spec(spec)
spec.loader.exec_module(data)


def seal(records):
    for i, r in enumerate(records, 1):
        r["attributes"].update({"areal.event.sequence": i, "areal.event.id": f"event-{i}"})
    manifest = "".join(f"{i}:event-{i}\n" for i in range(1, len(records) + 1))
    records[-1]["attributes"].update(
        {
            "areal.turn.event_count": len(records),
            "areal.turn.events_sha256": data.digest(manifest),
            "areal.turn.status": "completed",
        }
    )
    return records


def turn():
    def event(name, attrs=None):
        return {
            "resource": {
                "service.instance.id": "install-1",
                "service.build.revision": "source-sha",
            },
            "eventName": name,
            "attributes": {
                "areal.thread.id": "thread-1",
                "areal.turn.id": "turn-1",
                "areal.trajectory.schema_version": "areal.trajectory/v1",
                **(attrs or {}),
            },
        }

    call = {
        "id": "call-1",
        "type": "function",
        "function": {"name": "read", "arguments": '{ "path": "中文" }'},
    }
    first_messages = [{"role": "user", "content": "question"}]
    second_messages = first_messages + [
        {"role": "assistant", "content": "A1", "tool_calls": [call]},
        {"role": "tool", "tool_call_id": "call-1", "content": "observation"},
    ]
    records = [event("areal.user_prompt")]
    for index, messages in enumerate([first_messages, second_messages], 1):
        body = json.dumps({"model": "model", "messages": messages, "stream": True})
        parts = [
            {
                "type": "reasoning",
                "source": {"kind": "text", "id": "r", "index": 0},
                "content": f"R{index}",
            },
            {"type": "text", "content": f"A{index}"},
        ]
        if index == 1:
            parts.append(
                {
                    "type": "tool_call",
                    "id": "call-1",
                    "name": "read",
                    "arguments": {"path": "中文"},
                    "arguments_json": call["function"]["arguments"],
                }
            )
        records.append(
            event(
                "gen_ai.client.inference.operation.details",
                {
                    "areal.model.request.id": f"request-{index}",
                    "gen_ai.response.id": f"response-{index}",
                    "areal.model.request.body": body,
                    "areal.model.request.sha256": data.digest(body),
                    "areal.model.adapter.version": "areal.model/v1",
                    "areal.model.request.purpose": "solve",
                    "areal.model.request.protocol": "chat-completions",
                    "areal.model.response.accepted": True,
                    "gen_ai.response.finish_reasons": json.dumps(
                        ["tool_calls" if index == 1 else "stop"]
                    ),
                    "gen_ai.output.messages": json.dumps([{"role": "assistant", "parts": parts}]),
                },
            )
        )
    records.append(event("areal.turn.completed"))
    return seal(records)


class Tokenizer:
    def __init__(self, drops_reasoning=False, breaks_prefix=False, drops_tools=False):
        self.drops_reasoning = drops_reasoning
        self.breaks_prefix = breaks_prefix
        self.drops_tools = drops_tools

    def apply_chat_template(self, messages, tokenize, add_generation_prompt, **kwargs):
        text = ""
        for message in messages:
            text += f"<{message['role']}>"
            if not self.drops_reasoning:
                text += message.get("reasoning_content", "")
            text += message.get("content") or ""
            if message.get("tool_calls") and not self.drops_tools:
                text += json.dumps(message["tool_calls"])
            text += "</end>"
        if add_generation_prompt:
            text += "<assistant>"
        if self.breaks_prefix and not add_generation_prompt:
            text = "different:" + text
        return [ord(c) for c in text] if tokenize else text


def interaction(key, input_tokens, output_tokens, parent=None):
    return SimpleNamespace(
        interaction_id=key,
        parent=parent,
        chat_template_type="concat",
        model_response=SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            input_images=[],
            stop_reason="stop",
        ),
    )


class TrainingDataTests(unittest.TestCase):
    def test_each_request_uses_actual_prompt_and_current_reasoning(self):
        records = turn()
        original = deepcopy(records)
        rows = list(data.requests_from_logs(records))
        self.assertEqual([a["status"] for _, a in rows], ["CANDIDATE"] * 2)
        first, second = [s for s, _ in rows]
        self.assertNotIn("R1", second["request_body"])
        self.assertEqual(first["response"]["reasoning_content"], "R1")
        self.assertEqual(second["response"]["reasoning_content"], "R2")
        self.assertEqual(
            first["response"]["tool_calls"][0]["function"]["arguments"], '{ "path": "中文" }'
        )
        tokens = data.tokenize_request(second, Tokenizer())
        prefix = "".join(chr(t) for t, m in zip(tokens["input_ids"], tokens["loss_mask"]) if not m)
        target = "".join(chr(t) for t, m in zip(tokens["input_ids"], tokens["loss_mask"]) if m)
        self.assertNotIn("R1", prefix)
        self.assertIn("observation", prefix)
        self.assertIn("R2A2", target)
        self.assertEqual(records, original)

    def test_delivery_retries_deduplicate_but_conflicts_quarantine_turn(self):
        records = turn()
        self.assertEqual(len(list(data.requests_from_logs(records + [deepcopy(records[1])]))), 2)
        bad = deepcopy(records[1])
        bad["attributes"]["gen_ai.response.id"] = "different"
        rows = list(data.requests_from_logs(records + [bad]))
        self.assertTrue(
            all(s is None and a["reason"] == "conflicting_event_identity" for s, a in rows)
        )

    def test_gaps_bad_hash_and_truncation_do_not_poison_other_turns(self):
        for mutation, reason in [
            (lambda r: r.pop(0), "event_sequence_gap_or_conflict"),
            (lambda r: r.pop(), "missing_terminal_manifest"),
            (
                lambda r: r[1]["attributes"].update({"areal.capture.truncated": True}),
                "capture_truncated",
            ),
            (
                lambda r: r[-1]["attributes"].update({"areal.turn.events_sha256": "bad"}),
                "terminal_manifest_mismatch",
            ),
        ]:
            with self.subTest(reason=reason):
                records = turn()
                mutation(records)
                good = turn()
                for r in good:
                    r["attributes"]["areal.turn.id"] = "good-turn"
                    r["resource"]["service.instance.id"] = "install-good"
                rows = list(data.requests_from_logs(records + good))
                self.assertEqual(sum(s is not None for s, _ in rows), 2)
                self.assertIn(reason, [a["reason"] for _, a in rows])
        records = turn()
        records[1]["attributes"]["areal.model.request.sha256"] = "bad"
        rows = list(data.requests_from_logs(records))
        self.assertIsNone(rows[0][0])
        self.assertIsNotNone(rows[1][0])

    def test_cancel_auxiliary_responses_and_legacy_tool_args_are_isolated(self):
        for attrs, reason in [
            ({"areal.model.response.accepted": False}, "response_not_accepted"),
            ({"error.type": "operation_aborted"}, "response_not_accepted"),
            ({"areal.model.request.purpose": "summary"}, "auxiliary_request"),
            ({"areal.model.request.protocol": "responses"}, "requires_engine_tokens_for_protocol"),
            (
                {"gen_ai.response.finish_reasons": '["length"]'},
                "incomplete_or_unknown_finish_reason",
            ),
        ]:
            with self.subTest(reason=reason):
                records = turn()
                records[1]["attributes"].update(attrs)
                rows = list(data.requests_from_logs(records))
                self.assertEqual(rows[0][1]["reason"], reason)
                self.assertIsNotNone(rows[1][0])
        records = turn()
        parts = json.loads(records[1]["attributes"]["gen_ai.output.messages"])
        del parts[0]["parts"][2]["arguments_json"]
        records[1]["attributes"]["gen_ai.output.messages"] = parts
        self.assertEqual(
            list(data.requests_from_logs(records))[0][1]["reason"], "missing_raw_tool_arguments"
        )

    def test_tool_pairing_requires_matching_ids_and_complete_observations(self):
        sample = list(data.requests_from_logs(turn()))[1][0]
        messages = sample["request"]["messages"]
        for bad in [messages[:-1], messages + [messages[-1]], [messages[-1]]]:
            with self.assertRaises(data.EvidenceError):
                data.validate_tools(bad)
        # 调用 ID 用来关联本组调用与结果，不能把已结算的历史同名 ID 误判为悬空结果。
        data.validate_tools(messages + deepcopy(messages[1:]))

    def test_tokenizer_cannot_silently_drop_reasoning_or_change_prompt(self):
        sample = list(data.requests_from_logs(turn()))[1][0]
        for tokenizer in [Tokenizer(drops_reasoning=True), Tokenizer(breaks_prefix=True)]:
            with self.assertRaises(data.EvidenceError):
                data.tokenize_request(sample, tokenizer)
        sample["request"]["messages"].append({"role": "user", "content": "injected"})
        with self.assertRaisesRegex(data.EvidenceError, "request_changed"):
            data.tokenize_request(sample, Tokenizer())

    def test_historical_thinking_cannot_be_silently_dropped(self):
        sample = list(data.requests_from_logs(turn()))[1][0]
        sample["request"]["messages"][1]["reasoning_content"] = "historical thought"
        sample["request_body"] = json.dumps(sample["request"])
        sample["source"]["request_sha256"] = data.digest(sample["request_body"])
        self.assertIsNotNone(data.tokenize_request(sample, Tokenizer()))
        with self.assertRaisesRegex(data.EvidenceError, "template_dropped_historical_thinking"):
            data.tokenize_request(sample, Tokenizer(drops_reasoning=True))

    def test_actual_concat_tokens_retain_thinking_independent_of_http(self):
        # R1=20 不出现在第二个 HTTP body，但确实在第二次生成的 input_tokens 中。
        parent = interaction("parent", [10], [20, 21])
        child = interaction("child", [10, 20, 21, 30], [40], parent)
        sibling = interaction("sibling", [10, 20, 21, 31], [41], parent)
        rows = list(data.samples_from_areal({"child": child, "sibling": sibling}))
        samples = {s["id"]: s for s, _ in rows}
        self.assertEqual(len(samples), 3)
        self.assertEqual(samples["child"]["input_ids"], [10, 20, 21, 30, 40])
        self.assertEqual(samples["child"]["loss_mask"], [0, 0, 0, 0, 1])
        self.assertEqual(samples["parent"]["loss_mask"], [0, 1, 1])
        self.assertEqual(samples["child"]["alignment"], "engine_tokens")
        self.assertTrue(all(a["status"] == "READY" for _, a in rows))

    def test_max_length_never_truncates_and_empty_target_never_trains(self):
        sample = {"input_ids": [10, 20, 30], "loss_mask": [0, 0, 1]}
        with self.assertRaisesRegex(data.EvidenceError, "overlength"):
            data.validate_sft(sample, 2)
        self.assertEqual(sample["input_ids"], [10, 20, 30])
        for mask in [[0, 0, 0], [0, 1], [1, 1, 1], [0, 0, 2]]:
            with self.assertRaises(data.EvidenceError):
                data.validate_sft({**sample, "loss_mask": mask})

    def test_tool_templates_must_keep_current_call_and_captured_kwargs(self):
        sample = list(data.requests_from_logs(turn()))[0][0]
        result = data.tokenize_request(sample, Tokenizer())
        self.assertTrue(any(result["loss_mask"]))
        with self.assertRaisesRegex(data.EvidenceError, "current_tool_call"):
            data.tokenize_request(sample, Tokenizer(drops_tools=True))
        raw = json.loads(sample["request_body"])
        raw["chat_template_kwargs"] = {"enable_thinking": True}
        sample["request"] = raw
        sample["request_body"] = json.dumps(raw)
        sample["source"]["request_sha256"] = data.digest(sample["request_body"])
        with self.assertRaisesRegex(data.EvidenceError, "kwargs_disagree"):
            data.tokenize_request(sample, Tokenizer(), {"enable_thinking": False})

    def test_output_or_tokens_mutated_after_export_are_rejected(self):
        sample = list(data.requests_from_logs(turn()))[1][0]
        tokens = data.tokenize_request(sample, Tokenizer())
        tokens["input_ids"][-1] += 1
        with self.assertRaisesRegex(data.EvidenceError, "changed_after_export"):
            data.validate_sft(tokens)
        sample["response"]["reasoning_content"] += "injected"
        with self.assertRaisesRegex(data.EvidenceError, "response_changed"):
            data.tokenize_request(sample, Tokenizer())

    def test_parent_link_never_overrides_actual_child_tokens(self):
        parent = interaction("parent", [10], [20, 21])
        child = interaction("child", [11, 30, 31, 32], [40], parent)
        rows = {s["id"]: s for s, a in data.samples_from_areal({"child": child}) if s}
        self.assertEqual(rows["child"]["input_ids"], [11, 30, 31, 32, 40])
        self.assertEqual(rows["child"]["loss_mask"], [0, 0, 0, 0, 1])
        self.assertEqual(rows["parent"]["loss_mask"], [0, 1, 1])

    def test_unknown_acceptance_and_duplicate_request_identity_are_audited(self):
        records = turn()
        del records[1]["attributes"]["areal.model.response.accepted"]
        rows = list(data.requests_from_logs(records))
        self.assertEqual(rows[0][1]["reason"], "missing_acceptance_evidence")
        self.assertIsNotNone(rows[1][0])
        records = turn()
        records[2]["attributes"]["areal.model.request.id"] = "request-1"
        rows = list(data.requests_from_logs(records))
        self.assertTrue(
            all(s is None and a["reason"] == "missing_or_duplicate_request_id" for s, a in rows)
        )

    def test_otlp_anyvalues_keep_original_request_bytes(self):
        r = turn()[1]

        def av(value):
            return (
                {"boolValue": value}
                if isinstance(value, bool)
                else {"intValue": str(value)}
                if isinstance(value, int)
                else {"stringValue": value}
            )

        def attrs(values):
            return [{"key": k, "value": av(v)} for k, v in values.items()]

        document = {
            "resourceLogs": [
                {
                    "resource": {"attributes": attrs(r["resource"])},
                    "scopeLogs": [
                        {
                            "logRecords": [
                                {"eventName": r["eventName"], "attributes": attrs(r["attributes"])}
                            ]
                        }
                    ],
                }
            ]
        }
        self.assertEqual(list(data.log_records(document)), [r])

    def test_cli_exports_auditable_rows_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            source, output = path / "logs.json", path / "export"
            source.write_text(json.dumps(turn()), encoding="utf-8")
            command = [
                sys.executable,
                str(SCRIPTS / "export-training-data.py"),
                "otlp",
                "--input",
                str(source),
                "--output-dir",
                str(output),
            ]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["counts"], {"CANDIDATE": 2})
            self.assertEqual(len((output / "samples.jsonl").read_text().splitlines()), 2)
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
