"""Score the scripted policy ladder over seeds. usage: python ladder.py [first_seed] [n_seeds]"""
import json
import statistics
import sys

import policies

first, n = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (0, 20)
rows = {s: policies.ladder(s) for s in range(first, first + n)}
names = list(policies.LADDER)
print(f"{'seed':>5} " + " ".join(f"{x:>18}" for x in names))
for s, r in rows.items():
    print(f"{s:>5} " + " ".join(f"{r[x]['net_cost']:>12.0f} ({r[x]['milestones_met']}/3)" for x in names))
print(f"{'mean':>5} " + " ".join(f"{statistics.mean(r[x]['net_cost'] for r in rows.values()):>18.0f}" for x in names))
if len(sys.argv) > 3:
    json.dump(rows, open(sys.argv[3], "w"), indent=1)
