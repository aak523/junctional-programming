"""How often does the reference miss a training run? The gap is only credible if the reference reliably meets all three.

usage: python missrate.py [first_seed] [n_seeds] [workers]      (default: 200 200 7, about half an hour)
Plays the reference and the oracle on each seed (fresh seeds, outside tuning 100.. and evaluation 0..9) and reports
missed runs and the reference's reward (world.score) against the oracle on the same world.
"""
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import policies
import world as W


def row(seed):
    ref, orc = policies.play(policies.LPPolicy, seed), policies.play(policies.OracleMPC, seed)
    return seed, ref["milestones_met"], orc["milestones_met"], W.score(ref["net_cost"], orc["net_cost"], ref["milestones_met"])


if __name__ == "__main__":
    args = [int(x) for x in sys.argv[1:4]]
    first, n, workers = args + [200, 200, 7][len(args):]
    with ProcessPoolExecutor(workers) as ex:
        rows = list(ex.map(row, range(first, first + n)))
    for seed, rm, om, r in rows:
        if rm < 3 or om < 3:
            print(f"seed {seed}: reference met {rm}/3, oracle met {om}/3, reference reward {r:.3f}")
    rewards = [r for *_, r in rows]
    print(f"seeds {first}..{first + n - 1}: reference missed {sum(3 - rm for _, rm, _, _ in rows)} runs on "
          f"{sum(rm < 3 for _, rm, _, _ in rows)} of {n} worlds (oracle: {sum(om < 3 for _, _, om, _ in rows)} worlds); "
          f"reference reward mean {statistics.mean(rewards):.3f}, min {min(rewards):.3f}, "
          f"below 0.8 on {sum(r < 0.8 for r in rewards)}")
