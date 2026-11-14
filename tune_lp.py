"""Tune the LP reference's few robustness knobs on training seeds (100..), never the evaluation seeds.

usage: python tune_lp.py [n_seeds] [workers]
One knob is varied at a time around the current defaults (a full grid would take hours); the same seeds are
used for every setting, so the differences are paired."""
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import policies

SEEDS = range(100, 100 + (int(sys.argv[1]) if len(sys.argv) > 1 else 12))
WORKERS = int(sys.argv[2]) if len(sys.argv) > 2 else 5
SWEEP = {"margin": [0.03, 0.1], "shared": [1, 3], "spot_q": [0.5, 0.9], "shortfall": [20.0, 80.0]}


def score(kw):
    r = [policies.play(lambda: policies.LPPolicy(**kw), s) for s in SEEDS]
    return statistics.mean(x["net_cost"] for x in r), sum(3 - x["milestones_met"] for x in r), kw


if __name__ == "__main__":
    combos = [{}] + [{k: v} for k, vs in SWEEP.items() for v in vs]
    with ProcessPoolExecutor(WORKERS) as ex:
        res = sorted(ex.map(score, combos), key=lambda r: r[0])
    for m, miss, kw in res:
        print(round(m), "missed runs:", miss, kw or f"defaults {policies.LPPolicy.P}")
