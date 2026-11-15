"""Join train/results/<name>.json into train/results/REPORT.md and train/results/rewards.png.

usage: python train/report.py [names...]   (default: do_nothing base sft dagger reference oracle, whichever exist)
"""
import json
import sys
from pathlib import Path

RES = Path(__file__).resolve().parent / "results"
NAMES = ["do_nothing", "base", "sft", "dagger", "dagger3", "sft_v2", "teacher", "reference", "oracle"]
LABEL = {"do_nothing": "do nothing (scripted)", "base": "Qwen3-4B-Instruct, untrained", "sft": "SFT on 4,800 teacher months",
         "dagger": "+ DAgger round 2 (relabels + own best episodes)", "dagger3": "+ DAgger aggregate (unseen teacher + relabels)",
         "sft_v2": "SFT on 4,800 months of the current reference", "teacher": "teacher: the reference before the options fix",
         "reference": "current Bayesian-LP reference", "oracle": "perfect-information oracle"}


def main():
    names = [n for n in (sys.argv[1:] or NAMES) if (RES / f"{n}.json").exists()]
    res = {n: json.loads((RES / f"{n}.json").read_text()) for n in names}
    sets = list(next(iter(res.values()))["sets"])
    oracles = sorted({r.get("oracle_commit", r["world_commit"]) for r in res.values()})
    L = ["# Fine-tuning results", "", "World v5 rules (commit 2303cc6; world.py, lp.py, TASK.md and service.py unchanged since). "
         f"Rewards use the oracle of commit {', '.join(oracles)} (after the options fix in 466fcc7). Greedy decoding, one "
         "episode per held-out seed; reward = oracle net cost / net cost, capped at 1 (the Harbor verifier's formula).", ""]
    for s in sets:
        L += [f"## Seeds {s}", "", "| policy | mean reward | mean net cost ($M) | all 3 runs met | command error rate | forced ends |",
              "|---|---|---|---|---|---|"]
        for n in names:
            x = res[n]["sets"][s]
            L.append(f"| {LABEL.get(n, n)} | {x['mean_reward']:.3f} | {x['mean_net_cost']:.0f} | {x['all_milestones']}/{x['n']} | "
                     f"{x['error_rate']:.1%} | {x['forced_ends']} |")
        L.append("")
    stats = RES / "round2_stats.json"
    if stats.exists():
        st = json.loads(stats.read_text())
        L += ["## DAgger round", "", "```", json.dumps(st, indent=1), "```", ""]
    (RES / "REPORT.md").write_text("\n".join(L), encoding="utf-8")
    print("\n".join(L))

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, len(sets), figsize=(6 * len(sets), 4.2), squeeze=False)
    for ax, s in zip(axes[0], sets):
        a, b = map(int, s.split("-"))
        for i, n in enumerate(names):
            per = res[n]["per_seed"]
            ys = [per[str(k)]["reward"] if str(k) in per else per[k]["reward"] for k in range(a, b + 1)]
            ax.scatter([i] * len(ys), ys, s=14, alpha=0.6)
            ax.hlines(sum(ys) / len(ys), i - 0.3, i + 0.3, color="black")
        ax.set_xticks(range(len(names)), names, rotation=20)
        ax.set_ylim(0, 1.05)
        ax.set_ylabel("reward")
        ax.set_title(f"held-out seeds {s}")
        ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(RES / "rewards.png", dpi=130)
    print("wrote", RES / "REPORT.md", RES / "rewards.png")


if __name__ == "__main__":
    main()
