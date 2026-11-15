"""Preference training on DAgger pairs: in a state the student reached, the reference's reply is preferred to the
student's own. A new LoRA is trained on top of the merged student; the reference model for the DPO loss is that
merged student (the adapter disabled).

usage: python train/dpo.py --samples train/data/samples4.jsonl --relabel train/data/relabel4.jsonl \
         --model train/ckpt/dagger3-merged --out train/ckpt/dpo --merge-out train/ckpt/dpo-merged [--max-pairs 2000]
"""
import argparse
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_env as E  # noqa: E402


def pairs(samples, relabel, max_pairs, seed=0):
    student = {}
    with open(samples, encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            student[r["seed"], r["sample"], r["month"]] = r
    out = []
    with open(relabel, encoding="utf-8") as f:
        for line in f:
            x = json.loads(line)
            s = student.get((x["seed"], x["sample"], x["month"]))
            if s is None or s["user"] != x["user"] or s["executed"] == x["executed"]:
                continue   # no pair, or the student already did what the expert would
            out.append({"prompt": [{"role": "system", "content": E.SYSTEM}, {"role": "user", "content": x["user"]}],
                        "chosen": [{"role": "assistant", "content": x["completion"]}],
                        "rejected": [{"role": "assistant", "content": s["completion"]}]})
    random.Random(seed).shuffle(out)
    return out[:max_pairs]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", required=True)
    ap.add_argument("--relabel", required=True)
    ap.add_argument("--model", required=True, help="merged student (HF directory)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--merge-out")
    ap.add_argument("--max-pairs", type=int, default=2000)
    ap.add_argument("--beta", type=float, default=0.1)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--accum", type=int, default=16)
    a = ap.parse_args()

    import os
    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import DPOConfig, DPOTrainer

    data = pairs(a.samples, a.relabel, a.max_pairs)
    print(f"{len(data)} preference pairs")
    tok = AutoTokenizer.from_pretrained(a.model)
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.bfloat16)
    world = int(os.environ.get("WORLD_SIZE", 1))
    cfg = DPOConfig(output_dir=a.out, beta=a.beta, learning_rate=a.lr, per_device_train_batch_size=1,
                    gradient_accumulation_steps=max(1, a.accum // world), num_train_epochs=1, lr_scheduler_type="cosine",
                    warmup_steps=5, bf16=True, gradient_checkpointing=True, max_length=8192, logging_steps=5,
                    save_strategy="no", report_to="none")
    trainer = DPOTrainer(model=model, args=cfg, train_dataset=Dataset.from_list(data), processing_class=tok,
                         peft_config=LoraConfig(r=32, lora_alpha=64, lora_dropout=0.05, target_modules="all-linear",
                                                task_type="CAUSAL_LM"))
    trainer.train()
    trainer.save_model(a.out)
    if not trainer.accelerator.is_main_process:
        return
    tok.save_pretrained(a.out)
    if a.merge_out:
        trainer.model.merge_and_unload().save_pretrained(a.merge_out)
        tok.save_pretrained(a.merge_out)
        print("merged model ->", a.merge_out)


if __name__ == "__main__":
    main()
