"""Score the scripted policy ladder over seeds. usage: python ladder.py [first_seed] [n_seeds] [out.json]"""
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
    print(f"{'seed':>5} " + " ".join(f"{x:>13}" for x in names))
    for s, r in rows.items():
        print(f"{s:>5} " + " ".join(f"{r[x]['net_cost']:>8.0f} ({'-' if r[x]['milestones_met'] is None else r[x]['milestones_met']})" for x in names))
    print(f"{'mean':>5} " + " ".join(f"{statistics.mean(r[x]['net_cost'] for r in rows.values()):>13.0f}" for x in names))
    if len(sys.argv) > 3:
        json.dump(rows, open(sys.argv[3], "w"), indent=1)
