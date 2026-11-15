"""LoRA supervised fine-tuning on monthly (system, user) -> assistant records; loss on the completion only.

usage: python train/sft.py --data train/data/sft_ref.jsonl --out train/ckpt/sft --merge-out train/ckpt/sft-merged
       python train/sft.py --data train/data/round2.jsonl --init-adapter train/ckpt/sft --lr 5e-5 --out train/ckpt/dagger \
         --merge-out train/ckpt/dagger-merged
       python train/sft.py --data train/data/smoke.jsonl --max-steps 20 --out train/ckpt/smoke    (loss-mask check)
Several GPUs: torchrun --nproc_per_node N train/sft.py ... --accum 16/N (data parallel; same effective batch).
"""
import argparse
import json
import math
import os
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_env as E  # noqa: E402

BASE = "Qwen/Qwen3-4B-Instruct-2507"


def dataset(paths, limit=None, shuffle_seed=0):
    from datasets import Dataset
    rows = []
    for p in paths:
        with open(p, encoding="utf-8") as f:
            for line in f:
                r = json.loads(line)
                assert r["system_sha"] == E.SYSTEM_SHA, (p, "record built with a different system prompt")
                rows.append({"prompt": [{"role": "system", "content": E.SYSTEM}, {"role": "user", "content": r["user"]}],
                             "completion": [{"role": "assistant", "content": r["completion"]}]})
    if limit:   # a random subset across all episodes, not the first episodes in the file
        random.Random(shuffle_seed).shuffle(rows)
    return Dataset.from_list(rows[:limit] if limit else rows)


def check_mask(trainer, tok, ds):
    """The first example's trained tokens must be exactly its assistant reply (plus the end-of-turn token)."""
    batch = next(iter(trainer.get_train_dataloader()))
    ids, labels = batch["input_ids"][0], batch["labels"][0]
    trained = tok.decode(ids[labels != -100])
    targets = [r[0]["content"] for r in ds["completion"]]
    ok = any(t.strip() in trained and len(trained) < len(t) + 40 for t in targets)
    print(f"loss-mask check: {int((labels != -100).sum())} of {len(ids)} tokens trained: {trained[:160]!r} ... {trained[-60:]!r}")
    assert ok and "How to reply" not in trained, "loss mask does not isolate the assistant reply"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", nargs="+", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--base", default=BASE)
    ap.add_argument("--init-adapter")
    ap.add_argument("--merge-out")
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--accum", type=int, default=16)
    ap.add_argument("--max-steps", type=int, default=-1)
    ap.add_argument("--max-length", type=int, default=8192)
    ap.add_argument("--limit", type=int)
    ap.add_argument("--shuffle-seed", type=int, default=0, help="which random subset --limit takes")
    ap.add_argument("--gc", action=argparse.BooleanOptionalAction, default=False, help="activation checkpointing")
    ap.add_argument("--liger", action="store_true", help="Liger fused kernels (no full-vocab logits)")
    a = ap.parse_args()

    import torch
    from peft import LoraConfig, PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    ds = dataset(a.data, a.limit, a.shuffle_seed)
    print(f"system prompt: {E.PROMPT} ({len(E.SYSTEM)} chars), {len(ds)} examples")
    tok = AutoTokenizer.from_pretrained(a.base)
    cuda = torch.cuda.is_available()
    try:
        import flash_attn  # noqa: F401
        attn = "flash_attention_2"
    except ImportError:
        attn = "sdpa"
    model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.bfloat16 if cuda else torch.float32, attn_implementation=attn)
    peft_config = None
    if a.init_adapter:
        model = PeftModel.from_pretrained(model, a.init_adapter, is_trainable=True)
    else:
        peft_config = LoraConfig(r=32, lora_alpha=64, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM")
    world = int(os.environ.get("WORLD_SIZE", 1))
    steps = a.max_steps if a.max_steps > 0 else math.ceil(len(ds) * a.epochs / (a.batch * a.accum * world))
    cfg = SFTConfig(output_dir=a.out, max_length=a.max_length, completion_only_loss=True, per_device_train_batch_size=a.batch,
                    gradient_accumulation_steps=a.accum, learning_rate=a.lr, lr_scheduler_type="cosine",
                    warmup_steps=max(1, int(0.03 * steps)), num_train_epochs=a.epochs, max_steps=a.max_steps, bf16=cuda,
                    gradient_checkpointing=a.gc, use_liger_kernel=a.liger, logging_steps=5, save_strategy="steps", save_steps=100, save_total_limit=2,
                    report_to="none", dataset_num_proc=8 if cuda else None)
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, processing_class=tok, peft_config=peft_config)
    trainer.model.print_trainable_parameters()
    check_mask(trainer, tok, ds)
    trainer.train()
    trainer.save_model(a.out)
    if not trainer.accelerator.is_main_process:
        return
    tok.save_pretrained(a.out)
    if a.merge_out:
        merged = trainer.model.merge_and_unload()
        merged.save_pretrained(a.merge_out)
        tok.save_pretrained(a.merge_out)
        print("merged model ->", a.merge_out)


if __name__ == "__main__":
    main()
