"""Grid-search the reference's few parameters on training seeds (100..), never the evaluation seeds."""
import itertools
import statistics
import sys
import time

import policies

seeds = range(100, 100 + int(sys.argv[1]) if len(sys.argv) > 1 else 130)
grid = {"rent_mult": [0.8, 1.0, 1.2, 1.5, 2.0, 99], "queue_months": [2, 3], "spot_share": [0.3, 0.6]}
t0 = time.time()
res = []
for vals in itertools.product(*grid.values()):
    kw = dict(zip(grid, vals))
    costs = [policies.play(lambda: policies.Reference(**kw), s)["net_cost"] for s in seeds]
    res.append((statistics.mean(costs), kw))
res.sort(key=lambda r: r[0])
for m, kw in res[:8]:
    print(round(m), kw)
print("default", round(statistics.mean(policies.play(policies.Reference, s)["net_cost"] for s in seeds)), f"{time.time() - t0:.0f}s")
