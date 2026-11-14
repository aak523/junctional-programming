"""Tune the LP reference's few robustness knobs on training seeds (100..), never the evaluation seeds."""
import itertools
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import policies

SEEDS = range(100, 100 + int(sys.argv[1]) if len(sys.argv) > 1 else 116)
GRID = {"margin": [0.03, 0.06, 0.1], "shared": [0, 2, 4], "probe": [0.5, 1.0]}


def score(kw):
    r = [policies.play(lambda: policies.LPPolicy(**kw), s) for s in SEEDS]
    return statistics.mean(x["net_cost"] for x in r), sum(3 - x["milestones_met"] for x in r), kw


if __name__ == "__main__":
    combos = [dict(zip(GRID, v)) for v in itertools.product(*GRID.values())]
    with ProcessPoolExecutor(6) as ex:
        res = sorted(ex.map(score, combos), key=lambda r: r[0])
    for m, miss, kw in res:
        print(round(m), "missed runs:", miss, kw)
