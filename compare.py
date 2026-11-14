"""Where does an agent's money go? Replays every Harbor trial against the reference on the same world.

usage: python compare.py [jobs dir]      (default: harbor/jobs)
Reads each trial's verifier/details.json (the world's seed and the agent's actions) and prints the hidden state,
cost breakdown, compute delivered per training window, broker outcomes and minimum cash.
"""
import json
import sys
from pathlib import Path

import policies
import world as W

HERE = Path(__file__).parent


def replay(seed, actions):
    w = W.World(seed)
    for a in actions:
        try:
            w.command(a)
        except ValueError:
            pass
    w.finish()
    return w


def reference(seed):
    w = W.World(seed)
    pol = policies.LPPolicy()
    while w.t < W.T:
        pol(w.observe(), w.command)
        w.end_month()
    return w


def row(name, w):
    s = w.settlement
    c = s["costs"]
    win = [round(w.window_training(a, d)) for a, d, _ in W.MILESTONES]
    brk = {b: [e["delivered"] for h in w.history for e in h["broker"] if e["src"] == b] for b in W.BROKERS}
    print(f"  {name:9} net {s['net_cost']:6.0f} | capex {c['capex']:4.0f} contracts {c['contracts']:4.0f} power {c['power']:4.0f} "
          f"spot {c['spot']:3.0f} options {c['options']:3.0f} moves {c['moves']:3.0f} interest {c['interest']:3.0f} resale {c['resale']:5.0f} "
          f"mark {s['mark_to_market']:4.0f} oblig {s['obligations']:4.0f} | windows {win} (need {[int(t) for *_, t in W.MILESTONES]}) | "
          f"broker outcomes {brk} | min cash {min(h['cash_end'] for h in w.history):.0f}")


if __name__ == "__main__":
    jobs = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "harbor" / "jobs"
    for f in sorted(jobs.glob("*/*/verifier/details.json")):
        d = json.loads(f.read_text())
        if "seed" not in d:
            continue
        seed = d["seed"]
        ref = reference(seed)
        print(f"=== {f.parts[-4]} / {f.parts[-3]}: reward {d['reward']} vs reference {d['scale']['reference_reward']} | "
              f"regime {''.join(x[0] for x in ref.regime)} launch {ref.launch} export {ref.export} "
              f"brokers reliable {ref.broker_reliable} decay {ref.broker_decay} growth {ref.growth[0]} switch {ref.growth_switch}")
        row("reference", ref)
        row("agent", replay(seed, d["actions"]))
