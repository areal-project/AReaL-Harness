#!/usr/bin/env python3
"""使用真实 AReaL concat/cache/序列化/collator，在 CPU 验证制样与梯度。"""

import argparse
import asyncio
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from training_data import load_sft_dataset, samples_from_areal, tokenize_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--areal-root", type=Path, required=True)
    args = parser.parse_args()
    sys.path.insert(0, str(args.areal_root.resolve()))

    import torch
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import PreTrainedTokenizerFast

    from areal.api import ModelResponse
    from areal.experimental.openai import ArealOpenAI
    from areal.experimental.openai.cache import InteractionCache
    from areal.experimental.openai.client import concat_prompt_token_ids_with_parent
    from areal.experimental.openai.proxy.server import (
        deserialize_interactions,
        serialize_interactions,
    )
    from areal.experimental.openai.types import InteractionWithTokenLogpReward
    from areal.utils.data import collate_samples_to_list
    from areal.utils.hf_utils import apply_chat_template

    torch.manual_seed(7)
    vocab = {
        word: i
        for i, word in enumerate(
            [
                "<eos>",
                "[UNK]",
                "system",
                "user",
                "assistant",
                "rule",
                "Q",
                "R1",
                "A1",
                "observation",
                "R2",
                "A2",
                "branch",
                "<think>",
                "</think>",
            ]
        )
    }
    backend = Tokenizer(models.WordLevel(vocab, unk_token="[UNK]"))
    backend.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_object=backend,
        eos_token="<eos>",
        unk_token="[UNK]",
        pad_token="<eos>",
        additional_special_tokens=["<think>", "</think>"],
    )
    tokenizer.chat_template = "{% for m in messages %}{{ m.role }} {{ m.get('reasoning_content', '') }} {{ m.content or '' }}{% if m.get('tool_calls') %}{{ m.tool_calls | tojson }}{% endif %} {{ eos_token }}{% endfor %}{% if add_generation_prompt %}assistant {% endif %}"

    messages = [{"role": "system", "content": "rule"}, {"role": "user", "content": "Q"}]
    parent_input = apply_chat_template(tokenizer, messages, add_generation_prompt=True)
    parent_output = tokenizer.encode("R1 A1 <eos>", add_special_tokens=False)

    def response(input_ids, output_ids):
        return ModelResponse(
            input_tokens=input_ids,
            output_tokens=output_ids,
            output_logprobs=[-0.1] * len(output_ids),
            output_versions=[0] * len(output_ids),
            tokenizer=tokenizer,
        )

    async def mode_samples():
        samples = []
        for protocol in ("chat", "responses"):
            for policy in ("preserve", "omit"):
                for template in ("hf", "concat"):

                    class Engine:
                        def __init__(self):
                            self.requests = []

                        async def agenerate(self, request):
                            self.requests.append(request)
                            turn = len(self.requests)
                            return response(
                                request.input_ids,
                                tokenizer.encode(
                                    f"<think>R{turn}</think>A{turn} <eos>", add_special_tokens=False
                                ),
                            )

                    engine = Engine()
                    client = ArealOpenAI(
                        engine=engine,
                        tokenizer=tokenizer,
                        reasoning_parser="qwen3",
                        chat_template_type=template,
                        base_url="http://testserver/v1",
                        api_key="fixture",
                    )
                    history = list(messages)
                    for _ in range(2):
                        if protocol == "chat":
                            result = await client.chat.completions.create(
                                messages=history, max_completion_tokens=100
                            )
                            item = result.choices[0].message.model_dump(exclude_none=True)
                            if policy == "omit":
                                item["content"] = f"A{len(engine.requests)} "
                            history.append(item)
                        else:
                            result = await client.responses.create(
                                input=history, max_output_tokens=100, tools=[]
                            )
                            items = [item.model_dump(exclude_none=True) for item in result.output]
                            if policy == "omit":
                                items[0]["content"][0]["text"] = f"A{len(engine.requests)} "
                            history.extend(items)
                        history.append({"role": "user", "content": "observation"})
                    assert (vocab["R1"] in engine.requests[1].input_ids) == (policy == "preserve")
                    restored = deserialize_interactions(
                        serialize_interactions(
                            client._cache.export_interactions(
                                "concat" if template == "concat" else "individual"
                            )
                        )
                    )
                    prepared = [
                        sample
                        for sample, audit in samples_from_areal(restored)
                        if sample is not None
                    ]
                    assert len(prepared) == len(restored)
                    assert sum(sum(sample["loss_mask"]) for sample in prepared) == sum(
                        len(entry.model_response.output_tokens) for entry in client._cache.values()
                    )
                    assert all(
                        sample["source"]["history_thinking"] == "unknown" for sample in prepared
                    )
                    assert all(vocab["R2"] in sample["input_ids"] for sample in prepared[-1:])
                    samples.extend(prepared)
                    await client.close()
        return samples

    modes = asyncio.run(mode_samples())

    parent = InteractionWithTokenLogpReward(
        model_response=response(parent_input, parent_output),
        messages=messages,
        output_message_list=[{"role": "assistant", "content": "A1"}],
        chat_template_type="concat",
    )
    parent.interaction_id = "parent"
    cache = InteractionCache()
    cache["parent"] = parent
    observation = [{"role": "user", "content": "observation"}]
    http_messages = messages + parent.output_message_list + observation
    assert "R1" not in json.dumps(http_messages)
    hf_tokens = apply_chat_template(tokenizer, http_messages, add_generation_prompt=True)
    concat_tokens = concat_prompt_token_ids_with_parent(observation, parent, tokenizer)
    assert vocab["R1"] not in hf_tokens
    assert vocab["R1"] in concat_tokens
    child_output = tokenizer.encode("R2 A2 <eos>", add_special_tokens=False)
    child = InteractionWithTokenLogpReward(
        model_response=response(concat_tokens, child_output),
        messages=http_messages,
        output_message_list=[{"role": "assistant", "content": "A2"}],
        chat_template_type="concat",
    )
    child.interaction_id = "child"
    cache["child"] = child
    assert child.parent is parent
    assert list(cache.export_interactions("concat")) == ["child"]

    local = [s for s, a in samples_from_areal(cache.export_interactions("concat")) if s is not None]
    assert len(local) == 2
    by_id = {s["id"]: s for s in local}
    assert by_id["child"]["input_ids"] == concat_tokens + child_output
    assert by_id["child"]["loss_mask"] == [0] * len(concat_tokens) + [1] * len(child_output)
    hf = InteractionWithTokenLogpReward(
        model_response=response(hf_tokens, child_output), chat_template_type="hf"
    )
    hf.interaction_id = "hf"
    hf_sample = next(samples_from_areal({"hf": hf}))[0]
    assert vocab["R1"] not in hf_sample["input_ids"]

    # RPC concat 保留原始 rollout token/mask，不能根据文本重建，也不重复加入父样本。
    serialized = serialize_interactions(cache.export_interactions("concat"))
    restored = deserialize_interactions(serialized)
    remote = [s for s, a in samples_from_areal(restored) if s is not None]
    assert len(remote) == 1
    native = child.to_tensor_dict()
    assert remote[0]["input_ids"] == native["input_ids"][0].tolist()
    assert remote[0]["loss_mask"] == native["loss_mask"][0].tolist()
    assert sum(remote[0]["loss_mask"]) == len(parent_output) + len(child_output)

    with tempfile.TemporaryDirectory(prefix="areal-training-smoke-") as directory:
        root = Path(directory)
        source, output = root / "native.json", root / "export"
        source.write_text(
            json.dumps({"interactions": {**serialized, "invalid": None}}), encoding="utf-8"
        )
        cli = Path(__file__).with_name("export-training-data.py")
        subprocess.run(
            [
                sys.executable,
                str(cli),
                "areal",
                "--areal-root",
                str(args.areal_root),
                "--input",
                str(source),
                "--output-dir",
                str(output),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        dataset = load_sft_dataset(output / "samples.jsonl")
        assert json.loads((output / "report.json").read_text())["counts"] == {
            "READY": 1,
            "UNKNOWN": 1,
        }
        batch = collate_samples_to_list([dataset[0]])[0]
        assert batch["input_ids"].tolist() == native["input_ids"].tolist()
        assert batch["loss_mask"].tolist() == native["loss_mask"].tolist()
        train = Path(__file__).with_name("train-trajectory-sft.py")
        subprocess.run(
            [
                sys.executable,
                str(train),
                "--areal-root",
                str(args.areal_root),
                "--samples",
                str(output / "samples.jsonl"),
                "--check-only",
            ],
            check=True,
            capture_output=True,
            text=True,
        )

        # 使用真实 HF tokenizer 跑 HTTP 制样和 CLI，覆盖 transformers 的返回类型。
        raw = json.dumps({"messages": messages})
        from training_data import digest

        http_sample = {
            "schema": "areal.sft.request/v1",
            "id": "http",
            "quality": "unreviewed",
            "source": {"request_sha256": digest(raw)},
            "request_body": raw,
            "request": json.loads(raw),
            "response": {"role": "assistant", "reasoning_content": "R1", "content": "A1"},
        }
        http_sample["response"]["tool_calls"] = [
            {
                "id": "tool-current",
                "type": "function",
                "function": {"name": "read", "arguments": '{ "path": "fixture" }'},
            }
        ]
        http_sample["source"]["response_sha256"] = digest(
            json.dumps(http_sample["response"], sort_keys=True, ensure_ascii=False)
        )
        http_tokens = tokenize_request(http_sample, tokenizer)
        assert vocab["R1"] in http_tokens["input_ids"]
        tokenizer.save_pretrained(root / "tokenizer")
        request_file = root / "requests.jsonl"
        request_file.write_text(json.dumps(http_sample) + "\n", encoding="utf-8")
        subprocess.run(
            [
                sys.executable,
                str(cli),
                "tokenize",
                "--input",
                str(request_file),
                "--output-dir",
                str(root / "tokenized"),
                "--tokenizer",
                str(root / "tokenizer"),
                "--backend-context",
                "request-template",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        assert len(load_sft_dataset(root / "tokenized" / "samples.jsonl")) == 1
        cached_file = root / "selected.jsonl"
        row = json.dumps(remote[0]) + "\n"
        cached_file.write_text(row, encoding="utf-8")
        assert len(load_sft_dataset(cached_file)) == 1
        cached_file.write_text(row + row, encoding="utf-8")
        assert len(load_sft_dataset(cached_file)) == 2

        model = torch.nn.Sequential(
            torch.nn.Embedding(len(vocab), 8), torch.nn.Linear(8, len(vocab))
        )
        before = model[1].weight.detach().clone()
        optimizer = torch.optim.SGD(model.parameters(), lr=0.1)
        logits = model(batch["input_ids"][:, :-1])
        labels = batch["input_ids"][:, 1:]
        mask = batch["loss_mask"][:, 1:].bool()
        loss = torch.nn.functional.cross_entropy(logits[mask], labels[mask])
        assert torch.isfinite(loss)
        loss.backward()
        optimizer.step()
        assert not torch.equal(before, model[1].weight)
        selected_modes = root / "modes.jsonl"
        selected_modes.write_text(
            "".join(json.dumps(row) + "\n" for row in modes), encoding="utf-8"
        )
        modes_dataset = load_sft_dataset(selected_modes)
        for row in modes_dataset:
            mode_batch = collate_samples_to_list([row])[0]
            optimizer.zero_grad()
            logits = model(mode_batch["input_ids"][:, :-1])
            labels = mode_batch["input_ids"][:, 1:]
            mask = mode_batch["loss_mask"][:, 1:].bool()
            loss = torch.nn.functional.cross_entropy(logits[mask], labels[mask])
            assert torch.isfinite(loss)
            loss.backward()
            optimizer.step()
    print(
        "training smoke passed: Chat/Responses preserve/omit hf/concat, native cache/RPC exports, request masks, SFT dataset/collator, CPU backward"
    )


if __name__ == "__main__":
    main()
