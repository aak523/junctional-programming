"""Score the scripted policy ladder over seeds. usage: python ladder.py [first_seed] [n_seeds] [out.json]

Prints each policy's net cost (runs met) and reward (world.score: oracle / net cost, times the share of runs met)."""
import json
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import policies

if __name__ == "__main__":
    first, n = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (0, 10)
    seeds = list(range(first, first + n))
    with ProcessPoolExecutor(6) as ex:
        rows = dict(zip(seeds, ex.map(policies.ladder, seeds)))
    names = list(policies.LADDER) + ["lp_bound"]
    print(f"{'seed':>5} " + " ".join(f"{x:>19}" for x in names))
    for s, r in rows.items():
        print(f"{s:>5} " + " ".join(f"{r[x]['net_cost']:>8.0f} ({'-' if r[x]['milestones_met'] is None else r[x]['milestones_met']})"
                                    + (f" {r[x]['reward']:.3f}" if "reward" in r[x] else " " * 6) for x in names))
    print(f"{'mean':>5} " + " ".join(f"{statistics.mean(r[x]['net_cost'] for r in rows.values()):>12.0f}"
                                     + (f" {statistics.mean(r[x]['reward'] for r in rows.values()):.3f}" if x in policies.LADDER else " " * 6)
                                     for x in names))
    if len(sys.argv) > 3:
        json.dump(rows, open(sys.argv[3], "w"), indent=1)
