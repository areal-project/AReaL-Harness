#!/usr/bin/env python3
"""将已选择的 token 样本交给已有 AReaL SFTTrainer；模型与资源沿用训练配置。"""

import argparse
from pathlib import Path
import sys

from training_data import load_sft_dataset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=Path, required=True)
    parser.add_argument("--validation-samples", type=Path)
    parser.add_argument("--areal-root", type=Path)
    parser.add_argument("--max-length", type=int)
    parser.add_argument(
        "--check-only", action="store_true", help="CPU 验证真实 dataset/collator，无需启动训练集群"
    )
    args, training_args = parser.parse_known_args()
    if args.areal_root:
        sys.path.insert(0, str(args.areal_root.resolve()))
    dataset = load_sft_dataset(args.samples, args.max_length)
    valid = (
        load_sft_dataset(args.validation_samples, args.max_length)
        if args.validation_samples
        else None
    )
    if args.check_only:
        from areal.utils.data import collate_samples_to_list

        batch = collate_samples_to_list([dataset[0]])
        assert batch[0]["input_ids"].shape == batch[0]["loss_mask"].shape
        assert batch[0]["attention_mask"].all()
        print(f"AReaL SFT dataset/collator OK: {len(dataset)} train samples")
        return
    from areal import SFTTrainer
    from areal.api.cli_args import SFTConfig, load_expr_config

    config, _ = load_expr_config(training_args, SFTConfig)
    with SFTTrainer(config, train_dataset=dataset, valid_dataset=valid) as trainer:
        trainer.train()


if __name__ == "__main__":
    main()
