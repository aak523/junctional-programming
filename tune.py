"""Grid-search the reference's few parameters on training seeds (100..), never the evaluation seeds."""
import itertools
import statistics
import sys
import time

import policies

seeds = range(100, 100 + int(sys.argv[1]) if len(sys.argv) > 1 else 130)
grid = {"spot_buf": [0.0, 0.05, 0.1], "m_inf": [0.05, 0.08, 0.12], "m_tr": [0.03, 0.05], "queue_months": [2, 3], "pess": [0.0, 0.25]}
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
