"""Textbook DAgger aggregate for continued training: the teacher examples the SFT run did not see, plus every expert
relabel (no self-imitation).

usage: python train/aggregate.py --sft train/data/sft_ref.jsonl --seen 4800 --relabel train/data/dagger_relabel.jsonl \
         --out train/data/round3.jsonl
"""
import argparse
import random


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sft", required=True)
    ap.add_argument("--seen", type=int, required=True, help="sft.py --limit of the run being continued")
    ap.add_argument("--relabel", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    rows = open(a.sft, encoding="utf-8").read().splitlines()
    random.Random(0).shuffle(rows)   # the permutation sft.py --limit used (it depends only on the row count)
    rest = rows[a.seen:]
    relabel = open(a.relabel, encoding="utf-8").read().splitlines()
    out = rest + relabel
    random.Random(1).shuffle(out)
    with open(a.out, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print(f"{len(rest)} unseen teacher + {len(relabel)} relabelled = {len(out)} -> {a.out}")


if __name__ == "__main__":
    main()
