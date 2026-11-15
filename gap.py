"""How much does early commitment cost against the reference? The offline proxy for a frontier agent's gap.

usage: python gap.py [first_seed] [n_seeds] [workers]
Plays the reference and `Committer` (the reference made to buy a fixed early fleet) on the same worlds and prints
each one's net cost, the committer's cost as a share of the reference's (the frontier agent scored 82-112% in the
v5 paired games, where this proxy scored 85-99%), the oracle's, and missed runs. Develop on the tuning seeds (100..)
and confirm on the evaluation seeds (0..)."""
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import policies


def row(seed):
    r = {name: policies.play(pol, seed) for name, pol in
         (("reference", policies.LPPolicy), ("committer", policies.Committer), ("oracle", policies.OracleMPC))}
    return seed, {k: (v["net_cost"], 3 - v["milestones_met"]) for k, v in r.items()}


if __name__ == "__main__":
    first, n = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (100, 40)
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    with ProcessPoolExecutor(workers) as ex:
        rows = list(ex.map(row, range(first, first + n)))
    share = []
    for seed, r in rows:
        x = r["reference"][0] / r["committer"][0]
        share.append(x)
        print(f"{seed:>5} ref {r['reference'][0]:7.0f} ({r['reference'][1]} missed) committer {r['committer'][0]:7.0f} "
              f"({r['committer'][1]} missed) oracle {r['oracle'][0]:7.0f} | committer at {x:.0%} of the reference, "
              f"reference at {r['oracle'][0] / r['reference'][0]:.0%} of the oracle", flush=True)
    se = statistics.stdev(share) / len(share) ** 0.5
    print(f"committer at {statistics.mean(share):.1%} of the reference (se {se:.1%}), above it on {sum(x > 1 for x in share)}/{len(share)}; "
          f"reference at {statistics.mean(r['oracle'][0] / r['reference'][0] for _, r in rows):.1%} of the oracle; "
          f"missed runs: reference {sum(r['reference'][1] for _, r in rows)}, committer {sum(r['committer'][1] for _, r in rows)}, "
          f"oracle {sum(r['oracle'][1] for _, r in rows)}")
