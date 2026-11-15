"""Merge a LoRA adapter into its base model (a plain HF directory that vLLM and the next round can load).

usage: python train/merge.py train/ckpt/dagger3 train/ckpt/dagger3-merged [--base Qwen/Qwen3-4B-Instruct-2507]
"""
import argparse

from sft import BASE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("adapter")
    ap.add_argument("out")
    ap.add_argument("--base", default=BASE)
    a = ap.parse_args()
    import torch
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer
    model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.bfloat16)
    PeftModel.from_pretrained(model, a.adapter).merge_and_unload().save_pretrained(a.out)
    AutoTokenizer.from_pretrained(a.adapter).save_pretrained(a.out)
    print("merged", a.adapter, "->", a.out)


if __name__ == "__main__":
    main()
