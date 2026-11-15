"""Round-2 data: every DAgger-relabelled state, the student's own best episodes when they beat its greedy play,
and a replay fraction of the original reference data.

usage: python train/select_round2.py --samples train/data/dagger_samples.jsonl --greedy train/data/dagger_greedy.jsonl \
         --relabel train/data/dagger_relabel.jsonl --sft train/data/sft_ref.jsonl --replay 0.2 --out train/data/round2.jsonl
"""
import argparse
import json
import random
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm_env as E  # noqa: E402
from gen_sft import episodes, load  # noqa: E402


def clean(r):
    """The student's own month as a training target: its first note, the actions that ran, end_month."""
    notes = [s[4:].strip() for s in E.parse(r["completion"])[0] if s.split()[0] == "note"]
    return {**r, "policy": "kept_student", "completion": E.completion_of(notes[0] if notes else "", r["executed"])}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", required=True)
    ap.add_argument("--greedy", required=True)
    ap.add_argument("--relabel", required=True)
    ap.add_argument("--sft", required=True)
    ap.add_argument("--replay", type=float, default=0.2)
    ap.add_argument("--max-errors", type=int, default=5)
    ap.add_argument("--max-forced", type=int, default=2)
    ap.add_argument("--out", required=True)
    ap.add_argument("--stats")
    ap.add_argument("--keep-student", action=argparse.BooleanOptionalAction, default=True,
                    help="also train on the student's best episodes (round 2); off = relabels + replay only")
    a = ap.parse_args()
    rng = random.Random(0)
    greedy = {seed: recs[0]["episode"]["reward"] for (seed, _), recs in episodes(load(a.greedy)).items()}
    by_seed = {}
    for (seed, _), recs in episodes(load(a.samples)).items():
        by_seed.setdefault(seed, []).append(recs)
    kept = []
    for seed, group in by_seed.items():
        best = max(group, key=lambda recs: recs[0]["episode"]["reward"])
        e = best[0]["episode"]
        if a.keep_student and e["reward"] > greedy[seed] and e["errors"] <= a.max_errors and e["forced_ends"] <= a.max_forced:
            kept.append(best)
    relabel = load(a.relabel)
    sft = load(a.sft)
    replay = rng.sample(sft, int(a.replay * len(sft)))
    out = relabel + [clean(r) for recs in kept for r in recs] + replay
    rng.shuffle(out)
    with open(a.out, "w", encoding="utf-8") as f:
        for r in out:
            f.write(json.dumps(r) + "\n")
    all_r = [g[0]["episode"]["reward"] for group in by_seed.values() for g in group]
    stats = {"relabelled_states": len(relabel), "kept_episodes": len(kept), "kept_states": sum(map(len, kept)),
             "replay_states": len(replay), "total": len(out), "seeds": len(by_seed),
             "mean_reward_greedy": round(statistics.mean(greedy[s] for s in by_seed), 4),
             "mean_reward_samples": round(statistics.mean(all_r), 4),
             "mean_reward_best_of_k": round(statistics.mean(max(g[0]["episode"]["reward"] for g in group) for group in by_seed.values()), 4),
             "mean_reward_kept": round(statistics.mean(k[0]["episode"]["reward"] for k in kept), 4) if kept else None}
    print(json.dumps(stats, indent=1))
    if a.stats:
        Path(a.stats).write_text(json.dumps(stats, indent=1))


if __name__ == "__main__":
    main()
