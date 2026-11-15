"""How much does early commitment cost against the reference? The offline proxy for a frontier agent's gap.

usage: python gap.py [first_seed] [n_seeds] [workers]
Plays the reference and the challengers (the reference made to buy a fixed early fleet) on the same worlds and prints
each one's net cost, the committer's cost as a share of the reference's (on the five v5 paired worlds, Gemini 4
Hydrogen's games re-scored against the current reference are at 78-97% and this proxy at 85-99%), the oracle's,
and missed runs. Develop on the tuning seeds (100..)
and confirm on the evaluation seeds (0..)."""
import statistics
import sys
from concurrent.futures import ProcessPoolExecutor

import policies


# stand-ins for a frontier agent's early commitment: Hydrogen's fleet at 3k a month, the same fleet in 4.5k lumps
# (Hydrogen's first orders were 4-6k), and Fable's ~20k gen H splash on credit
CHALLENGERS = {"committer": policies.Committer, "lumpy": lambda: policies.Committer(buy_by=1), "splasher": policies.Splasher}


def row(seed):
    r = {name: policies.play(pol, seed) for name, pol in
         (("reference", policies.LPPolicy), *CHALLENGERS.items(), ("oracle", policies.OracleMPC))}
    return seed, {k: (v["net_cost"], 3 - v["milestones_met"]) for k, v in r.items()}


if __name__ == "__main__":
    first, n = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (100, 40)
    workers = int(sys.argv[3]) if len(sys.argv) > 3 else 6
    with ProcessPoolExecutor(workers) as ex:
        rows = []
        for seed, r in ex.map(row, range(first, first + n)):   # printed as each world finishes, so a stop keeps them
            rows.append((seed, r))
            print(f"{seed:>5} " + " ".join(f"{k} {c:6.0f} ({m} missed)" for k, (c, m) in r.items()) + " | " +
                  ", ".join(f"{k} at {r['reference'][0] / r[k][0]:.0%}" for k in CHALLENGERS) + " of the reference", flush=True)
    print(f"reference at {statistics.mean(r['oracle'][0] / r['reference'][0] for _, r in rows):.1%} of the oracle; missed runs: "
          + ", ".join(f"{k} {sum(r[k][1] for _, r in rows)}" for k in rows[0][1]))
    for k in CHALLENGERS:
        share = [r["reference"][0] / r[k][0] for _, r in rows]
        se = statistics.stdev(share) / len(share) ** 0.5
        print(f"{k} at {statistics.mean(share):.1%} of the reference (se {se:.1%}), above it on {sum(x > 1 for x in share)}/{len(share)}")
