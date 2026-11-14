"""Where does an agent's money go? Replays every agent run against the reference on the same world.

usage: python compare.py            (all runs/*/result.json)
Prints hidden state, cost breakdown, compute delivered per training window, broker orders and minimum cash.
"""
import json
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
          f"spot {c['spot']:3.0f} interest {c['interest']:3.0f} resale {c['resale']:5.0f} mark {s['mark_to_market']:4.0f} "
          f"oblig {s['obligations']:4.0f} | windows {win} (need {[int(t) for *_, t in W.MILESTONES]}) | "
          f"broker outcomes {brk} | min cash {min(h['cash_end'] for h in w.history):.0f}")


if __name__ == "__main__":
    runs = [json.loads(f.read_text()) for f in sorted(HERE.glob("runs/*/result.json"))]
    for seed in sorted({r["seed"] for r in runs}):
        ref = reference(seed)
        print(f"=== seed {seed}: regime {''.join(x[0] for x in ref.regime)} launch {ref.launch} export {ref.export} "
              f"brokers reliable {ref.broker_reliable} decay {ref.broker_decay} growth {ref.growth[0]} switch {ref.growth_switch}")
        row("reference", ref)
        for r in runs:
            if r["seed"] == seed and not r.get("harness_error"):
                row(r["run"], replay(seed, r["actions"]))
